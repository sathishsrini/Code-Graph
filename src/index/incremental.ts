// ============================================================================
// Incremental indexing  —  task P1-T11  (requirements R27, R28, R29)
// ============================================================================
// Three rules, and the second one is the whole design:
//
//   R27  hash every file, compare, derive the changed set (+added, +deleted)
//   R28  **delete by PROVENANCE, never by node**
//   R29  re-run only the derivations whose inputs touched the changed set
//
// Deleting by node is the obvious implementation and it is wrong. A node is
// referenced by rows that other files own: `checkUserAuth` is defined in
// `server.js` and called from three places, and one of those may be in a file
// that has not changed. `DELETE FROM nodes WHERE ...` takes those edges with
// it through ON DELETE CASCADE, and nothing reports the loss — the graph
// simply gets quieter.
//
// Provenance deletion inverts it: a row is owned by the file whose *evidence*
// produced it, so re-indexing `a.ts` removes exactly the rows `a.ts` claimed
// and leaves every claim another file made about `a.ts`'s symbols intact.
// Nodes are never deleted at all. An orphaned node is cheap and honest; a
// missing edge is a false negative.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EvidenceKind, FactStore } from "../store/db.ts";

/** Evidence kinds a static re-index owns, and may therefore delete. */
export const STATIC_EVIDENCE: EvidenceKind[] = ["scip", "treesitter", "semgrep"];

export function hashFile(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ChangeSet {
  /** Present now, hash differs from the store (or the store has never seen it). */
  changed: string[];
  /** In the store, absent from the current file set. */
  deleted: string[];
  /** Present and unchanged. Their rows are not touched. */
  unchanged: string[];
}

/**
 * Compare current hashes against the store (R27).
 *
 * `changed` deliberately conflates "modified" and "added": both require the
 * same work, and a separate `added` list would only ever be used to print a
 * different word.
 */
export function diffFiles(
  store: FactStore, repoId: number, hashes: Map<string, string>,
): ChangeSet {
  const { changed, deleted } = store.changedFiles(repoId, hashes);
  const changedSet = new Set(changed);
  const unchanged = [...hashes.keys()].filter((p) => !changedSet.has(p));
  return { changed, deleted, unchanged: unchanged.sort() };
}

export interface PurgeCounts {
  edges: number;
  unresolved: number;
  chain: number;
  cfg: number;
  files: number;
}

/**
 * Remove everything the changed and deleted files claimed (R28).
 *
 * Nodes survive. So do edges *into* the changed file from files that did not
 * change: those rows are owned by the caller's file, not the callee's, and
 * they are still true until that caller is itself re-indexed.
 */
export function purgeByProvenance(
  store: FactStore, repoId: number, paths: string[],
  evidenceKinds: EvidenceKind[] = STATIC_EVIDENCE,
): PurgeCounts {
  const counts: PurgeCounts = { edges: 0, unresolved: 0, chain: 0, cfg: 0, files: 0 };

  for (const path of paths) {
    const file = store.getFile(repoId, path);
    if (!file) continue;
    counts.edges += store.deleteEdgesByProvenance(file.id, evidenceKinds);
    counts.unresolved += store.deleteUnresolvedByProvenance(file.id);
    counts.chain += store.deleteChainByProvenance(file.id, evidenceKinds);
    counts.cfg += store.deleteCfgByProvenance(file.id);
    counts.files += 1;
  }
  return counts;
}

/**
 * Drop the `files` rows for paths that no longer exist.
 *
 * Runs *after* `purgeByProvenance`, and only for deletions. The row itself has
 * to go — otherwise the next diff keeps reporting the file as deleted forever
 * — but its dependent rows must be gone first, by provenance, so the deletion
 * is the same operation a re-index performs rather than a cascade.
 */
export function forgetDeletedFiles(store: FactStore, repoId: number, paths: string[]): number {
  let n = 0;
  for (const path of paths) {
    const file = store.getFile(repoId, path);
    if (!file) continue;
    store.raw().prepare("DELETE FROM files WHERE id = ?").run(file.id);
    n += 1;
  }
  return n;
}

/**
 * Which derivations need re-running (R29).
 *
 * Coarse on purpose. `CALLS` is derived from a whole-index interval walk, so
 * one changed file re-runs it for the repo; splitting that per-file would
 * require SCIP to produce a per-file index, which it does not. The
 * cross-service linker re-runs whenever *any* repo changed, because its input
 * is the union of every service's routes.
 */
export interface DerivationPlan {
  scip: boolean;
  treesitter: boolean;
  boot: boolean;
  crossService: boolean;
  reason: string;
}

export function planDerivations(change: ChangeSet, force = false): DerivationPlan {
  const touched = change.changed.length + change.deleted.length;
  if (force) {
    return { scip: true, treesitter: true, boot: true, crossService: true, reason: "forced" };
  }
  if (touched === 0) {
    return {
      scip: false, treesitter: false, boot: false, crossService: false,
      reason: "no file changed",
    };
  }
  return {
    scip: true, treesitter: true, boot: true, crossService: true,
    reason: `${change.changed.length} changed, ${change.deleted.length} deleted`,
  };
}
