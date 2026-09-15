// ============================================================================
// Decision structure, condensed for a context pack  —  P3-T10  (R83)
// ============================================================================
// Migration 011 and the viewer gave the CONTROL FLOW to a human: an ISO
// flowchart with diamonds for decisions and colour for outcome. This module
// gives the same thing to a model, and it is the piece that was missing.
//
// It matters because of where features actually live. On this corpus the
// router has no GRN handler: `proxyToEngine` is shared by fifteen routes and
// special-cases the path in an `else` branch at lines 205-211 of a 110-line
// function. Without this tier a pack says "proxyToEngine handles GRN" and
// leaves the reader to search the file. With it, the pack names the branch and
// the condition that reaches it.
//
// **The full block-and-edge graph is not the answer.** `proxyToEngine` alone
// is 20 blocks and 31 edges; rendering that is a token bomb and mostly
// structure nobody needs. What a reader needs is one row per DECISION, per
// EXIT, and per call whose reachability depends on one — each carrying the
// guard path that leads to it.
//
// **The guard path is syntactic, and the output says so.** `when` is built by
// walking `parent_index` + `branch_label` upward: `then` contributes the
// parent's condition, `else` contributes its negation, `catch` contributes
// `on-throw`. That is containment plus arm — migration 011's own header warns
// `parent_index` is not control flow — so it describes which arm of which
// enclosing branch a block sits in, NOT a path an execution took. Calling it a
// trace would be the merge of static and runtime evidence this codebase
// refuses everywhere else.
//
// `function_cfg_edges` is used only for the two things it alone knows: an edge
// to NULL means control falls off the end (an implicit return), and a
// `loop_back` label means the block repeats. Full path enumeration over the
// successor graph is deliberately not done — eight branches is up to 256
// paths, which is the opposite of a budget.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { readCfg, readCfgEdges, callsOnErrorPath, type StoredBlock } from "../static/cfg-ingest.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

/** A row shaped for a pack tier. The caller assigns the tier and provenance. */
export interface CfgRow {
  kind: string;
  name: string;
  detail: string;
  where: string;
}

const DECISION_KINDS = new Set(["branch", "guard", "loop"]);
const CONDITION_CLIP = 80;
const ANCESTOR_CLIP = 60;
/** Innermost ancestors kept in a guard path. Three is a readable sentence. */
const MAX_ANCESTORS = 3;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * Which arm of which enclosing branch this block sits in.
 *
 * Read upward, innermost first, then reversed so it reads in source order.
 * `try_body` contributes nothing — being inside a try is not a condition — and
 * the root terminates the walk.
 */
function guardPath(blocks: Map<number, StoredBlock>, block: StoredBlock): string {
  const parts: string[] = [];
  let cursor: StoredBlock | undefined = block;
  let guard = 0;

  while (cursor && parts.length < MAX_ANCESTORS + 1) {
    const parentIndex: number | null = cursor.parentIndex;
    const label = cursor.branchLabel;
    if (parentIndex === null) break;
    const parent = blocks.get(parentIndex);
    if (!parent) break;
    if (guard++ > 64) break; // a cycle in containment is a bug, not a loop

    const condition = parent.conditionText ? clip(parent.conditionText, ANCESTOR_CLIP) : null;
    if (label === "then" && condition) parts.push(condition);
    else if (label === "else" && condition) parts.push(`NOT(${condition})`);
    else if (label === "catch") parts.push(condition ? `on-throw(${condition})` : "on-throw");
    else if (label === "finally") parts.push("always-after");
    else if (label === "loop_body" && condition) parts.push(`per-iteration(${condition})`);

    cursor = parent;
  }

  if (parts.length === 0) return "always";
  const kept = parts.slice(0, MAX_ANCESTORS).reverse();
  return (parts.length > MAX_ANCESTORS ? "… AND " : "") + kept.join(" AND ");
}

/** `error_exit via return_error (KRI40-…)` — outcome first, it is the point. */
function exitLabel(b: StoredBlock): string {
  const form = b.exitForm ?? "exit";
  const name = b.errorName ? ` (${b.errorName})` : "";
  return `${b.outcome ?? "unknown"} via ${form}${name}`;
}

/**
 * One function's decision structure, condensed.
 *
 * `file` is only used to render positions; a symbol whose CFG was never
 * extracted returns nothing, which is a real answer — not every language in
 * this corpus has a tree-sitter pass.
 */
export function cfgRowsFor(
  store: FactStore, symbolNodeId: number, file: string | null,
): CfgRow[] {
  const blocks = readCfg(store, symbolNodeId);
  if (blocks.length === 0) return [];

  const byIndex = new Map(blocks.map((b) => [b.blockIndex, b]));
  const at = (line: number) => (file ? `${file}:${line}` : `L${line}`);
  const rows: CfgRow[] = [];

  for (const b of blocks) {
    if (DECISION_KINDS.has(b.kind) && b.conditionText) {
      rows.push({
        kind: b.kind === "guard" ? "guard" : "decision",
        name: clip(b.conditionText, CONDITION_CLIP),
        detail: `when ${guardPath(byIndex, b)}`,
        where: at(b.startLine),
      });
    } else if (b.kind === "exit") {
      rows.push({
        kind: "exit",
        name: exitLabel(b),
        detail: `when ${guardPath(byIndex, b)}`,
        where: at(b.startLine),
      });
    } else if (b.kind === "catch") {
      rows.push({
        kind: "catch",
        name: b.conditionText ? `catch (${b.conditionText})` : "catch",
        detail: `when ${guardPath(byIndex, b)}`,
        where: at(b.startLine),
      });
    }
  }

  // The two facts only the successor graph carries.
  const edges = readCfgEdges(store, symbolNodeId);
  const loops = edges.filter((e) => e.label === "loop_back").length;
  if (loops > 0) {
    rows.push({
      kind: "loop", name: `${loops} back-edge(s)`,
      detail: "this function repeats — a change inside a loop body runs N times",
      where: file ?? "",
    });
  }
  const fallsOff = edges.filter((e) => e.to === null).length;
  if (fallsOff > 0) {
    rows.push({
      kind: "exit", name: "implicit return",
      detail: `${fallsOff} path(s) fall off the end without an explicit return`,
      where: file ?? "",
    });
  }

  // R77 from the useful direction: a call that runs ONLY after something has
  // already gone wrong. Deleting one of these is a different decision from
  // deleting a call on the success path.
  for (const call of callsOnErrorPath(store, symbolNodeId)) {
    rows.push({
      kind: "error-path-call",
      name: displayNameOf(call.callee),
      detail: `runs ONLY after a failure${call.condition ? ` — ${clip(call.condition, ANCESTOR_CLIP)}` : ""}`,
      where: call.line === null ? (file ?? "") : at(call.line),
    });
  }

  return rows;
}

/**
 * The caveat that must travel with these rows.
 *
 * Rendered as its own line, before the block. A reader who meets `when` without
 * it will read a syntactic guard path as an execution trace, which is exactly
 * the static/runtime conflation the rest of this engine refuses.
 */
export const CFG_NOTE =
  "'when' is a SYNTACTIC guard path — which arm of which enclosing branch the " +
  "row sits in — not an execution trace and not a proof the path is reachable. " +
  "It is derived from source structure alone.";
