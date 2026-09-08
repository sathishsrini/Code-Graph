// ============================================================================
// CFG -> function_cfg, and edge attribution  —  task P1-T18  (R77)
// ============================================================================
// Two writes, and the second is what R77 actually asks for: every `CALLS`,
// `READS`, `WRITES`, `CALLS_EXTERNAL` and `THROWS` edge whose call site sits
// inside a parsed function gets the index of the innermost CFG block
// containing it.
//
// That single column is what turns "these are the calls" into "these calls are
// guarded by `if (authErr)`, and that branch exits with an error". Without it
// the CFG is a picture nobody can join to anything.
//
// **A CFG belongs to a symbol, so a function with no symbol gets none.** An
// anonymous handler has no SCIP definition, and `ownerSymbol` refuses to
// attribute it to the enclosing module. The CFG is still *extracted* — the
// failure surface reads it — but there is nowhere to key it, and inventing a
// key would put a second identity system next to SCIP's, which is the v2 root
// cause this project is named after avoiding.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import type { DefRange } from "../query/flow.ts";
import { symbolAt } from "../query/flow.ts";
import { symbolKind } from "./scip/symbol.ts";
import type { FunctionCfg } from "./cfg.ts";
import { blockAt } from "./cfg.ts";

export interface CfgIngestContext {
  store: FactStore;
  /** SCIP definition ranges for the repo, from `buildDefinitionRanges`. */
  ranges: DefRange[];
  /** Repo-relative path of the file these CFGs came from. */
  path: string;
  fileId: number;
  runId: number;
  /** node id by SCIP symbol key, for the symbols already written this run. */
  nodeIdOf: (scipSymbol: string) => number | null;
}

export interface CfgIngestCounts {
  functions: number;
  blocks: number;
  errorExits: number;
  /** Edges given a `cfg_block_index`. */
  attributed: number;
  /** Functions whose CFG could not be keyed to a symbol. A gap, not a zero. */
  unkeyed: number;
}

export function ingestCfgs(
  ctx: CfgIngestContext, cfgs: FunctionCfg[],
): CfgIngestCounts {
  const counts: CfgIngestCounts = {
    functions: 0, blocks: 0, errorExits: 0, attributed: 0, unkeyed: 0,
  };

  for (const cfg of cfgs) {
    const symbol = ownerOf(ctx.ranges, ctx.path, cfg.fn.line);
    if (!symbol) { counts.unkeyed += 1; continue; }
    const nodeId = ctx.nodeIdOf(symbol);
    if (nodeId === null) { counts.unkeyed += 1; continue; }

    ctx.store.replaceCfg(nodeId, cfg.blocks.map((b) => ({
      symbolNodeId: nodeId,
      blockIndex: b.blockIndex,
      parentIndex: b.parentIndex,
      kind: b.kind,
      conditionText: b.conditionText,
      outcome: b.outcome,
      exitForm: b.exitForm,
      errorName: b.errorName,
      startLine: b.startLine,
      endLine: b.endLine,
      fileId: ctx.fileId,
      runId: ctx.runId,
    })));

    counts.functions += 1;
    counts.blocks += cfg.blocks.length;
    counts.errorExits += cfg.blocks.filter((b) => b.outcome === "error_exit").length;

    // R77. Every edge this symbol owns, placed at a line, gets its block.
    for (const edge of ctx.store.raw().prepare(
      `SELECT DISTINCT line FROM edges
        WHERE src_node_id = ? AND file_id = ? AND line IS NOT NULL`,
    ).all(nodeId, ctx.fileId) as Array<{ line: number }>) {
      counts.attributed += ctx.store.attributeEdgeToBlock(
        nodeId, ctx.fileId, edge.line, blockAt(cfg.blocks, edge.line),
      );
    }
  }

  return counts;
}

/**
 * The symbol a CFG belongs to.
 *
 * Same rule as everywhere else in this codebase: a namespace symbol is not an
 * owner. A module's "control flow" would be the whole file's, which is not a
 * function's CFG and would attribute every call in the file to one block.
 */
function ownerOf(ranges: DefRange[], path: string, line: number): string | null {
  const symbol = symbolAt(ranges, path, line);
  if (!symbol) return null;
  return symbolKind(symbol) === "namespace" ? null : symbol;
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export interface StoredBlock {
  blockIndex: number;
  parentIndex: number | null;
  kind: string;
  conditionText: string | null;
  outcome: string | null;
  exitForm: string | null;
  errorName: string | null;
  startLine: number;
  endLine: number;
}

export function readCfg(store: FactStore, symbolNodeId: number): StoredBlock[] {
  return (store.raw().prepare(
    `SELECT block_index, parent_index, kind, condition_text, outcome,
            exit_form, error_name, start_line, end_line
       FROM function_cfg WHERE symbol_node_id = ? ORDER BY block_index`,
  ).all(symbolNodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    blockIndex: Number(r["block_index"]),
    parentIndex: r["parent_index"] === null ? null : Number(r["parent_index"]),
    kind: String(r["kind"]),
    conditionText: (r["condition_text"] as string | null) ?? null,
    outcome: (r["outcome"] as string | null) ?? null,
    exitForm: (r["exit_form"] as string | null) ?? null,
    errorName: (r["error_name"] as string | null) ?? null,
    startLine: Number(r["start_line"]),
    endLine: Number(r["end_line"]),
  }));
}

/**
 * R77's query: calls reachable only through a block that always errors.
 *
 * This is the question the plan states the column exists to answer — "which
 * calls are guarded by which condition" — asked from the useful direction.
 * A call on an error-only path is one that runs *only* when something has
 * already gone wrong, which is exactly what you want to know before deleting
 * it.
 */
export function callsOnErrorPath(store: FactStore, symbolNodeId: number): Array<{
  callee: string; line: number | null; blockIndex: number; condition: string | null;
}> {
  return (store.raw().prepare(
    `WITH RECURSIVE ancestry(block_index, root_index) AS (
       SELECT block_index, block_index FROM function_cfg WHERE symbol_node_id = :sym
       UNION
       SELECT c.block_index, a.root_index
         FROM ancestry a
         JOIN function_cfg c ON c.symbol_node_id = :sym AND c.parent_index = a.block_index
     ),
     -- A block is error-only when it has exits and every one of them errors.
     -- An 'unknown' exit disqualifies: undetermined is not evidence.
     error_only AS (
       SELECT a.root_index
         FROM ancestry a
         JOIN function_cfg e ON e.symbol_node_id = :sym
                            AND e.block_index = a.block_index
                            AND e.kind = 'exit'
        GROUP BY a.root_index
       HAVING COUNT(*) > 0 AND SUM(CASE WHEN e.outcome = 'error_exit' THEN 0 ELSE 1 END) = 0
     )
     SELECT n.key AS callee, e.line, e.cfg_block_index AS block_index,
            b.condition_text AS condition
       FROM edges e
       JOIN nodes n ON n.id = e.dst_node_id
       JOIN error_only eo ON eo.root_index = e.cfg_block_index
       JOIN function_cfg b ON b.symbol_node_id = :sym AND b.block_index = e.cfg_block_index
      WHERE e.src_node_id = :sym AND e.cfg_block_index IS NOT NULL
      ORDER BY e.line`,
  ).all({ sym: symbolNodeId }) as Array<Record<string, string | number | null>>).map((r) => ({
    callee: String(r["callee"]),
    line: r["line"] === null ? null : Number(r["line"]),
    blockIndex: Number(r["block_index"]),
    condition: (r["condition"] as string | null) ?? null,
  }));
}
