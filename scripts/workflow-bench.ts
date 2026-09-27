// ============================================================================
// Workflow token benchmark — what does an agent pay to answer a workflow
// question from code-intel instead of reading the files?
// ============================================================================
// Ported from CodeGraph's `scripts/workflow_bench.py` (commit c3b3b63). For
// every question in the golden file this drives code-intel's own MCP server
// over stdio, runs the question's fixed tool plan, and scores the responses
// programmatically — no AI assessment. The scoring lives in
// `workflow-bench-score.ts` and is pinned by `tests/workflow-bench.test.ts`.
//
// The golden (questions, facts, edges) is kept byte-for-byte from the original
// fixture. What is code-intel-specific — how the fixture splits into services,
// and each codegraph_* plan remapped to code-intel's four tools — lives beside
// it in `orders_app.plans.json`.
//
// Isolation: the fixture is copied to a throwaway temp dir, and every CLI step
// runs with that dir as its cwd and an explicit `--db` inside it, so the
// user's real `.codeintel/` is never read or written.
//
// Acquisition is run through the real CLI, channel by channel, and each
// channel's failure is reported with its error output rather than hidden: a
// question answered badly because an indexer did not run is a different fact
// from one answered badly by the query layer.
//
// CTX-S2 (goal G5) adds a corpus mode and a gate:
//
//   --corpus   Query the graph already built from the real config/repos.json
//              (`--db`, default .codeintel/graph.db) instead of copying a
//              fixture and re-indexing. Nothing is written. "Reading the
//              files" is the golden's line ranges read from the corpus files
//              on disk, each resolved through its repo's rootPath.
//   --gate     Exit 1 when, for any question, graph + still-to-read is not
//              below reading the files, or a required fact is missing. The
//              verdict is `gate()` in the scoring module; each failing
//              question is printed with the condition it failed.
//
// A plan step marked `requires: CTX-Sn` names a tool that slice adds; it runs
// when the server lists the tool and is otherwise printed as skipped.
//
//   node scripts/workflow-bench.ts [--golden PATH] [--plans PATH] [--json OUT] [--keep] [--gate] [-v]
//   node scripts/workflow-bench.ts --corpus [--db PATH] [--config PATH] [--golden PATH] [--plans PATH]
//                                  [--json OUT] [--gate] [-v]
// ============================================================================

import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  corpusPath, edgeKey, edgesIn, formatGate, formatReport, gate, readCost, readRangesCost, scoreQuestion,
  searchable, shorten, utf8Bytes, workspaceVariants,
  type Golden, type GateVerdict, type LineRange, type QuestionResult, type RepoRoot, type StepRecord,
} from "./workflow-bench-score.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "src", "cli.ts");
const FIXTURES = join(REPO, "tests", "fixtures");
const DEFAULT_GOLDEN = join(FIXTURES, "orders_app.golden.json");
const CORPUS_GOLDEN = join(FIXTURES, "corpus.golden.json");
/** The CLI's own default store, relative to the repo root. */
const DEFAULT_DB = join(REPO, ".codeintel", "graph.db");

interface ServiceSpec {
  name: string;
  root: string;
  lang: "ts" | "js" | "py";
  framework: "fastify" | "fastapi" | "nextjs" | "none";
  entrypoint: string;
  include: string[];
  exclude: string[];
  baseUrlEnvVars: string[];
}

interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  from: string;
  /** The slice that adds `tool` (CTX-S2). Absent: the tool exists today. */
  requires?: string;
}

interface Plans {
  /** Fixture mode only; corpus mode takes its repos from the config. */
  services: ServiceSpec[];
  not_indexed: Array<{ path: string; reason: string }>;
  plans: Record<string, { steps: PlanStep[]; unmapped: Array<{ from: string; reason: string }> }>;
}

interface ChannelRun {
  step: string;
  ok: boolean;
  status: number | null;
  ms: number;
  /** Tail of the failing command's output, verbatim. Empty on success. */
  error: string;
}

/** What the question loop needs from either mode. */
interface Workspace {
  /** Read cost of a golden file: only `ranges` when given, else all of it. */
  fileCost: (file: string, ranges?: readonly LineRange[]) => number;
  /** Spellings of local paths to shorten to ${ws} in responses. */
  variants: string[];
  roots: RepoRoot[];
  files: ReadonlySet<string>;
  /** False when the golden has no edge truth (corpus): edges are not scored. */
  scoreEdges: boolean;
}

// ---------------------------------------------------------------------------

function cli(args: string[], cwd: string, timeoutMs: number): {
  status: number | null; stdout: string; stderr: string; ms: number;
} {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
    ms: Date.now() - started,
  };
}

function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

/** Every workspace-relative file, forward slashes. */
function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/**
 * Index the workspace through the real CLI, one channel at a time:
 * SCIP per service, boot reflection per framework service, then `index`.
 */
function acquire(scratch: string, plans: Plans, verbose: boolean): {
  runs: ChannelRun[]; db: string; report: unknown;
} {
  const runs: ChannelRun[] = [];
  const db = join(scratch, "graph.db");
  const record = (step: string, r: ReturnType<typeof cli>): void => {
    const ok = r.status === 0;
    runs.push({ step, ok, status: r.status, ms: r.ms, error: ok ? "" : tail(r.stderr || r.stdout) });
    if (verbose) process.stdout.write(`  ${step.padEnd(34)} ${ok ? "ok" : `FAILED (${r.status})`}  ${r.ms} ms\n`);
  };

  for (const s of plans.services) {
    record(`scip index --repo ${s.name}`, cli(["scip", "index", "--config", "repos.json", "--repo", s.name], scratch, 600_000));
  }
  for (const s of plans.services) {
    if (s.framework !== "fastapi" && s.framework !== "fastify") continue;
    record(`boot dump --repo ${s.name}`, cli(["boot", "dump", "--config", "repos.json", "--repo", s.name], scratch, 180_000));
  }

  const index = cli(["index", "--config", "repos.json", "--db", db, "--force", "--json"], scratch, 600_000);
  record("index --force", index);
  let report: unknown = null;
  try { report = JSON.parse(index.stdout); } catch { /* reported by the run record */ }
  return { runs, db, report };
}

/**
 * Give each TS/JS service without a package.json a minimal one, in the temp
 * copy only. scip-typescript names a symbol's package after the nearest
 * enclosing package.json; with none in the service it walks up past the temp
 * dir (on a Windows dev box, into the user's home) and every symbol comes out
 * as that package — which code-intel then drops as non-local. A result that
 * depends on where the temp dir happens to sit is not a benchmark.
 */
function ensurePackageJson(workspace: string, plans: Plans): string[] {
  const notes: string[] = [];
  for (const s of plans.services) {
    if (s.lang !== "ts" && s.lang !== "js") continue;
    const path = join(workspace, s.root, "package.json");
    if (existsSync(path)) continue;
    writeFileSync(path, `${JSON.stringify({ name: s.name, version: "0.0.0", private: true })}\n`, "utf8");
    notes.push(`wrote ${s.root}/package.json (name "${s.name}") in the temp copy: the fixture has none`);
  }
  return notes;
}

function writeConfig(scratch: string, workspace: string, plans: Plans): void {
  const repos = plans.services.map((s) => ({
    name: s.name,
    rootPath: join(workspace, s.root).split("\\").join("/"),
    serviceName: s.name,
    lang: s.lang,
    framework: s.framework,
    entrypoint: s.entrypoint,
    include: s.include,
    exclude: s.exclude,
    baseUrlEnvVars: s.baseUrlEnvVars,
    port: null,
    tsconfig: null,
    pythonBin: null,
  }));
  writeFileSync(join(scratch, "repos.json"), `${JSON.stringify({ repos }, null, 2)}\n`, "utf8");
}

interface IndexSummary {
  repo: string;
  symbols: number;
  calls: number;
  unresolvedCalls: number;
  missingArtifacts: string[];
  boot: { routes: number } | null;
}

function renderAcquisition(runs: ChannelRun[], report: unknown, plans: Plans, notes: string[]): string {
  const out: string[] = ["acquisition (real CLI, temp store):"];
  for (const note of notes) out.push(`  note   ${note}`);
  for (const r of runs) {
    out.push(`  ${r.ok ? "ok    " : "FAILED"} ${r.step}  (${r.ms} ms)`);
    if (!r.ok) for (const line of r.error.split("\n")) out.push(`         | ${line}`);
  }
  const reports = (report as { reports?: IndexSummary[] } | null)?.reports ?? [];
  const cross = (report as { crossService?: { requests: number; unresolved: number } } | null)?.crossService;
  for (const r of reports) {
    out.push(
      `  indexed ${r.repo}: ${r.symbols} symbols, ${r.calls} CALLS, ${r.unresolvedCalls} unresolved, ` +
      `${r.boot ? `${r.boot.routes} routes` : "no routes"}` +
      `${r.missingArtifacts.length ? `  -- missing: ${r.missingArtifacts.map((m) => m.replace(/ \(.*\)$/, "")).join(", ")}` : ""}`,
    );
  }
  if (cross) out.push(`  cross-service: ${cross.requests} REQUESTS, ${cross.unresolved} unresolved`);
  for (const n of plans.not_indexed) out.push(`  not indexed: ${n.path} -- ${n.reason}`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Corpus mode (CTX-S2)
// ---------------------------------------------------------------------------

/**
 * The corpus side of the comparison: the config's repos, and a read cost for
 * every golden file on disk. Returns the problems instead when a file cannot
 * be found or a range runs outside it — a baseline computed around a missing
 * file would be a smaller number, not an honest one.
 */
function corpusWorkspace(golden: Golden, configPath: string): { ws: Workspace; repos: number } | { problems: string[] } {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as { repos?: Array<{ name: string; rootPath: string }> };
  const repos = raw.repos ?? [];
  const bytes = new Map<string, Uint8Array>();
  const problems: string[] = [];

  for (const q of golden.questions) {
    for (const f of q.facts ?? []) {
      const path = corpusPath(f.file, repos);
      if (!path) {
        problems.push(`${q.id}/${f.id}: ${f.file} names no repo in ${configPath}`);
        continue;
      }
      if (!bytes.has(f.file)) {
        if (!existsSync(path)) {
          problems.push(`${q.id}/${f.id}: ${path} not found`);
          continue;
        }
        bytes.set(f.file, readFileSync(path));
      }
      if (f.ranges) {
        try {
          readRangesCost(bytes.get(f.file)!, f.ranges);
        } catch (e) {
          problems.push(`${q.id}/${f.id}: ${f.file}: ${(e as Error).message}`);
        }
      }
    }
  }
  if (problems.length) return { problems };

  const variants = [...new Set(repos.flatMap((r) => workspaceVariants(r.rootPath)))]
    .sort((a, b) => b.length - a.length);
  return {
    repos: repos.length,
    ws: {
      fileCost: (file, ranges) => {
        const data = bytes.get(file);
        if (!data) throw new Error(`no corpus bytes for ${file}`);
        return ranges ? readRangesCost(data, ranges) : readCost(data);
      },
      variants,
      roots: repos.map((r) => ({ name: r.name, root: r.name })),
      files: new Set(bytes.keys()),
      scoreEdges: (golden.true_edges?.length ?? 0) > 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared: drive the MCP server, score, report, gate
// ---------------------------------------------------------------------------

async function connect(db: string, cwd: string, log: (chunk: string) => void): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI, "mcp", "--db", db], cwd, stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { log(chunk.toString("utf8")); });
  const client = new Client({ name: "workflow-bench", version: "1" });
  await client.connect(transport);
  return client;
}

async function runQuestions(
  client: Client, golden: Golden, plans: Plans, plansPath: string, ws: Workspace, verbose: boolean,
): Promise<{ results: QuestionResult[]; schemaBytes: number; skipped: string[] }> {
  // Compact JSON, UTF-8. The Python original's json.dumps escaped non-ASCII
  // (an em dash cost 6 bytes); UTF-8 is what actually crosses the wire.
  const schema = await client.listTools();
  const schemaBytes = utf8Bytes(JSON.stringify(schema));
  const available = new Set(schema.tools.map((t) => t.name));
  const trueEdges = new Set((golden.true_edges ?? []).map(([a, b]) => edgeKey([a, b])));

  const results: QuestionResult[] = [];
  const skipped: string[] = [];
  for (const question of golden.questions) {
    const plan = plans.plans[question.id];
    if (!plan) throw new Error(`no plan for question "${question.id}" in ${plansPath}`);
    if (verbose) process.stdout.write(`  ${question.id}\n`);

    const steps: StepRecord[] = [];
    const texts: string[] = [];
    const returned = new Set<string>();
    for (const step of plan.steps) {
      // A tool a later slice adds: run it once the server has it, never fake it.
      if (step.requires && !available.has(step.tool)) {
        skipped.push(`${question.id}: ${step.tool} -- requires ${step.requires}, not on this server yet`);
        continue;
      }
      const started = Date.now();
      let text: string;
      let isError: boolean;
      try {
        const r = await client.callTool({ name: step.tool, arguments: step.args }, undefined, { timeout: 180_000 });
        const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
        text = content.map((part) => part.text ?? "").join("\n");
        isError = r.isError === true;
      } catch (e) {
        text = `Error: ${(e as Error).message}`;
        isError = true;
      }
      const short = shorten(text, ws.variants);
      texts.push(searchable(text));
      if (ws.scoreEdges) {
        for (const edge of edgesIn(step.tool, text, ws.roots, ws.files)) returned.add(edgeKey(edge));
      }
      const a = step.args;
      steps.push({
        tool: step.tool,
        target: typeof a["symbol"] === "string" ? a["symbol"]
          : typeof a["path"] === "string" ? `${String(a["method"])} ${a["path"]}`
          : typeof a["phrase"] === "string" ? a["phrase"] : "",
        bytes: utf8Bytes(short),
        raw_bytes: utf8Bytes(text),
        error: isError,
        ms: Date.now() - started,
      });
      if (verbose) {
        const s = steps[steps.length - 1]!;
        process.stdout.write(
          `    ${s.tool.padEnd(22)} ${s.target.padEnd(42)} ${String(s.bytes).padStart(7)} B${s.error ? "  ERROR" : ""}\n`,
        );
      }
    }
    results.push(scoreQuestion({ question, steps, texts, returned, trueEdges, fileCost: ws.fileCost }));
  }
  return { results, schemaBytes, skipped };
}

/** Print the report, and the gate when asked. Returns the exit code. */
function finish(
  golden: Golden, plans: Plans, run: Awaited<ReturnType<typeof runQuestions>>,
  opts: { gate: boolean; json: string | undefined; extra: Record<string, unknown> },
): number {
  const server = `node src/cli.ts mcp (code-intel ${readVersion()})`;
  process.stdout.write(formatReport(run.results, run.schemaBytes, server));
  for (const q of golden.questions) {
    for (const u of plans.plans[q.id]?.unmapped ?? []) {
      process.stdout.write(`unmapped in ${q.id}: ${u.from} -- ${u.reason}\n`);
    }
  }
  for (const s of run.skipped) process.stdout.write(`skipped in ${s}\n`);

  let verdict: GateVerdict | null = null;
  if (opts.gate) {
    verdict = gate(run.results);
    process.stdout.write(`\n${formatGate(verdict)}`);
  }

  if (opts.json) {
    writeFileSync(resolve(opts.json), `${JSON.stringify({
      server, schema_bytes: run.schemaBytes, ...opts.extra, skipped: run.skipped,
      questions: run.results, ...(verdict ? { gate: verdict } : {}),
    }, null, 2)}\n`, "utf8");
  }
  return verdict && !verdict.pass ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      golden: { type: "string" },
      plans: { type: "string" },
      json: { type: "string" },
      keep: { type: "boolean", default: false },
      corpus: { type: "boolean", default: false },
      db: { type: "string" },
      config: { type: "string" },
      gate: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "node scripts/workflow-bench.ts [--golden PATH] [--plans PATH] [--json OUT] [--keep] [--gate] [-v]\n" +
      "node scripts/workflow-bench.ts --corpus [--db PATH] [--config PATH] [--golden PATH] [--plans PATH] [--json OUT] [--gate] [-v]\n" +
      "  --corpus  query the existing graph built from the real config (no re-index); default golden\n" +
      "            tests/fixtures/corpus.golden.json, default db .codeintel/graph.db\n" +
      "  --gate    exit 1 unless every question costs less than reading its files and has every fact\n",
    );
    return 0;
  }

  const goldenPath = resolve(values.golden ?? (values.corpus ? CORPUS_GOLDEN : DEFAULT_GOLDEN));
  const plansPath = resolve(values.plans ?? goldenPath.replace(/\.golden\.json$/, ".plans.json"));
  for (const p of [goldenPath, plansPath]) {
    if (!existsSync(p)) {
      process.stderr.write(`not found: ${p}\n`);
      return 1;
    }
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;
  const rawPlans = JSON.parse(readFileSync(plansPath, "utf8")) as Partial<Plans>;
  const plans: Plans = {
    services: rawPlans.services ?? [],
    not_indexed: rawPlans.not_indexed ?? [],
    plans: rawPlans.plans ?? {},
  };
  const opts = { gate: values.gate, json: values.json, verbose: values.verbose };
  return values.corpus
    ? runCorpus(golden, plans, plansPath, { ...opts, db: values.db, config: values.config })
    : runFixture(golden, plans, plansPath, { ...opts, keep: values.keep });
}

async function runFixture(
  golden: Golden, plans: Plans, plansPath: string,
  opts: { gate: boolean; json: string | undefined; verbose: boolean; keep: boolean },
): Promise<number> {
  if (!golden.fixture || plans.services.length === 0) {
    process.stderr.write("fixture mode needs a golden with `fixture` and a plans file with `services` (or pass --corpus)\n");
    return 1;
  }
  // The golden documents `fixture` as relative to the repo root.
  const fixture = resolve(REPO, golden.fixture);

  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "code-intel-bench-")));
  const workspace = join(scratch, "ws");
  cpSync(fixture, workspace, { recursive: true });
  const notes = ensurePackageJson(workspace, plans);
  writeConfig(scratch, workspace, plans);

  const ws: Workspace = {
    fileCost: (f) => readCost(readFileSync(join(workspace, f))),
    variants: workspaceVariants(workspace),
    roots: plans.services.map((s) => ({ name: s.name, root: s.root })),
    files: new Set(listFiles(fixture)),
    scoreEdges: true,
  };

  let client: Client | null = null;
  let serverLog = "";
  try {
    const { runs, db, report } = acquire(scratch, plans, opts.verbose);
    process.stdout.write(`\n${renderAcquisition(runs, report, plans, notes)}`);
    if (!existsSync(db)) {
      process.stderr.write("\nno store was written; nothing to query\n");
      return 1;
    }
    client = await connect(db, scratch, (chunk) => { serverLog += chunk; });
    const run = await runQuestions(client, golden, plans, plansPath, ws, opts.verbose);
    return finish(golden, plans, run, {
      gate: opts.gate, json: opts.json, extra: { mode: "fixture", notes, acquisition: runs, index: report },
    });
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (opts.keep) {
      writeFileSync(join(scratch, "server.log"), serverLog, "utf8");
      process.stdout.write(`kept: ${scratch}\n`);
    } else {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

async function runCorpus(
  golden: Golden, plans: Plans, plansPath: string,
  opts: { gate: boolean; json: string | undefined; verbose: boolean; db: string | undefined; config: string | undefined },
): Promise<number> {
  const db = opts.db ? resolve(opts.db) : DEFAULT_DB;
  const configPath = opts.config ? resolve(opts.config) : resolve(REPO, golden.corpus ?? "config/repos.json");
  if (!existsSync(configPath)) {
    process.stderr.write(`not found: ${configPath}\n`);
    return 1;
  }
  if (!existsSync(db)) {
    process.stderr.write(
      `no graph at ${db}\ncorpus mode queries an existing graph and never re-indexes: build it first ` +
      `(scip index, boot dump, index for every repo in ${configPath}), or pass --db\n`,
    );
    return 1;
  }
  const corpus = corpusWorkspace(golden, configPath);
  if ("problems" in corpus) {
    process.stderr.write(`cannot compute "reading the files" from the corpus:\n${corpus.problems.map((p) => `  ${p}`).join("\n")}\n`);
    return 1;
  }

  const header = [
    "corpus (existing graph, not re-indexed):",
    `  db      ${db}  (modified ${statSync(db).mtime.toISOString()})`,
    `  config  ${configPath}  (${corpus.repos} repos)`,
    ...plans.not_indexed.map((n) => `  not indexed: ${n.path} -- ${n.reason}`),
  ];
  process.stdout.write(`\n${header.join("\n")}\n`);

  let client: Client | null = null;
  try {
    client = await connect(db, REPO, () => undefined);
    const run = await runQuestions(client, golden, plans, plansPath, corpus.ws, opts.verbose);
    return finish(golden, plans, run, {
      gate: opts.gate, json: opts.json, extra: { mode: "corpus", db, config: configPath },
    });
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "?";
}

process.exitCode = await main();
