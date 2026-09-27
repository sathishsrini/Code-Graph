// ============================================================================
// Workflow token benchmark — the pure scoring half
// ============================================================================
// Ported from CodeGraph's `scripts/workflow_bench.py` (commit c3b3b63). The
// semantics are kept exactly, because the point of a benchmark is that its
// numbers mean the same thing on every run:
//
//   graph bytes     bytes of the tool responses, with the workspace path
//                   shortened to ${ws} so numbers compare across machines
//   facts           golden facts whose evidence appears verbatim in a response
//   fallback bytes  files still to Read for the facts the graph did not give,
//                   counted with the Read tool's 7-byte line-number gutter
//   baseline bytes  reading every file that holds a fact, same accounting
//   edges           caller/callee edges in the responses, scored against the
//                   golden edge list (precision) and the question's expected
//                   edges (recall)
//   tokens          bytes / 4, rounded half-to-even like Python's round()
//
// What changed is only the response shape. CodeGraph answered in JSON with
// absolute paths; code-intel answers in TOON with repo-relative paths, so the
// edge extraction reads TOON tables and maps each path back to the workspace.
// No I/O lives here — the driver (workflow-bench.ts) owns the process and the
// file system, so everything below is testable with strings.
//
// CTX-S2 (goal G5) adds two things, and changes nothing the fixture bench
// already measured:
//
//   line ranges     a fact may carry the 1-based line ranges that answer it.
//                   They are validated against the file and reported as the
//                   "cited lines" figure, for information. The gate charges
//                   WHOLE files for both reading-the-files and still-to-read
//                   (owner decision, 2026-09-27): without the graph Claude
//                   reads the files, and a fact the graph missed sends it to
//                   the file, not to lines it has no way to know. orders_app
//                   has no ranges, so its numbers and report are unchanged.
//   the gate        G5's per-question test as a pure verdict: graph +
//                   still-to-read must be strictly below reading the files,
//                   AND no required fact may be missing. Any one failing
//                   question fails the run.
// ============================================================================

/** `"     1\t"` per line in the Read tool's output. */
export const READ_GUTTER_BYTES = 7;
export const BYTES_PER_TOKEN = 4;

/** 1-based, inclusive: `[start, end]`. */
export type LineRange = readonly [number, number];

export interface Fact {
  id: string;
  file: string;
  line: number;
  evidence: string;
  /** Lines of `file` that answer the fact (CTX-S2). Absent: the whole file. */
  ranges?: LineRange[];
}

export interface GoldenQuestion {
  id: string;
  question: string;
  /** What kind of question this is (corpus golden only). Not scored. */
  kind?: string;
  facts?: Fact[];
  expected_edges?: Array<[string, string]>;
}

export interface Golden {
  /** Fixture mode: the fixture directory, relative to the repo root. */
  fixture?: string;
  /** Corpus mode: the config whose repos the fact files live in (CTX-S2). */
  corpus?: string;
  description?: string;
  questions: GoldenQuestion[];
  /** Absent or empty: there is no edge truth, and edges are not scored. */
  true_edges?: Array<[string, string, string]>;
}

/** One service code-intel indexes, rooted at a workspace-relative directory. */
export interface RepoRoot {
  name: string;
  root: string;
}

export type Edge = readonly [string, string];

export interface StepRecord {
  tool: string;
  /** The seed: a symbol, or `METHOD path` for endpoint_flow. */
  target: string;
  bytes: number;
  raw_bytes: number;
  error: boolean;
  ms: number;
}

export interface QuestionResult {
  id: string;
  steps: StepRecord[];
  graph_bytes: number;
  facts_total: number;
  facts_covered: string[];
  facts_missing: string[];
  fallback_bytes: number;
  total_bytes: number;
  baseline_bytes: number;
  /**
   * Reading only the cited lines (merged ranges; a file with a rangeless fact
   * counts whole). Present only when facts carry ranges. Information only:
   * the gate compares against `baseline_bytes`, the whole files.
   */
  baseline_cited_bytes?: number;
  edges_returned: number;
  false_edges: string[];
  expected_edges: number;
  expected_found: string[];
  expected_missing: string[];
}

// ---------------------------------------------------------------------------
// Bytes and tokens
// ---------------------------------------------------------------------------

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Every spelling of the workspace path a response might carry, longest first
 * so a longer spelling is never half-replaced by a shorter one.
 */
export function workspaceVariants(workspace: string): string[] {
  const forward = workspace.replace(/\\/g, "/");
  const uri = `file://${forward.startsWith("/") ? "" : "/"}${encodeURI(forward)}`;
  const variants = new Set([workspace, forward, JSON.stringify(workspace).slice(1, -1), uri]);
  return [...variants].sort((a, b) => b.length - a.length);
}

export function shorten(text: string, variants: readonly string[]): string {
  let out = text;
  for (const variant of variants) out = out.split(variant).join("${ws}");
  return out;
}

/** What reading a file with the Read tool costs: its bytes plus the gutter. */
export function readCost(data: Uint8Array): number {
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data.length + lines * READ_GUTTER_BYTES;
}

/** bytes / 4, rounded half-to-even — Python's `round`, which the original used. */
export function tokens(bytes: number): number {
  const x = bytes / BYTES_PER_TOKEN;
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Sorted, with overlapping or touching ranges joined. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const out: Array<[number, number]> = [];
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * What reading only these lines costs, with readCost's accounting (CTX-S2).
 * A range outside the file throws rather than clamping: it means the golden
 * is out of date with the corpus, and a clamp would quietly shrink the
 * baseline the gate compares against.
 */
export function readRangesCost(data: Uint8Array, ranges: readonly LineRange[]): number {
  // Byte offset where each line starts; a last line without "\n" still counts.
  const starts = [0];
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === 0x0a && i + 1 < data.length) starts.push(i + 1);
  }
  const lineCount = data.length === 0 ? 0 : starts.length;
  for (const [s, e] of ranges) {
    if (s < 1) throw new RangeError(`ranges are 1-based: got ${s}-${e}`);
    if (s > e) throw new RangeError(`range ${s}-${e} has its start after its end`);
    if (e > lineCount) {
      throw new RangeError(`range ${s}-${e} runs to line ${e}, past the end of the file (${lineCount} lines)`);
    }
  }
  let cost = 0;
  for (const [s, e] of mergeRanges(ranges)) {
    cost += readCost(data.subarray(starts[s - 1]!, e < lineCount ? starts[e]! : data.length));
  }
  return cost;
}

/**
 * A corpus golden names files `<repo>/<path>`; the repo's `rootPath` comes
 * from the real config, so the golden holds no machine-specific path.
 */
export function corpusPath(
  file: string, repos: ReadonlyArray<{ name: string; rootPath: string }>,
): string | null {
  const slash = file.indexOf("/");
  if (slash <= 0) return null;
  const repo = repos.find((r) => r.name === file.slice(0, slash));
  return repo ? `${repo.rootPath.replace(/[\\/]+$/, "")}/${file.slice(slash + 1)}` : null;
}

// ---------------------------------------------------------------------------
// Reading responses
// ---------------------------------------------------------------------------

/** Undo TOON's cell quoting: `""` is a quote, `\n` a newline. */
function unquoteCell(cell: string): string {
  if (cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"')) {
    return cell.slice(1, -1).replace(/""/g, '"').replace(/\\n/g, "\n");
  }
  return cell;
}

/**
 * A response as text evidence can match verbatim.
 *
 * JSON is decoded to its string values (the original's behaviour). code-intel
 * answers in TOON, where a cell holding a comma or quote is quoted CSV-style,
 * so the raw text is kept AND a copy with every quoted cell unescaped is
 * appended: evidence inside a cell matches the unescaped copy, evidence inside
 * a raw `source:` block matches the original.
 */
export function searchable(text: string): string {
  try {
    const data: unknown = JSON.parse(text);
    const parts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(data);
    return parts.join("\n");
  } catch {
    const unquoted = text.replace(/"(?:[^"]|"")*"/g, (cell) => unquoteCell(cell));
    return unquoted === text ? text : `${text}\n${unquoted}`;
  }
}

/** Split one TOON table row on commas outside quoted cells. */
export function splitToonRow(line: string): string[] {
  const cells: string[] = [];
  const row = line.trim();
  let current = "";
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { current += '""'; i += 1; continue; }
      if (ch === '"') quoted = false;
      current += ch;
    } else if (ch === '"') {
      quoted = true;
      current += ch;
    } else if (ch === ",") {
      cells.push(unquoteCell(current));
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(unquoteCell(current));
  return cells;
}

/** A top-level `key: value` line (column 0), or undefined. */
export function toonScalar(text: string, key: string): string | undefined {
  const prefix = `${key}:`;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (rest !== "" && !rest.startsWith(" ")) continue;
    return unquoteCell(rest.trim());
  }
  return undefined;
}

/** The rows of a `key[N]{a,b,c}:` table, as objects. Missing table -> []. */
export function toonTable(text: string, key: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[(\\d+)\\](?:\\{([^}]*)\\})?:`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = header.exec(lines[i]!);
    if (!m) continue;
    const count = Number(m[1]);
    if (!m[2] || count === 0) return [];
    const fields = m[2].split(",");
    return lines.slice(i + 1, i + 1 + count).map((row) => {
      const cells = splitToonRow(row);
      return Object.fromEntries(fields.map((f, j) => [f, cells[j] ?? ""]));
    });
  }
  return [];
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * The workspace path of a repo-relative path: the one repo root under which
 * the file exists. Ambiguous or unknown -> null, never a guess.
 */
export function workspaceFile(
  repoRelative: string, roots: readonly RepoRoot[], files: ReadonlySet<string>,
): string | null {
  const rel = repoRelative.replace(/\\/g, "/");
  const hits = roots
    .map((r) => (r.root === "" || r.root === "." ? rel : `${r.root.replace(/\/+$/, "")}/${rel}`))
    .filter((p) => files.has(p));
  return hits.length === 1 ? hits[0]! : null;
}

export function edgeKey(edge: Edge): string {
  return `${edge[0]} -> ${edge[1]}`;
}

/** `where` is `path:line`; the path is everything before the last colon. */
function pathOfWhere(where: string): string {
  const colon = where.lastIndexOf(":");
  return colon > 0 ? where.slice(0, colon) : where;
}

/**
 * (caller, callee) pairs a response asserts. As in the original, only shapes
 * that name both ends unambiguously count:
 *
 *   impact        each `directCallers` row is an edge into the seed
 *   context_pack  each `callees` / `callers` row whose detail is `CALLS`;
 *                 CALLS_EXTERNAL targets are packages, not workspace symbols
 *
 * endpoint_flow's call tree is flattened across chain steps, so a row's parent
 * is not recoverable without guessing; it contributes no edges.
 */
export function edgesIn(
  tool: string, text: string, roots: readonly RepoRoot[], files: ReadonlySet<string>,
): Edge[] {
  const id = (path: string, name: string): string =>
    `${workspaceFile(path, roots, files) ?? path}::${name}`;

  if (tool === "impact") {
    const symbol = toonScalar(text, "symbol");
    const file = toonScalar(text, "file");
    if (!symbol || !file) return [];
    const me = id(file, symbol);
    return toonTable(text, "directCallers")
      .map((row): Edge => [id(pathOfWhere(row["where"] ?? ""), row["name"] ?? ""), me]);
  }

  if (tool === "context_pack") {
    const seed = toonScalar(text, "seed");
    const file = toonScalar(text, "file");
    if (!seed || !file) return [];
    const me = id(file, seed);
    const calls = (row: Record<string, string>): boolean => /^CALLS \[/.test(row["detail"] ?? "");
    const other = (row: Record<string, string>): string =>
      id(pathOfWhere(row["where"] ?? ""), row["name"] ?? "");
    return [
      ...toonTable(text, "callees").filter(calls).map((row): Edge => [me, other(row)]),
      ...toonTable(text, "callers").filter(calls).map((row): Edge => [other(row), me]),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Scoring and the report
// ---------------------------------------------------------------------------

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** A fact's ranges, or undefined for "the whole file". An empty list is no ranges, never a free read. */
const rangesOf = (f: Fact): LineRange[] | undefined => (f.ranges?.length ? f.ranges : undefined);

/**
 * The reads a set of facts needs: each file once, with its facts' ranges
 * merged, or `undefined` (the whole file) as soon as one fact has no ranges.
 */
function readsFor(facts: readonly Fact[]): Array<[string, LineRange[] | undefined]> {
  const byFile = new Map<string, LineRange[] | undefined>();
  for (const f of facts) {
    const ranges = rangesOf(f);
    const whole = !ranges || (byFile.has(f.file) && byFile.get(f.file) === undefined);
    byFile.set(f.file, whole ? undefined : [...(byFile.get(f.file) ?? []), ...ranges]);
  }
  return sorted(byFile.keys()).map((file) => {
    const ranges = byFile.get(file);
    return [file, ranges ? mergeRanges(ranges) : undefined];
  });
}

export function scoreQuestion(input: {
  question: GoldenQuestion;
  steps: StepRecord[];
  /** Every response, already passed through `searchable`. */
  texts: string[];
  /** Edge keys (`edgeKey`) the responses asserted. */
  returned: ReadonlySet<string>;
  trueEdges: ReadonlySet<string>;
  /** Read cost of a file: only `ranges` when given (CTX-S2), else all of it. */
  fileCost: (file: string, ranges?: readonly LineRange[]) => number;
}): QuestionResult {
  const { question, steps, returned, trueEdges, fileCost } = input;
  const seen = input.texts.join("\n");
  const facts = question.facts ?? [];
  const covered = facts.filter((f) => seen.includes(f.evidence));
  const missing = facts.filter((f) => !seen.includes(f.evidence));
  const cost = (reads: Array<[string, LineRange[] | undefined]>): number =>
    reads.reduce((n, [file, ranges]) => n + fileCost(file, ranges), 0);
  const graphBytes = steps.reduce((n, s) => n + s.bytes, 0);
  const wholeFiles = (fs: Fact[]): number =>
    sorted(new Set(fs.map((f) => f.file))).reduce((n, f) => n + fileCost(f), 0);
  const fallbackBytes = wholeFiles(missing);
  const baselineBytes = wholeFiles(facts);
  const ranged = facts.some((f) => rangesOf(f));

  const expected = new Set((question.expected_edges ?? []).map((e) => edgeKey(e)));
  return {
    id: question.id,
    steps,
    graph_bytes: graphBytes,
    facts_total: facts.length,
    facts_covered: covered.map((f) => f.id),
    facts_missing: missing.map((f) => `${f.id} (${f.file}:${f.line})`),
    fallback_bytes: fallbackBytes,
    total_bytes: graphBytes + fallbackBytes,
    baseline_bytes: baselineBytes,
    ...(ranged ? { baseline_cited_bytes: cost(readsFor(facts)) } : {}),
    edges_returned: returned.size,
    false_edges: sorted([...returned].filter((e) => !trueEdges.has(e))),
    expected_edges: expected.size,
    expected_found: sorted([...returned].filter((e) => expected.has(e))),
    expected_missing: sorted([...expected].filter((e) => !returned.has(e))),
  };
}

function commas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The original's text report, line for line. */
export function formatReport(
  results: readonly QuestionResult[], schemaBytes: number, server: string,
): string {
  const out: string[] = [];
  out.push(`\nserver: ${server}`);
  out.push(
    `tool schema (tools/list): ${commas(schemaBytes)} B ` +
    `(~${commas(tokens(schemaBytes))} tokens, paid once per session)\n`,
  );
  for (const r of results) {
    out.push(`== ${r.id}`);
    if (r.facts_total) {
      const ratio = r.baseline_bytes ? r.total_bytes / r.baseline_bytes : 0;
      out.push(`   facts from graph: ${r.facts_covered.length}/${r.facts_total}`);
      out.push(
        `   graph ${commas(r.graph_bytes)} B + still-to-read ${commas(r.fallback_bytes)} B = ` +
        `${commas(r.total_bytes)} B (~${commas(tokens(r.total_bytes))} tok)   vs reading files ` +
        `${commas(r.baseline_bytes)} B (~${commas(tokens(r.baseline_bytes))} tok)   -> x${ratio.toFixed(2)}` +
        (r.baseline_cited_bytes === undefined ? "" :
          `   (cited lines only ${commas(r.baseline_cited_bytes)} B, ~${commas(tokens(r.baseline_cited_bytes))} tok)`),
      );
      for (const fact of r.facts_missing) out.push(`     missing: ${fact}`);
    }
    if (r.edges_returned || r.expected_edges) {
      out.push(
        `   edges returned: ${r.edges_returned}, false: ${r.false_edges.length}, ` +
        `expected found: ${r.expected_found.length}/${r.expected_edges}`,
      );
      for (const edge of r.false_edges) out.push(`     FALSE: ${edge}`);
      for (const edge of r.expected_missing) out.push(`     not found: ${edge}`);
    }
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The G5 gate (CTX-S2)
// ---------------------------------------------------------------------------

export type GateCondition = "tokens" | "fact" | "empty";

export interface GateFailure {
  question: string;
  condition: GateCondition;
  detail: string;
}

export interface GateVerdict {
  pass: boolean;
  /** Questions the gate judged: those with at least one fact. */
  gated: number;
  failures: GateFailure[];
  /**
   * Questions with no facts (edges-only, like orders_app's order_call_chain).
   * They have no reading-the-files baseline, so G5 says nothing about them;
   * they are listed, never counted as passing.
   */
  notGated: string[];
}

/**
 * G5, per question: graph + still-to-read strictly below reading the files,
 * and every required fact present. One failing question fails the run, and
 * a run with nothing to judge does not pass.
 */
export function gate(results: readonly QuestionResult[]): GateVerdict {
  const failures: GateFailure[] = [];
  const notGated: string[] = [];
  let gated = 0;
  for (const r of results) {
    if (r.facts_total === 0) {
      notGated.push(r.id);
      continue;
    }
    gated += 1;
    if (r.total_bytes >= r.baseline_bytes) {
      failures.push({
        question: r.id,
        condition: "tokens",
        detail:
          `graph + still-to-read ${commas(r.total_bytes)} B (~${commas(tokens(r.total_bytes))} tok) ` +
          `>= reading the files ${commas(r.baseline_bytes)} B (~${commas(tokens(r.baseline_bytes))} tok)`,
      });
    }
    for (const fact of r.facts_missing) failures.push({ question: r.id, condition: "fact", detail: fact });
  }
  if (gated === 0) {
    failures.push({ question: "(all)", condition: "empty", detail: "no question has facts, so there is nothing to gate" });
  }
  return { pass: failures.length === 0, gated, failures, notGated };
}

export function formatGate(v: GateVerdict): string {
  const out: string[] = [];
  if (v.pass) {
    out.push(`GATE PASS (G5): all ${v.gated} gated questions are cheaper than reading their files and have every fact`);
  } else if (v.gated === 0) {
    out.push("GATE FAIL (G5): nothing to gate (no question has facts)");
  } else {
    const failing = new Set(v.failures.map((f) => f.question));
    out.push(`GATE FAIL (G5): ${failing.size} of ${v.gated} questions fail`);
    const width = Math.max(...v.failures.map((f) => f.question.length));
    for (const f of v.failures) {
      const what = f.condition === "tokens" ? "tokens: " : f.condition === "fact" ? "fact missing: " : "";
      out.push(`  ${f.question.padEnd(width)}  ${what}${f.detail}`);
    }
  }
  if (v.notGated.length) out.push(`not gated (no facts): ${v.notGated.join(", ")}`);
  return `${out.join("\n")}\n`;
}
