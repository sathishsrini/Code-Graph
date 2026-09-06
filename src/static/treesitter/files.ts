// ============================================================================
// Repo file enumeration  —  task P1-T6
// ============================================================================
// The tree-sitter pass needs the same file set the SCIP indexer was pointed
// at, and for the same reason: `40-kri-router/tsconfig.json` is `{}`, and a
// pass that walked the whole tree would extract findings from `src/**` — a
// non-compiling scaffold that never executes (measurements M7, delta D6).
//
// So enumeration goes through `documentAllowed`, the one predicate that reads
// `repos.json`'s include/exclude. Declaring the file set and enforcing it are
// different things, and only the second one is a defence.
// ============================================================================

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { RepoConfig } from "../../config/repos.ts";
import { documentAllowed } from "../scip/runner.ts";
import { grammarFor } from "./parser.ts";

/** Directories never worth descending into, whatever the config says. */
const ALWAYS_SKIP = new Set([
  "node_modules", ".git", ".next", "__pycache__", ".venv", "venv",
  "dist", "build", "coverage", ".codeintel",
]);

export interface EnumeratedFile {
  /** Repo-relative, forward slashes. Matches `files.path` and SCIP's paths. */
  relativePath: string;
  absolutePath: string;
}

/**
 * Every parseable file in a repo's declared set.
 *
 * `ALWAYS_SKIP` is a traversal optimisation, not a second policy: descending
 * into `node_modules` to then reject each file costs minutes on a real repo.
 * Anything it skips would also have been rejected by `documentAllowed`, and
 * the config is what decides.
 */
export function enumerateFiles(repo: RepoConfig): EnumeratedFile[] {
  const out: EnumeratedFile[] = [];

  const walkDir = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;   // unreadable directory: not a reason to abandon the repo
    }
    for (const name of entries.sort()) {
      if (ALWAYS_SKIP.has(name)) continue;
      const abs = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) { walkDir(abs); continue; }

      const rel = relative(repo.rootPath, abs).split("\\").join("/");
      if (!grammarFor(rel)) continue;
      if (!documentAllowed(repo, rel)) continue;
      out.push({ relativePath: rel, absolutePath: abs });
    }
  };

  walkDir(repo.rootPath);
  // Sorted, so two runs over the same tree produce the same order and the
  // Phase 0 determinism criterion keeps holding as the pass grows.
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
