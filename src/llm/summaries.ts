// ============================================================================
// LLM summaries  —  task P3-T2  (requirements R34, R62, R63, R64)
// ============================================================================
// The LLM boundary. Five permitted uses, seven forbidden ones, and the
// enforcement is structural rather than a rule somebody remembers.
//
// **The containment, stated once:** everything a model produces lands in
// `summaries`, which no traversal joins. `writeSummary` is the only function in
// this codebase that inserts model output, and it can only insert there — it
// has no access to a `GraphWriter` and takes no node id. The model cannot
// reach `edges`, `route_chain` or `function_cfg`, so it cannot corrupt them.
//
// That matters because the failure it prevents is invisible: a model writes a
// plausible relationship, a traversal treats it as fact, and later nobody can
// separate what was observed from what was imagined. A `confidence` column
// would not help — the model would be filling that in too.
//
// **No provider ships.** OPEN-8 (provider, model, key management) is an open
// decision and is the caller's, so this module defines the seam and nothing
// else. With none configured, `summarise` reports what is missing instead of
// silently producing nothing.
// ============================================================================

import { createHash } from "node:crypto";
import type { FactStore } from "../store/db.ts";

/** R62's five permitted uses. Anything not on this list does not get a path. */
export type SummaryKind = "function" | "module" | "service" | "path";

export interface SummaryRequest {
  nodeKey: string;
  kind: SummaryKind;
  /**
   * Everything the model is shown.
   *
   * Hashed to become the cache key, so "the input changed" and "regenerate"
   * are the same question (R64). Build it from facts already in the store —
   * a signature, a call list, a chain — never from another summary, or the
   * cache invalidation becomes transitive and stops working.
   */
  input: string;
}

export interface SummaryResult {
  nodeKey: string;
  kind: SummaryKind;
  summary: string;
  model: string;
  provider: string;
  inputSha256: string;
  cached: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  generatedAt: string;
}

/**
 * A text-generation provider.
 *
 * Deliberately tiny. Everything this project needs from a model is "given this
 * prompt, return prose", and a wider interface would invite passing it
 * structured output to write into the graph — which is the one thing R63
 * forbids.
 */
export interface SummaryProvider {
  readonly name: string;
  readonly model: string;
  complete(prompt: string): Promise<{
    text: string;
    tokensIn?: number;
    tokensOut?: number;
  }>;
}

export function hashInput(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------

/**
 * The prompts, in one place and short on purpose.
 *
 * Each one says what the model is looking at and forbids it from inventing
 * relationships. A model asked to "describe this function" will happily narrate
 * a caller it inferred from the name; naming that as out of scope in the prompt
 * is cheaper than detecting it afterwards.
 */
const PROMPTS: Record<SummaryKind, (input: string) => string> = {
  function: (input) =>
    "Describe what this function does, in at most three sentences, for a " +
    "developer about to edit it. Use only the facts given. Do not speculate " +
    "about callers, behaviour or intent that is not shown.\n\n" + input,
  module: (input) =>
    "Summarise this module's responsibility in at most three sentences. Use " +
    "only the symbols and calls listed. Do not infer architecture that is not " +
    "shown.\n\n" + input,
  service: (input) =>
    "Summarise what this service is for, in at most four sentences, from its " +
    "routes and dependencies. Do not speculate about consumers not listed.\n\n" +
    input,
  path: (input) =>
    "Narrate this execution path in order, in at most five sentences. Say what " +
    "each step does. Where a step is marked inferred, say that it is inferred " +
    "rather than stating it as fact.\n\n" + input,
};

export class NoProviderConfigured extends Error {
  constructor() {
    super(
      "no LLM provider configured (OPEN-8). Summaries are optional and nothing " +
      "in the query engine reads them; configure a SummaryProvider to enable.",
    );
    this.name = "NoProviderConfigured";
  }
}

/**
 * Generate or fetch one summary (R34, R64).
 *
 * Cache-first, keyed by the hash of the exact input. A hit costs one indexed
 * lookup and no tokens, which is what makes R64's "cents per week" true rather
 * than aspirational.
 */
export async function summarise(
  store: FactStore, request: SummaryRequest, provider?: SummaryProvider,
): Promise<SummaryResult> {
  const inputSha256 = hashInput(request.input);

  const cached = store.raw().prepare(
    `SELECT summary, model, provider, tokens_in, tokens_out, generated_at
       FROM summaries WHERE node_key = ? AND kind = ? AND input_sha256 = ?`,
  ).get(request.nodeKey, request.kind, inputSha256) as
    | Record<string, string | number | null> | undefined;

  if (cached) {
    return {
      nodeKey: request.nodeKey,
      kind: request.kind,
      summary: String(cached["summary"]),
      model: String(cached["model"]),
      provider: String(cached["provider"]),
      inputSha256,
      cached: true,
      tokensIn: cached["tokens_in"] === null ? null : Number(cached["tokens_in"]),
      tokensOut: cached["tokens_out"] === null ? null : Number(cached["tokens_out"]),
      generatedAt: String(cached["generated_at"]),
    };
  }

  if (!provider) throw new NoProviderConfigured();

  const completion = await provider.complete(PROMPTS[request.kind](request.input));
  const generatedAt = new Date().toISOString();

  writeSummary(store, {
    nodeKey: request.nodeKey,
    kind: request.kind,
    inputSha256,
    summary: completion.text.trim(),
    model: provider.model,
    provider: provider.name,
    tokensIn: completion.tokensIn ?? null,
    tokensOut: completion.tokensOut ?? null,
    generatedAt,
  });

  return {
    nodeKey: request.nodeKey,
    kind: request.kind,
    summary: completion.text.trim(),
    model: provider.model,
    provider: provider.name,
    inputSha256,
    cached: false,
    tokensIn: completion.tokensIn ?? null,
    tokensOut: completion.tokensOut ?? null,
    generatedAt,
  };
}

export interface SummaryRow {
  nodeKey: string;
  kind: SummaryKind;
  inputSha256: string;
  summary: string;
  model: string;
  provider: string;
  tokensIn: number | null;
  tokensOut: number | null;
  generatedAt: string;
}

/**
 * The ONLY write path for model output in this codebase.
 *
 * It takes no `GraphWriter` and no node id, and it names one table. That is the
 * structural half of R63: there is no code path from a model's response to
 * `edges`, and adding one would mean writing a new function that a reviewer
 * would see.
 */
export function writeSummary(store: FactStore, row: SummaryRow): void {
  store.raw().prepare(
    `INSERT INTO summaries
       (node_key, kind, input_sha256, summary, model, provider,
        tokens_in, tokens_out, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_key, kind, input_sha256) DO UPDATE SET
       summary      = excluded.summary,
       model        = excluded.model,
       provider     = excluded.provider,
       tokens_in    = excluded.tokens_in,
       tokens_out   = excluded.tokens_out,
       generated_at = excluded.generated_at`,
  ).run(
    row.nodeKey, row.kind, row.inputSha256, row.summary,
    row.model, row.provider, row.tokensIn, row.tokensOut, row.generatedAt,
  );
}

/** Read a cached summary for display. Never used by a traversal. */
export function readSummary(
  store: FactStore, nodeKey: string, kind: SummaryKind,
): SummaryRow | null {
  const row = store.raw().prepare(
    `SELECT node_key, kind, input_sha256, summary, model, provider,
            tokens_in, tokens_out, generated_at
       FROM summaries WHERE node_key = ? AND kind = ?
      ORDER BY generated_at DESC LIMIT 1`,
  ).get(nodeKey, kind) as Record<string, string | number | null> | undefined;
  if (!row) return null;

  return {
    nodeKey: String(row["node_key"]),
    kind: String(row["kind"]) as SummaryKind,
    inputSha256: String(row["input_sha256"]),
    summary: String(row["summary"]),
    model: String(row["model"]),
    provider: String(row["provider"]),
    tokensIn: row["tokens_in"] === null ? null : Number(row["tokens_in"]),
    tokensOut: row["tokens_out"] === null ? null : Number(row["tokens_out"]),
    generatedAt: String(row["generated_at"]),
  };
}

// ---------------------------------------------------------------------------
// Input builders — facts only
// ---------------------------------------------------------------------------

/**
 * The prompt input for one function, assembled from the store.
 *
 * Only facts: signature, file position, callees, callers, and its control-flow
 * exits. No other summary is included — building a summary from summaries
 * makes cache invalidation transitive, and a stale leaf then silently poisons
 * everything above it (R66's bottom-up ordering is about generation order, not
 * about feeding output back in as input).
 */
export function functionInput(store: FactStore, nodeKey: string): string | null {
  const db = store.raw();
  const symbol = db.prepare(
    `SELECT s.display_name, s.signature, s.start_line, s.end_line, f.path
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       LEFT JOIN files f ON f.id = s.file_id
      WHERE n.key = ?`,
  ).get(nodeKey) as Record<string, string | number | null> | undefined;
  if (!symbol) return null;

  const neighbours = (direction: "out" | "in") => {
    const [self, other] = direction === "out"
      ? ["src_node_id", "dst_node_id"] : ["dst_node_id", "src_node_id"];
    return (db.prepare(
      `SELECT DISTINCT n2.key, e.type, e.confidence
         FROM edges e
         JOIN nodes n1 ON n1.id = e.${self}
         JOIN nodes n2 ON n2.id = e.${other}
        WHERE n1.key = ? AND e.type IN ('CALLS', 'CALLS_EXTERNAL', 'REQUESTS')
        ORDER BY n2.key LIMIT 30`,
    ).all(nodeKey) as Array<Record<string, string>>)
      .map((r) => `${r["key"]} [${r["type"]} ${r["confidence"]}]`);
  };

  const exits = (db.prepare(
    `SELECT c.exit_form, c.outcome, c.error_name, parent.condition_text AS guard
       FROM function_cfg c
       JOIN nodes n ON n.id = c.symbol_node_id
       LEFT JOIN function_cfg parent
              ON parent.symbol_node_id = c.symbol_node_id
             AND parent.block_index = c.parent_index
      WHERE n.key = ? AND c.kind = 'exit'
      ORDER BY c.start_line`,
  ).all(nodeKey) as Array<Record<string, string | null>>)
    .map((r) => `${r["outcome"]} via ${r["exit_form"]}` +
      `${r["error_name"] ? ` (${r["error_name"]})` : ""}` +
      `${r["guard"] ? ` when ${r["guard"]}` : ""}`);

  return [
    `name: ${symbol["display_name"]}`,
    `file: ${symbol["path"] ?? "?"}:${symbol["start_line"] ?? "?"}-${symbol["end_line"] ?? "?"}`,
    symbol["signature"] ? `signature: ${symbol["signature"]}` : "",
    `calls:\n  ${neighbours("out").join("\n  ") || "(none resolved)"}`,
    `called by:\n  ${neighbours("in").join("\n  ") || "(none resolved)"}`,
    `exits:\n  ${exits.join("\n  ") || "(no control-flow analysis)"}`,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// R63's structural check
// ---------------------------------------------------------------------------

export interface ContainmentReport {
  ok: boolean;
  /** Tables `summaries` has a foreign key into. Must be empty. */
  foreignKeys: string[];
  /** Query modules referencing `summaries`. Must be empty. */
  referencingQueries: string[];
}

/**
 * Verify the LLM containment (R63), from the live schema.
 *
 * The FK half is checked against SQLite itself rather than against the DDL
 * text, because the question is what the database actually enforces. The
 * source half is the caller's to supply — it is a grep, and doing it here
 * would mean this module reading the repository, which is a stranger
 * dependency than passing the answer in.
 */
export function verifyContainment(
  store: FactStore, queryModuleSources: Record<string, string> = {},
): ContainmentReport {
  const fks = (store.raw().prepare("PRAGMA foreign_key_list(summaries)").all() as
    Array<Record<string, string>>).map((r) => String(r["table"]));

  const referencing = Object.entries(queryModuleSources)
    .filter(([, source]) => /\bsummaries\b/.test(source))
    .map(([name]) => name);

  return {
    ok: fks.length === 0 && referencing.length === 0,
    foreignKeys: fks,
    referencingQueries: referencing,
  };
}
