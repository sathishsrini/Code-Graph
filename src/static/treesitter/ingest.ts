// ============================================================================
// tree-sitter findings -> graph rows  —  task P1-T6  (requirements R19, R23)
// ============================================================================
// The findings in extract.ts are positions in a file. This turns them into
// edges, which means answering one question per finding: **who is the caller?**
//
// SCIP's definition ranges are the primary answer, because a symbol node has
// to exist for the edge to point out of, and SCIP owns symbol identity (R4).
// Where SCIP has no definition covering the line — routine on untyped
// CommonJS, where 86 of 306 references resolve to unnamed locals (M7) — the
// finding is attributed to the enclosing *file* node instead, never dropped
// and never attached to a symbol that does not contain it.
//
// The one refinement worth stating twice: the *module* symbol does contain
// the line, and `symbolAt` returns it, but it is not an owner. Its range is
// the whole file, so attributing an anonymous arrow's finding to it says
// "the module called X" — M7's wasted-width claim. Owner is the innermost
// non-namespace definition, else the file node. P1-T7's `callSiteOwner` and
// this module both use `ownerSymbol`, and `flow` scopes the module join it
// keeps for boot hooks with `functionExtent` at query time.
// ============================================================================

import type { FactStore } from "../../store/db.ts";
import type { GraphWriter } from "../../normalize/graph.ts";
import { ref } from "../../normalize/keys.ts";
import { symbolAt, type DefRange } from "../../query/flow.ts";
import { symbolKind } from "../scip/symbol.ts";
import type { FileFindings } from "./extract.ts";
import { enclosingFunction } from "./extract.ts";

export interface IngestContext {
  writer: GraphWriter;
  store: FactStore;
  repoName: string;
  /** SCIP definition ranges for the whole repo, from `buildDefinitionRanges`. */
  ranges: DefRange[];
  /** `files.id` for the file being ingested — the provenance key for R28. */
  fileId: number;
}

export interface IngestCounts {
  throws: number;
  reads: number;
  writes: number;
  configs: number;
  /** Findings with no enclosing SCIP symbol, attributed to the file node. */
  fileScoped: number;
}

/**
 * Write one file's findings.
 *
 * Returns counts rather than logging, so the caller decides what the user
 * sees and the numbers can be asserted in a test.
 */
export function ingestFindings(ctx: IngestContext, f: FileFindings): IngestCounts {
  const counts: IngestCounts = { throws: 0, reads: 0, writes: 0, configs: 0, fileScoped: 0 };
  const fileNode = ref.file(ctx.repoName, f.path);

  /**
   * The node a finding at `line` belongs to.
   *
   * The fallback is the file, not the nearest symbol. Attaching a `WRITES`
   * edge to whichever function happened to be closest would put a claim in
   * the graph that the source does not support, and R40's anomaly query
   * ("routes that write with no tenant check") reads exactly these edges.
   */
  const owner = (line: number) => {
    const symbol = ownerSymbol(ctx.ranges, f.path, line);
    if (symbol) return ref.symbol(symbol);
    counts.fileScoped += 1;
    return fileNode;
  };

  for (const t of f.throws) {
    // R19/doc §Q.2: declared locally, always inferred, never complete.
    ctx.writer.edge({
      src: owner(t.line),
      dst: ref.package("error", t.errorName ?? "(rethrow)"),
      type: "THROWS", confidence: "inferred", evidenceKind: "treesitter",
      fileId: ctx.fileId, line: t.line, detail: t.text,
    });
    counts.throws += 1;
  }

  for (const c of f.configs) {
    // R23: the key name, and that it is read. Never the value, not even
    // redacted and not even hashed.
    ctx.writer.edge({
      src: owner(c.line),
      dst: ref.config(c.varName),
      type: "READS_CONFIG", confidence: "inferred", evidenceKind: "treesitter",
      fileId: ctx.fileId, line: c.line, detail: c.accessor,
    });
    counts.configs += 1;
  }

  for (const d of f.datastores) {
    ctx.writer.edge({
      src: owner(d.line),
      dst: ref.datastore({ engine: d.engine, table: d.table }),
      type: d.operation === "write" ? "WRITES" : "READS",
      confidence: "inferred", evidenceKind: "treesitter",
      fileId: ctx.fileId, line: d.line, detail: `${d.verb} ${d.sql}`,
    });
    if (d.operation === "write") counts.writes += 1; else counts.reads += 1;
  }

  return counts;
}

/**
 * Attribute an HTTP call site to a caller, for P1-T7.
 *
 * Separated from `ingestFindings` because an outbound call is not an edge yet
 * — until the cross-service linker resolves a destination, it is a call site
 * with a URL expression. Writing a `CALLS_EXTERNAL` edge here and then a
 * `REQUESTS` edge there would double-count the same call.
 *
 * Shares `ownerSymbol` with `ingestFindings`, so the two channels agree on
 * the one question both answer: a namespace (module/file) symbol is not an
 * owner. An anonymous handler has no definition of its own, so its REQUESTS
 * edge sources from the file node, never from the module — the M7 defect
 * wearing a different hat (review, 2026-09-07).
 */
export function callSiteOwner(
  ranges: DefRange[], functions: FileFindings["functions"], path: string, line: number,
): { symbol: string | null; functionName: string | null } {
  return {
    symbol: ownerSymbol(ranges, path, line),
    functionName: enclosingFunction(functions, line)?.name ?? null,
  };
}

/**
 * The innermost definition at `file:line` that may own a finding.
 *
 * Explicitly refuses a `namespace`: that is the module or file, whose range
 * spans everything, so owning a finding there attributes every call in the
 * file to one node (M7). Returns null, and the caller falls back to the file
 * node, which is honest about the width of the claim.
 */
function ownerSymbol(ranges: DefRange[], file: string, line: number): string | null {
  const symbol = symbolAt(ranges, file, line);
  if (!symbol) return null;
  return symbolKind(symbol) === "namespace" ? null : symbol;
}
