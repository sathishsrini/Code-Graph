// ============================================================================
// Freshness  —  slice CTX-S6  (plans/claude-context-plan.md §9, "Stale graph")
// ============================================================================
// The graph is built once and read for days while the code moves on. An answer
// about a file edited since the build is a confident wrong answer unless it
// says so, so every MCP answer carries one line: when the graph was built, and
// which indexed files no longer match it.
//
// Two rules keep that line honest:
//
//   1. The comparison is the incremental indexer's own (R27): the stored
//      `files.content_sha256` against `hashText` of the file read as UTF-8,
//      exactly as `indexRepo` computes it. A second hash would disagree with
//      the indexer on some file and report it stale forever.
//   2. A repo whose root is not on disk is NAMED, never counted as "every file
//      changed". The graph may be read on a machine without the corpus
//      mounted, and "cannot check" is a different fact from "is stale".
//
// Cost: one read and one SHA-256 per indexed file, per call, no cache.
// Measured 0.25 ms per call on the orders_app fixture (14 files, 5.9 KB);
// the corpus has 15 files. A cache would have to be invalidated by the very
// edits it exists to detect, so it is added only if a measurement asks.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactStore } from "../store/db.ts";
import { hashText } from "./incremental.ts";

export interface StaleFile {
  repo: string;
  /** Repo-relative, as `files.path` stores it. */
  path: string;
  /** `unreadable`: on disk but could not be read, so it cannot be compared. */
  state: "changed" | "deleted" | "unreadable";
}

export interface Freshness {
  /** Last finished static run, ISO-8601 UTC. Null when nothing was built. */
  builtAt: string | null;
  /** Indexed files whose hash was compared. */
  files: number;
  stale: StaleFile[];
  /** Repos whose root is not on disk: their files were not compared. */
  unchecked: Array<{ repo: string; root: string; files: number }>;
}

/** Compare every indexed file against its stored hash. */
export function checkFreshness(store: FactStore): Freshness {
  const db = store.raw();
  const built = db.prepare(
    "SELECT MAX(finished_at) AS at FROM runs WHERE channel = 'static'",
  ).get() as { at: string | null };

  const rows = db.prepare(
    `SELECT r.name AS repo, r.root_path AS root, f.path AS path, f.content_sha256 AS sha
       FROM files f JOIN repos r ON r.id = f.repo_id
      ORDER BY r.name, f.path`,
  ).all() as Array<{ repo: string; root: string; path: string; sha: string }>;

  const result: Freshness = {
    // SQLite's datetime('now') is UTC without a zone; say so in the value.
    builtAt: built.at ? `${built.at.replace(" ", "T")}Z` : null,
    files: 0, stale: [], unchecked: [],
  };
  const rootOnDisk = new Map<string, boolean>();

  for (const row of rows) {
    if (!rootOnDisk.has(row.repo)) rootOnDisk.set(row.repo, existsSync(row.root));
    if (!rootOnDisk.get(row.repo)) {
      const u = result.unchecked.find((x) => x.repo === row.repo);
      if (u) u.files += 1;
      else result.unchecked.push({ repo: row.repo, root: row.root, files: 1 });
      continue;
    }
    result.files += 1;
    const state = compare(join(row.root, row.path), row.sha);
    if (state) result.stale.push({ repo: row.repo, path: row.path, state });
  }
  return result;
}

/**
 * Never throws: a failed freshness check would take the answer with it.
 * The read and the hash are `indexRepo`'s own (pipeline.ts, step 1).
 */
function compare(abs: string, sha: string): StaleFile["state"] | null {
  if (!existsSync(abs)) return "deleted";
  try {
    return hashText(readFileSync(abs, "utf8")) === sha ? null : "changed";
  } catch {
    return "unreadable";
  }
}

/**
 * The one line an answer carries. No commas, so TOON leaves it unquoted.
 *
 * At most `name` files are listed; the count is always exact.
 */
export function freshnessLine(f: Freshness, name = 3): string {
  if (f.builtAt === null && f.files === 0 && f.unchecked.length === 0) {
    return "no build recorded in this graph; run code-intel's build command";
  }
  const parts = [
    `built ${f.builtAt ?? "(unknown)"}`,
    `${f.stale.length} of ${f.files} indexed files changed since`,
  ];
  if (f.stale.length > 0) {
    const listed = f.stale.slice(0, name)
      .map((s) => `${s.repo}/${s.path}${s.state === "changed" ? "" : ` (${s.state})`}`);
    const more = f.stale.length > name ? ` +${f.stale.length - name} more` : "";
    parts[1] += `: ${listed.join(" ")}${more}`;
    parts.push("answers touching them may be stale until the next build");
  }
  if (f.unchecked.length > 0) {
    parts.push(
      `not checked (root not on disk): ${
        f.unchecked.map((u) => `${u.repo} (${u.files} files)`).join(" ")}`,
    );
  }
  return parts.join("; ");
}
