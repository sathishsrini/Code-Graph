#!/usr/bin/env node
// ============================================================================
// code-intel CLI  —  task P0-T9 (skeleton; grows with each Phase 0 task)
// ============================================================================
// Node >= 22.6 executes this .ts file directly. No build step, no loader flag.
// ============================================================================

import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  loadConfig, repoByName, ConfigError, type RepoConfig,
} from "./config/repos.ts";
import { FactStore, SCHEMA_VERSION } from "./store/db.ts";
import {
  ScipProtobufReader, summarize, roleNames, syntaxKindLabel,
  ROLE_DEFINITION, hasRole,
} from "./static/scip/reader.ts";
import { displayNameOf } from "./static/scip/symbol.ts";
import { deriveCalls, dedupe, createFsSourceProvider } from "./derive/calls.ts";
import { readBootDump, findRoute } from "./boot/dump.ts";
import { readFastapiDump, toBootDump } from "./boot/fastapi.ts";
import { buildFlow, renderFlow } from "./query/flow.ts";
import { endpointFlow, RouteNotFound } from "./query/endpoint-flow.ts";
import { renderEndpointFlow } from "./query/endpoint-flow-render.ts";
import { impact, SeedNotFound } from "./query/impact.ts";
import { renderImpact } from "./query/impact-render.ts";
import { securityPath } from "./query/security.ts";
import { renderSecurity, renderRouteSecurity } from "./query/security-render.ts";
import { contextPack, packToToon, measureTokenDelta } from "./query/context-pack.ts";
import { startMcpServer } from "./mcp/server.ts";
import { flowToMermaid } from "./serializers/mermaid.ts";
import { startReceiver } from "./runtime/receiver.ts";
import { promote, possiblyDeadEdges } from "./runtime/promote.ts";
import { errorPaths } from "./query/errors.ts";
import { renderErrorReport } from "./query/errors-render.ts";
import {
  runScipTypescript, runScipPython, documentAllowed,
} from "./static/scip/runner.ts";
import { scanRepo, renderScan } from "./static/treesitter/report.ts";
import { indexRepo, linkCrossServiceRepos, type IndexReport } from "./index/pipeline.ts";
import { renderIndexReport } from "./index/report.ts";

const BREAK = String.fromCharCode(10);
const DEFAULT_DB = ".codeintel/graph.db";
const DEFAULT_CONFIG = "config/repos.json";

const USAGE = `code-intel — architecture-aware code intelligence engine

USAGE
  node src/cli.ts <command> [options]

COMMANDS
  db bootstrap        Create or verify the SQLite fact store
  config check        Validate config/repos.json and print the resolved repos
  scip dump           Summarise a .scip index and sample its symbols
  derive calls        Derive CALLS edges from a .scip index (P0-T6)
  scip index          Run scip-typescript over a repo's declared file set (P0-T3)
  boot dump           Boot a service and read its routes + hook chains (P0-T8)
  flow                Ordered chain + call tree for one endpoint (P1-T12)
  scan                tree-sitter pass: throws, http, datastores, config (P1-T6)
  index               Index every repo into the fact store, incrementally (P1-T11)
  impact <symbol>     What breaks if this changes — reverse closure (P1-T13)
  security            Coverage matrix + the writes-without-tenant anomaly (P1-T14)
  context <symbol>    Minimum context to edit this function, budgeted (P1-T15)
  mcp                 Serve the four queries over MCP on stdio (P1-T16)
  otlp serve          Receive OTLP/HTTP traces into the spans table (P2-T8)
  promote             Confirm inferred edges against observed traces (P2-T9)
  errors              Observed / static / correlated failure analysis (P2-T10)
  help                Show this message

OPTIONS
  --db <path>         Database path            (default: ${DEFAULT_DB})
  --config <path>     Config path              (default: ${DEFAULT_CONFIG})
  --index <path>      scip dump: path to a .scip file
  --repo <name>       boot dump / scip index / flow: repo from config/repos.json
  --method <verb>     flow: HTTP method
  --path <url>        flow: route url as the framework reports it
  --depth <n>         flow: call tree depth cap    (default: 12)
  --out <path>        boot dump: where to write the JSON artifact
  --sample <n>        scip dump: symbols to print   (default: 20)
  --artifacts         flow: read a .scip file + boot dump instead of the store
  --no-remote         flow: stop at the service boundary, do not follow REQUESTS
  --externals         flow: list every boundary call instead of summarising
  --mermaid           flow: emit a Mermaid diagram instead of a tree (P2-T6)
  --fan-in <n>        impact: callers above which a symbol is a utility (default 10)
  --limit <n>         impact: routes to list before trimming     (default 25)
  --budget <n>        context: token budget                      (default 4000)
  --no-source         context: omit tier-1 raw source
  --measure           context: also report the R71 token delta vs dumping files
  --port <n>          otlp serve: listen port                    (default 4318)
  --sample-rate <r>   otlp serve: fraction of non-errored traces kept (default 0.01)
  --dead-after <d>    promote: days without confirmation before "possibly dead"
  --anomaly <kind>    security: check kind whose absence over a write is flagged
                      (default: tenant)
  --force             index: re-run every derivation, ignoring the changed set
  --reset             db bootstrap: delete an existing database first
  --skip-path-check   config check: don't verify rootPath exists on disk
  --json              Machine-readable output

STATUS
  Phase 1 in progress. See plans/code-intelligence-engine-plan-v2.md for the
  plan and implementation/RECORD.md for what has actually shipped.
`;

interface Options {
  db: string;
  config: string;
  index: string;
  repo: string;
  method: string;
  path: string;
  depth: number;
  out: string;
  sample: number;
  reset: boolean;
  force: boolean;
  fromArtifacts: boolean;
  noRemote: boolean;
  externals: boolean;
  mermaid: boolean;
  fanIn: number | undefined;
  limit: number | undefined;
  anomaly: string;
  budget: number | undefined;
  noSource: boolean;
  measure: boolean;
  port: number | undefined;
  sampleRate: number | undefined;
  deadAfter: number | undefined;
  checkPaths: boolean;
  json: boolean;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        config: { type: "string" },
        index: { type: "string" },
        repo: { type: "string" },
        method: { type: "string" },
        path: { type: "string" },
        depth: { type: "string" },
        out: { type: "string" },
        sample: { type: "string" },
        reset: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        artifacts: { type: "boolean", default: false },
        "no-remote": { type: "boolean", default: false },
        externals: { type: "boolean", default: false },
        mermaid: { type: "boolean", default: false },
        "fan-in": { type: "string" },
        limit: { type: "string" },
        anomaly: { type: "string" },
        budget: { type: "string" },
        "no-source": { type: "boolean", default: false },
        measure: { type: "boolean", default: false },
        port: { type: "string" },
        "sample-rate": { type: "string" },
        "dead-after": { type: "string" },
        // node:util parseArgs has no "--no-x" negation, so this is stated
        // positively. The default remains "do check paths".
        "skip-path-check": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const options: Options = {
    db: values.db ?? DEFAULT_DB,
    config: values.config ?? DEFAULT_CONFIG,
    index: values.index ?? "",
    repo: values.repo ?? "",
    method: values.method ?? "",
    path: values.path ?? "",
    depth: values.depth ? Number(values.depth) : 12,
    out: values.out ?? "",
    sample: values.sample ? Number(values.sample) : 20,
    reset: values.reset === true,
    force: values.force === true,
    fromArtifacts: values.artifacts === true,
    noRemote: values["no-remote"] === true,
    externals: values.externals === true,
    mermaid: values.mermaid === true,
    fanIn: values["fan-in"] ? Number(values["fan-in"]) : undefined,
    limit: values.limit ? Number(values.limit) : undefined,
    anomaly: values.anomaly ?? "tenant",
    budget: values.budget ? Number(values.budget) : undefined,
    noSource: values["no-source"] === true,
    measure: values.measure === true,
    port: values.port ? Number(values.port) : undefined,
    sampleRate: values["sample-rate"] ? Number(values["sample-rate"]) : undefined,
    deadAfter: values["dead-after"] ? Number(values["dead-after"]) : undefined,
    checkPaths: values["skip-path-check"] !== true,
    json: values.json === true,
  };

  const command = positionals[0] ?? "";
  const sub = positionals[1] ?? "";

  if (values.help || command === "" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "db":
      if (sub !== "bootstrap") {
        process.stderr.write(`unknown subcommand: db ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdDbBootstrap(options);

    case "config":
      if (sub !== "check") {
        process.stderr.write(`unknown subcommand: config ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdConfigCheck(options);

    case "scip":
      if (sub === "dump") return cmdScipDump(options);
      if (sub === "index") return cmdScipIndex(options);
      process.stderr.write(`unknown subcommand: scip ${sub}\n\n${USAGE}`);
      return 2;

    case "boot":
      if (sub !== "dump") {
        process.stderr.write(`unknown subcommand: boot ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdBootDump(options);

    case "flow":
      return cmdFlow(options);

    case "scan":
      return await cmdScan(options);

    case "index":
      return await cmdIndex(options);

    case "impact":
      return cmdImpact(options, positionals[1] ?? "");

    case "security":
      return cmdSecurity(options);

    case "context":
      return cmdContext(options, positionals[1] ?? "");

    case "otlp":
      if (sub !== "serve") {
        process.stderr.write(`unknown subcommand: otlp ${sub}` + BREAK + BREAK + USAGE);
        return 2;
      }
      return await cmdOtlpServe(options);

    case "promote":
      return cmdPromote(options);

    case "errors":
      return cmdErrors(options);

    case "mcp":
      // Never returns: the transport owns the process until stdin closes.
      await startMcpServer(options.db);
      return 0;

    case "derive":
      if (sub !== "calls") {
        process.stderr.write(`unknown subcommand: derive ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdDeriveCalls(options);

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function cmdDbBootstrap(options: Options): number {
  const store = options.reset ? FactStore.reset(options.db) : new FactStore(options.db);
  try {
    const report = store.verifyIntegrity();

    if (options.json) {
      process.stdout.write(JSON.stringify(
        { path: store.path, version: SCHEMA_VERSION, migrations: store.migrations, ...report },
        null, 2) + "\n");
    } else {
      const m = store.migrations;
      const now = m.applied.length
        ? `, ${m.applied.length} applied now (${m.applied.join(", ")})`
        : "";
      process.stdout.write(
        `database   : ${store.path}\n` +
        `version    : ${SCHEMA_VERSION}\n` +
        `migrations : ${m.alreadyApplied.length} already applied${now}\n` +
        `schema     : ${report.tables} tables/views, ${report.indexes} indexes\n` +
        `foreign key: ${report.foreignKeyViolations === 0 ? "valid" : `${report.foreignKeyViolations} VIOLATION(S)`}\n` +
        `integrity  : ${report.integrityCheck}\n`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

function cmdConfigCheck(options: Options): number {
  try {
    const config = loadConfig(options.config, { checkPaths: options.checkPaths });

    if (options.json) {
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(`config: ${resolve(options.config)}\n`);
    process.stdout.write(`repos : ${config.repos.length}\n\n`);
    for (const r of config.repos) {
      const inc = r.include.length ? r.include.join(", ") : "(everything)";
      const exc = r.exclude.length ? r.exclude.join(", ") : "(nothing)";
      process.stdout.write(
        `  ${r.name}\n` +
        `    lang/framework : ${r.lang} / ${r.framework}\n` +
        `    root           : ${r.rootPath}\n` +
        `    entrypoint     : ${r.entrypoint || "(none)"}\n` +
        `    include        : ${inc}\n` +
        `    exclude        : ${exc}\n` +
        `    port           : ${r.port ?? "(unset)"}\n\n`,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function cmdScipDump(options: Options): number {
  if (!options.index) {
    process.stderr.write("scip dump requires --index <path to .scip>\n");
    return 2;
  }

  const reader = new ScipProtobufReader();
  const index = reader.read(options.index);
  const summary = summarize(index);

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `index      : ${resolve(options.index)}\n` +
    `tool       : ${summary.tool}\n` +
    `projectRoot: ${summary.projectRoot}\n` +
    `documents  : ${summary.documents}\n` +
    `symbols    : ${summary.symbols}\n` +
    `occurrences: ${summary.occurrences} (${summary.definitions} definitions, ` +
    `${summary.references} references)\n` +
    `external   : ${summary.externalSymbols}\n\n` +
    `field coverage (what this indexer actually populates):\n` +
    `  enclosingRange   : ${summary.occurrencesWithEnclosingRange} occurrences ` +
    `(${summary.multiLineEnclosingRanges} span >1 line)\n` +
    `  enclosingSymbol  : ${summary.symbolsWithEnclosingSymbol} / ${summary.symbols} symbols\n` +
    `  displayName      : ${summary.symbolsWithDisplayName} / ${summary.symbols}\n` +
    `  documentation    : ${summary.symbolsWithDocumentation} / ${summary.symbols}\n` +
    `  relationships    : ${summary.symbolsWithRelationships} / ${summary.symbols}\n\n`,
  );

  process.stdout.write("languages:\n");
  for (const l of summary.languages) {
    process.stdout.write(`  ${String(l.n).padStart(5)}  ${l.language || "(none)"}\n`);
  }

  process.stdout.write("\nsymbol roles (occurrences may carry several):\n");
  for (const r of summary.roles) {
    process.stdout.write(`  ${String(r.n).padStart(5)}  ${r.role}\n`);
  }

  // The distribution that P0-T6's CALLS filters will be chosen from. Printed
  // because the SyntaxKind numbering has shifted between SCIP versions and
  // guessing it would silently drop real call edges.
  process.stdout.write("\nsyntax kinds:\n");
  for (const k of summary.syntaxKinds) {
    process.stdout.write(
      `  ${String(k.n).padStart(5)}  ${String(k.kind).padStart(3)}  ${k.label}\n`,
    );
  }

  // Eyeball sample — the P0-T4 acceptance criterion.
  process.stdout.write(`\nsample of ${options.sample} definitions:\n`);
  let shown = 0;
  outer: for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (!hasRole(occ.symbolRoles, ROLE_DEFINITION)) continue;
      const info = doc.symbols.find((s) => s.symbol === occ.symbol);
      const body = occ.enclosingRange
        ? `L${occ.enclosingRange.startLine + 1}-${occ.enclosingRange.endLine + 1}`
        : `L${occ.range.startLine + 1}`;
      process.stdout.write(
        `\n  ${doc.relativePath}:${body}  [${syntaxKindLabel(occ.syntaxKind)}]` +
        `  roles=${roleNames(occ.symbolRoles).join("|") || "none"}\n` +
        `    name  : ${info?.displayName || "(no displayName)"}\n` +
        `    symbol: ${occ.symbol}\n`,
      );
      shown += 1;
      if (shown >= options.sample) break outer;
    }
  }

  return 0;
}

/**
 * Boot a service and read back its routes and ordered hook chains (P0-T8).
 *
 * The adapter runs as a CHILD PROCESS on purpose. It requires and boots a
 * foreign application: that app can throw, hang, open handles or call
 * process.exit, and none of that should be able to take the CLI with it.
 */
/**
 * Resolve one repo from config, or explain precisely why not.
 *
 * Shared by every repo-scoped command so the failure text is identical
 * wherever it comes from.
 */
function resolveRepo(options: Options): RepoConfig | number {
  if (!options.repo) {
    process.stderr.write("this command requires --repo <name from config/repos.json>\n");
    return 2;
  }
  let config;
  try {
    config = loadConfig(options.config, { checkPaths: options.checkPaths });
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const repo = repoByName(config, options.repo);
  if (!repo) {
    process.stderr.write(`no repo named "${options.repo}" in ${options.config}\n`);
    return 1;
  }
  return repo;
}

function defaultIndexPath(repo: RepoConfig): string {
  return join(".codeintel", "scip", `${repo.name}.scip`);
}

/**
 * Run the SCIP indexer over exactly the repo's declared file set (P0-T3).
 *
 * The generated tsconfig is the whole point: without it `40-kri-router` indexes
 * its dead `src/` scaffold and none of the live `server.js`, which yields a
 * confident graph of a system that does not run (docs/measurements.md M7).
 */
function cmdScipIndex(options: Options): number {
  const repo = resolveRepo(options);
  if (typeof repo === "number") return repo;

  const out = options.out || defaultIndexPath(repo);
  const result = repo.lang === "py"
    ? runScipPython(repo, out)
    : runScipTypescript(repo, out, { maxOldSpaceMb: 8192 });

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  process.stdout.write(
    `repo       : ${repo.name}\n` +
    `root       : ${repo.rootPath}\n` +
    `include    : ${repo.include.join(", ") || "(everything)"}\n` +
    `exclude    : ${repo.exclude.join(", ") || "(nothing)"}\n` +
    `indexer    : ${repo.lang === "py" ? "scip-python" : "scip-typescript"}\n` +
    `file set   : ${repo.lang === "py"
      ? "enforced at ingest — this indexer takes no config"
      : "generated tsconfig, then removed"}\n` +
    `output     : ${result.outputPath}\n` +
    `duration   : ${result.durationMs} ms\n`,
  );
  if (!result.ok) {
    // An indexer can exit 0 and still write an index describing nothing —
    // `scip-python` does exactly that on Windows (measurements M8). Reporting
    // the exit code alone would call that a success.
    const empty = result.status === 0 && existsSync(result.outputPath);
    process.stderr.write(
      `\nscip index FAILED (status ${result.status}${empty ? ", but wrote an EMPTY index" : ""})\n` +
      `${result.stderr || result.stdout}\n`,
    );
    return 1;
  }
  process.stdout.write(`status     : ok\n`);
  return 0;
}

/**
 * endpoint_flow for one route.
 *
 * Two implementations, deliberately both kept:
 *
 *   default   P1-T12, from the store. Every indexed service at once, so an
 *             outbound call crosses into the remote route's own chain.
 *   --artifacts  P0-T9, straight from one .scip file and one boot dump. It is
 *             the Phase 0 gate and the only way to check a service's flow
 *             WITHOUT trusting the store — which is what you want when the
 *             question is whether the store is right.
 */
function cmdFlow(options: Options): number {
  if (!options.fromArtifacts) return cmdFlowFromStore(options);

  const repo = resolveRepo(options);
  if (typeof repo === "number") return repo;
  if (!options.method || !options.path) {
    process.stderr.write("flow requires --method <verb> and --path <url>\n");
    return 2;
  }

  const bootPath = resolve(join(".codeintel", "boot", `${repo.name}.json`));
  const indexPath = resolve(options.index || defaultIndexPath(repo));
  for (const [what, p, how] of [
    ["boot dump", bootPath, `node src/cli.ts boot dump --repo ${repo.name}`],
    ["scip index", indexPath, `node src/cli.ts scip index --repo ${repo.name}`],
  ] as const) {
    if (!existsSync(p)) {
      process.stderr.write(`flow: no ${what} at ${p}\n  build it with: ${how}\n`);
      return 1;
    }
  }

  const dump = readBootDump(bootPath);
  const route = findRoute(dump, options.method, options.path);
  if (!route) {
    process.stderr.write(
      `flow: ${dump.service} has no route ${options.method.toUpperCase()} ${options.path}\n` +
      `  known routes:\n` +
      dump.routes.map((r) => `    ${r.method} ${r.url}`).join("\n") + "\n",
    );
    return 1;
  }

  const index = new ScipProtobufReader().read(indexPath);
  const { calls, unresolved, stats } = deriveCalls(index, {
    allowDocument: (rel) => documentAllowed(repo, rel),
  });
  const flow = buildFlow(dump, route, dedupe(calls), index, {
    maxDepth: options.depth,
    localPackages: new Set([repo.name, repo.serviceName]),
    unresolved,
    // Needed to bound anonymous hooks, which have no SCIP definition of their
    // own and would otherwise root their call tree at the whole module.
    sources: createFsSourceProvider(index.projectRoot || repo.rootPath),
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(flow, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderFlow(flow));
  if (stats.skippedDocuments.length > 0) {
    process.stdout.write(
      `  ${stats.skippedDocuments.length} document(s) in the index are outside ` +
      `the declared file set and were ignored:\n` +
      stats.skippedDocuments.map((d) => `    ${d}`).join("\n") + "\n",
    );
  }
  return 0;
}

/**
 * endpoint_flow from the fact store (P1-T12).
 *
 * `--repo` names a service here rather than selecting artifacts, because the
 * store holds every service and the flow may leave the one it started in.
 */
function cmdFlowFromStore(options: Options): number {
  if (!options.repo || !options.method || !options.path) {
    process.stderr.write(
      "flow requires --repo <service> --method <verb> --path <url>\n" +
      "  add --artifacts to read a .scip file and boot dump directly (P0-T9)\n",
    );
    return 2;
  }

  const store = new FactStore(options.db);
  try {
    const flow = endpointFlow(store, options.repo, options.method, options.path, {
      maxDepth: options.depth,
      followRemote: !options.noRemote,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(flow, null, 2)}\n`
        : options.mermaid
          // R46: ~20 lines that render in a PR comment, read by people who
          // will never open a UI.
          ? `${flowToMermaid(flow, { externals: options.externals })}\n`
          : renderEndpointFlow(flow, "", { externals: options.externals }),
    );
    return 0;
  } catch (e) {
    if (e instanceof RouteNotFound) {
      process.stderr.write(
        `flow: ${e.message}\n` +
        (e.candidates.length === 0
          ? `  service "${options.repo}" has no routes in the store — run: node src/cli.ts index\n`
          : `  known routes:\n${e.candidates.map((c) => `    ${c.method} ${c.url}`).join("\n")}\n`),
      );
      return 1;
    }
    throw e;
  } finally {
    store.close();
  }
}

/**
 * impact — what breaks if this symbol changes (P1-T13).
 *
 * The seed may be a verbatim SCIP symbol or a bare display name. An ambiguous
 * name is refused rather than resolved: answering about the wrong `handler`
 * with nothing in the output saying so is the failure this whole project is
 * about.
 */
function cmdImpact(options: Options, seed: string): number {
  if (!seed) {
    process.stderr.write("impact requires a symbol: node src/cli.ts impact <name>\n");
    return 2;
  }
  const store = new FactStore(options.db);
  try {
    const report = impact(store, seed, {
      maxDepth: options.depth,
      utilityFanIn: options.fanIn,
      routeLimit: options.limit,
    });
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : renderImpact(report),
    );
    return 0;
  } catch (e) {
    if (e instanceof SeedNotFound) {
      process.stderr.write(`impact: ${e.message}\n`);
      for (const m of e.matches) process.stderr.write(`  ${m.display}  ${m.key}\n`);
      return 1;
    }
    throw e;
  } finally {
    store.close();
  }
}

/**

 * security — the coverage matrix and R40's anomaly query (P1-T14).
 *
 * With --method/--path it prints one route's ordered security chain instead,
 * which is the doc's highest value-per-hour view.
 */
function cmdSecurity(options: Options): number {
  const store = new FactStore(options.db);
  try {
    const report = securityPath(store, {
      service: options.repo || undefined,
      anomalyKind: options.anomaly,
      maxDepth: options.depth,
    });

    if (options.method && options.path) {
      const one = report.routes.find(
        (r) => r.method === options.method.toUpperCase() && r.url === options.path,
      );
      if (!one) {
        process.stderr.write(`security: no route ${options.method} ${options.path}` + BREAK);
        return 1;
      }
      process.stdout.write(
        options.json ? JSON.stringify(one, null, 2) + BREAK : renderRouteSecurity(one),
      );
      return 0;
    }

    process.stdout.write(
      options.json
        ? JSON.stringify(report, null, 2) + BREAK
        : renderSecurity(report, options.anomaly),
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * context — the minimum context to edit a function (P1-T15).
 *
 * `--measure` prints R71's number: the pack against dumping every file it
 * touches, which is what an agent does when it has no graph.
 */
function cmdContext(options: Options, seed: string): number {
  if (!seed) {
    process.stderr.write("context requires a symbol: node src/cli.ts context <name>" + BREAK);
    return 2;
  }
  const store = new FactStore(options.db);
  try {
    const pack = contextPack(store, seed, {
      budget: options.budget,
      includeSource: !options.noSource,
    });

    if (options.json) {
      const body = options.measure
        ? { ...pack, delta: measureTokenDelta(store, pack) }
        : pack;
      process.stdout.write(JSON.stringify(body, null, 2) + BREAK);
      return 0;
    }

    process.stdout.write(packToToon(pack));
    if (options.measure) {
      const d = measureTokenDelta(store, pack);
      process.stdout.write(
        BREAK +
        "R71 TOKEN DELTA" + BREAK +
        `  pack        : ${d.packTokens} tokens` + BREAK +
        `  file dump   : ${d.dumpTokens} tokens across ${d.files} file(s)` + BREAK +
        `  ratio       : ${(d.ratio * 100).toFixed(1)}% of dumping the files` + BREAK,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof SeedNotFound) {
      process.stderr.write(`context: ${e.message}` + BREAK);
      for (const m of e.matches) process.stderr.write(`  ${m.display}  ${m.key}` + BREAK);
      return 1;
    }
    throw e;
  } finally {
    store.close();
  }
}

/**
 * errors — the three-section failure analysis (P2-T10).
 *
 * The sections are computed by two independent passes and are never merged
 * (R41). A single verdict would overstate the observed by adding
 * possibilities, and understate the static by weighting on traffic.
 */
function cmdErrors(options: Options): number {
  if (!options.repo || !options.method || !options.path) {
    process.stderr.write(
      "errors requires --repo <service> --method <verb> --path <url>" + BREAK,
    );
    return 2;
  }
  const store = new FactStore(options.db);
  try {
    const report = errorPaths(store, options.repo, options.method, options.path, {
      maxDepth: options.depth,
    });
    process.stdout.write(
      options.json
        ? JSON.stringify(report, null, 2) + BREAK
        : renderErrorReport(report),
    );
    return 0;
  } catch (e) {
    process.stderr.write(`errors: ${(e as Error).message}` + BREAK);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * otlp serve — the runtime channel's ingress (P2-T8).
 *
 * Runs until interrupted. On shutdown it decides every buffered trace rather
 * than dropping it: a trace whose root had not yet arrived is exactly the kind
 * most likely to be the errored one.
 */
async function cmdOtlpServe(options: Options): Promise<number> {
  const store = new FactStore(options.db);
  const receiver = await startReceiver(store, {
    port: options.port,
    successRate: options.sampleRate,
  });

  process.stdout.write(
    `otlp receiver: http://127.0.0.1:${receiver.port}/v1/traces` + BREAK +
    `sampling     : 100% of errored traces, ` +
    `${((options.sampleRate ?? 0.01) * 100).toFixed(1)}% of the rest (R53)` + BREAK +
    `database     : ${store.path}` + BREAK +
    `point an exporter at it with OTEL_EXPORTER_OTLP_PROTOCOL=http/json` + BREAK +
    `Ctrl-C to flush buffered traces and stop.` + BREAK,
  );

  await new Promise<void>((resolveDone) => {
    const stop = () => {
      void receiver.close().then(({ flushed }) => {
        const s = receiver.stats();
        process.stdout.write(
          BREAK + `received ${s.received} spans, kept ${s.kept}` +
          `${flushed > 0 ? ` (${flushed} flushed on shutdown)` : ""}` + BREAK,
        );
        resolveDone();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  store.close();
  return 0;
}

/**
 * promote — confirm inferred edges against what traces observed (P2-T9).
 *
 * Never deletes. R56 is absolute: runtime upgrades or adds, and an edge no
 * trace covered is reported as "possibly dead", which is a weaker and truer
 * claim than "dead".
 */
function cmdPromote(options: Options): number {
  const store = new FactStore(options.db);
  try {
    const ports = new Map<number, string>();
    try {
      for (const repo of loadConfig(options.config, { checkPaths: false }).repos) {
        if (repo.port !== null) ports.set(repo.port, repo.serviceName);
      }
    } catch {
      // No config is not fatal here: address-names-the-service still resolves,
      // and the loopback-plus-port path simply finds nothing.
    }

    const deadAfterDays = options.deadAfter ?? 30;
    const report = promote(store, { deadAfterDays, servicePorts: ports });

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + BREAK);
      return 0;
    }

    const spans = store.countRows("spans");
    process.stdout.write(
      `spans in store : ${spans}` + BREAK + BREAK +
      `MATCHED  (R54 join keys)` + BREAK +
      `  routes       : ${report.matchedRoutes}` + BREAK +
      `  symbols      : ${report.matchedSymbols}` + BREAK +
      `  datastores   : ${report.matchedDatastores}` + BREAK +
      `  unmatched    : ${report.unmatched}   ` +
      `(join keys that resolved to nothing — a gap, not a zero)` + BREAK + BREAK +
      `PROMOTED  (R56 — runtime never deletes a static edge)` + BREAK +
      `  inferred -> observed : ${report.promoted}` + BREAK +
      `  added as observed    : ${report.added}` + BREAK + BREAK +
      `POSSIBLY DEAD  (R57 — ${deadAfterDays}d without confirmation)` + BREAK +
      `  ${report.possiblyDead} static edge(s)` + BREAK,
    );

    if (report.possiblyDead > 0) {
      for (const e of possiblyDeadEdges(store, deadAfterDays, 10)) {
        process.stdout.write(
          `    ${e.type.padEnd(15)} ${displayNameOf(e.src)} -> ${displayNameOf(e.dst)}` +
          `   ${e.lastObserved ?? "never observed"}` + BREAK,
        );
      }
      process.stdout.write(
        BREAK +
        `  Read as 'no trace covered this', NEVER as 'this is dead'. With ` +
        `${spans} span(s)` + BREAK +
        `  in the store, absence of evidence here is mostly absence of traffic.` + BREAK,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * tree-sitter pass over a repo's declared file set (P1-T6).
 *
 * Enumeration goes through the same include/exclude the SCIP indexer uses.
 * Walking the whole tree instead would extract findings from `src/**` — the
 * non-compiling scaffold that never executes (measurements M7, delta D6).
 */
async function cmdScan(options: Options): Promise<number> {
  const repo = resolveRepo(options);
  if (typeof repo === "number") return repo;

  const result = await scanRepo(repo);
  process.stdout.write(
    options.json ? `${JSON.stringify(result, null, 2)}\n` : renderScan(result),
  );
  return 0;
}

/**
 * Index every configured repo, or one with `--repo` (P1-T11).
 *
 * Incremental by content hash. Re-running with nothing changed does no work
 * and says so; `--force` re-runs every derivation. Artifacts (`.scip`, boot
 * JSON) are produced by `scip index` and `boot dump` and are read, not built,
 * here — indexing a service must not require booting it.
 */
async function cmdIndex(options: Options): Promise<number> {
  let config;
  try {
    config = loadConfig(options.config, { checkPaths: options.checkPaths });
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const repos = options.repo
    ? config.repos.filter((r) => r.name === options.repo)
    : config.repos;
  if (repos.length === 0) {
    process.stderr.write(`no repo named "${options.repo}" in ${options.config}\n`);
    return 1;
  }

  const store = new FactStore(options.db);
  try {
    const reports: IndexReport[] = [];
    for (const repo of repos) {
      reports.push(await indexRepo({
        store, repo,
        artifactDir: resolve(".codeintel"),
        force: options.force,
      }));
    }

    const shouldLink = options.force || reports.some((report) => !report.skipped);
    const crossService = shouldLink
      ? await linkCrossServiceRepos({ store, repos: config.repos, artifactDir: resolve(".codeintel") })
      : { repos: 0, files: 0, requests: 0, unresolved: 0 };

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ reports, crossService }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`database: ${store.path}\n\n`);
    process.stdout.write(renderIndexReport(reports));
    process.stdout.write(
      `cross-service: ${crossService.requests} REQUESTS, ` +
      `${crossService.unresolved} unresolved across ${crossService.files} files\n`,
    );

    const integrity = store.verifyIntegrity();
    process.stdout.write(
      `foreign key: ${integrity.foreignKeyViolations === 0 ? "valid" : "VIOLATIONS"}\n` +
      `integrity  : ${integrity.integrityCheck}\n`,
    );
    return integrity.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

function cmdBootDump(options: Options): number {
  if (!options.repo) {
    process.stderr.write("boot dump requires --repo <name from config/repos.json>\n");
    return 2;
  }

  let repo;
  try {
    repo = repoByName(loadConfig(options.config, { checkPaths: options.checkPaths }), options.repo);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  if (!repo) {
    process.stderr.write(`no repo named "${options.repo}" in ${options.config}\n`);
    return 1;
  }
  if (repo.framework !== "fastify" && repo.framework !== "fastapi") {
    // Next.js route extraction is descoped by decision (plan P1-T5), so there
    // is deliberately no adapter. Say which one is missing rather than
    // emitting an empty dump, which reads as "this service has no routes".
    process.stderr.write(
      `boot dump: no adapter for framework "${repo.framework}" (repo ${repo.name}). ` +
      `Fastify and FastAPI only.\n`,
    );
    return 2;
  }
  if (!repo.entrypoint) {
    process.stderr.write(`boot dump: repo ${repo.name} declares no entrypoint\n`);
    return 2;
  }

  const out = options.out || join(".codeintel", "boot", `${repo.name}.json`);
  const python = repo.framework === "fastapi";

  // Both adapters run as a CHILD PROCESS on purpose: they import and boot a
  // foreign application, which can throw, hang, open handles or call exit,
  // and none of that should be able to take the CLI with it.
  const adapter = resolve(
    import.meta.dirname,
    python ? "../adapters/fastapi/boot_dump.py" : "../adapters/fastify/boot-dump.cjs",
  );
  // OPEN-5: the indexing/boot interpreter is declared, not discovered. It does
  // not have to match the one the service runs in production.
  const runner = python ? (repo.pythonBin || "python") : process.execPath;
  const result = spawnSync(runner, [
    adapter,
    "--entry", join(repo.rootPath, repo.entrypoint),
    "--cwd", repo.rootPath,
    "--service", repo.serviceName,
    "--out", resolve(out),
  ], { encoding: "utf8", timeout: 120_000 });

  if (result.error) {
    process.stderr.write(`boot dump: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "boot dump: adapter failed\n");
    return result.status ?? 1;
  }

  // One shape downstream. The frameworks differ — Fastify hooks are per-route
  // and inheritable, Starlette middleware is app-wide — and `src/boot/fastapi.ts`
  // preserves that difference in `origin` and `inheritedFrom` rather than
  // flattening it into "hooks".
  const dump = python
    ? toBootDump(readFastapiDump(resolve(out)))
    : readBootDump(resolve(out));
  if (options.json) {
    process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `service    : ${dump.service}
` +
    `entrypoint : ${dump.entrypoint}
` +
    `framework  : ${dump.tool.fastify ? `fastify ${dump.tool.fastify}` : dump.tool.adapter}
` +
    `artifact   : ${resolve(out)}

` +
    `routes     : ${dump.stats.routes}
` +
    `chain rows : ${dump.stats.chainEntries}
` +
    `  anonymous: ${dump.stats.anonymousChainEntries} ` +
    `(located by file:line, not by name)
` +
    `  unlocated: ${dump.stats.unlocatedChainEntries}` +
    `${dump.stats.unlocatedChainEntries > 0 ? "   <-- GAP" : ""}
\n`,
  );

  for (const w of dump.warnings) process.stdout.write(`warning: ${w}\n`);
  if (dump.warnings.length) process.stdout.write("\n");

  for (const route of dump.routes) {
    process.stdout.write(`${route.method} ${route.url}\n`);
    for (const c of route.chain) {
      const label = c.name ?? "(anonymous)";
      const from = c.inheritedFrom ? `  inherited from ${c.inheritedFrom}` : "";
      const fw = c.origin === "framework" ? "  [framework]" : "";
      process.stdout.write(
        `  ${String(c.position).padStart(2)}. ${c.phase.padEnd(11)}` +
        `${label.padEnd(24)}${c.key}${fw}${from}\n`,
      );
    }
    process.stdout.write("\n");
  }

  return 0;
}

function cmdDeriveCalls(options: Options): number {
  if (!options.index) {
    process.stderr.write("derive calls requires --index <path to .scip>\n");
    return 2;
  }

  const index = new ScipProtobufReader().read(options.index);
  const { calls, stats } = deriveCalls(index);
  const unique = dedupe(calls);

  if (options.json) {
    process.stdout.write(JSON.stringify({ stats, calls: unique }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `index      : ${resolve(options.index)}\n` +
    `documents  : ${stats.documents}\n` +
    `occurrences: ${stats.occurrences} (${stats.definitions} defs, ${stats.references} refs)\n` +
    `bodies     : ${stats.bodies}   (definitions with an enclosingRange)\n\n` +
    `CALLS emitted : ${stats.emitted}  (${unique.length} unique)\n` +
    `  certain     : ${stats.certain}\n` +
    `  inferred    : ${stats.inferred}\n` +
    `  module scope: ${stats.fromModuleScope}  (caller is a module, not a function)\n\n` +
    `skipped references:\n`,
  );
  const skippedRows = Object.entries(stats.skipped).sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of skippedRows) {
    process.stdout.write(`  ${String(n).padStart(5)}  ${reason}\n`);
  }
  const totalSkipped = skippedRows.reduce((s, [, n]) => s + n, 0);
  process.stdout.write(`  ${String(totalSkipped).padStart(5)}  TOTAL\n`);

  // Sample for the P0-T7 manual verification.
  const limit = options.sample;
  if (limit > 0) {
    process.stdout.write(`\nsample of ${Math.min(limit, unique.length)} CALLS edges:\n`);
    const step = Math.max(1, Math.floor(unique.length / limit));
    let shown = 0;
    for (let i = 0; i < unique.length && shown < limit; i += step) {
      const c = unique[i]!;
      process.stdout.write(
        `\n  ${c.filePath}:${c.line}  [${c.confidence}]` +
        `${c.fromModuleScope ? " (module scope)" : ""}\n` +
        `    ${displayNameOf(c.srcSymbol)}  ->  ${displayNameOf(c.dstSymbol)}\n` +
        `    src: ${c.srcSymbol}\n` +
        `    dst: ${c.dstSymbol}\n`,
      );
      shown += 1;
    }
  }

  return 0;
}

// Top-level await: the tree-sitter grammars load asynchronously, so `main` is
// async from P1-T6 onward. Every command's exit code still comes back here.
process.exitCode = await main(process.argv.slice(2));
