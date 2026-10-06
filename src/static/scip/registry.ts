// ============================================================================
// Indexer registry  —  task P3-T5  (requirement R69)
// ============================================================================
// "Additional languages via the SCIP indexer ecosystem", and the acceptance
// criterion is the reason this is a registry rather than a longer ternary:
// *a new language joins the same `nodes` table with no schema change*. SCIP is
// SCIP, so the reader, the normalizer and every query are already
// language-agnostic. The only per-language facts are which binary to run and
// how it is told what to index.
//
// **What this fixes today, before any new language exists.** The dispatch was
//
//     repo.lang === "py" ? runScipPython(...) : runScipTypescript(...)
//
// so EVERY lang that is not `py` got scip-typescript. Add `lang: "go"` to the
// config and the engine would generate a tsconfig, run a TypeScript indexer
// over Go source, write an index describing almost nothing, and report a
// service with no symbols and no reason given. That is the confident fictional
// architecture this project exists to stop shipping (M7, D6) — reached by
// adding one line to a config file.
//
// So an unknown language is now a named refusal, and the refusal lists what IS
// supported.
//
// **`verified` is not decoration.** An adapter is verified when this repo has
// run it against a real repository and ingested the result. `ts`/`js` and `py`
// are; the rest are command strings transcribed from their projects' own
// documentation and never executed here. Reporting them as equal would be the
// same mistake as reporting an inferred edge as certain, so the CLI prints the
// distinction and `index` refuses to treat an unverified run as routine.
// ============================================================================

import { spawnSync } from "node:child_process";
import type { Lang, RepoConfig } from "../../config/repos.ts";
import {
  indexerEnv, runScipPython, runScipTypescript, type IndexResult,
} from "./runner.ts";

export interface IndexerAdapter {
  lang: Lang;
  /** Display name, and the binary the probe looks for. */
  name: string;
  /** Whether this repo has ever produced an ingested index with it. */
  verified: boolean;
  /** How the declared file set is enforced — it differs, and a reader needs it. */
  fileSetNote: string;
  /** Printed when the binary is absent. Nothing is installed automatically. */
  install: string;
  run: (repo: RepoConfig, out: string) => IndexResult;
}

/**
 * A language this engine has no adapter for is not an error in itself — it is
 * a declared gap, and `scip index` says so by name.
 */
export const ADAPTERS: readonly IndexerAdapter[] = [
  {
    lang: "ts",
    name: "scip-typescript",
    verified: true,
    fileSetNote: "generated tsconfig, then removed",
    install: "npm i -D @sourcegraph/scip-typescript",
    run: (repo, out) => runScipTypescript(repo, out, { maxOldSpaceMb: 8192 }),
  },
  {
    lang: "js",
    name: "scip-typescript",
    verified: true,
    fileSetNote: "generated tsconfig with allowJs, then removed",
    install: "npm i -D @sourcegraph/scip-typescript",
    run: (repo, out) => runScipTypescript(repo, out, { maxOldSpaceMb: 8192 }),
  },
  {
    lang: "py",
    name: "scip-python",
    verified: true,
    fileSetNote: "enforced at ingest — this indexer takes no config",
    install: "npm i -D @sourcegraph/scip-python",
    run: (repo, out) => runScipPython(repo, out),
  },
] as const;

export function adapterFor(lang: Lang): IndexerAdapter | null {
  return ADAPTERS.find((a) => a.lang === lang) ?? null;
}

/** Languages with an adapter, for an error message that is actionable. */
export const supportedLangs = (): Lang[] => ADAPTERS.map((a) => a.lang);

export interface Availability {
  available: boolean;
  /** The version string the binary reported, when it ran. */
  version: string | null;
  /** Why it is unavailable. Empty when it is. */
  reason: string;
}

/**
 * Is the indexer actually installed?
 *
 * Asked separately from running it because "the binary is missing" and "it ran
 * and found nothing" are different answers and only one of them is about the
 * code. Conflating them is how a missing toolchain becomes a service that
 * looks like it has no functions.
 */
export function probe(adapter: IndexerAdapter, repo?: RepoConfig): Availability {
  // The SAME PATH the runner will use. A probe that searched a narrower one
  // reported every installed indexer as missing — a refusal worse than the
  // silent wrong graph it exists to prevent.
  const r = spawnSync(`${adapter.name} --version`, {
    encoding: "utf8", shell: true, timeout: 60_000, env: indexerEnv(repo),
  });
  if (r.error) return { available: false, version: null, reason: r.error.message };
  if (r.status !== 0) {
    return {
      available: false,
      version: null,
      reason: (r.stderr || r.stdout || `exited ${r.status}`).trim().split("\n")[0] ?? "",
    };
  }
  return {
    available: true,
    version: (r.stdout || "").trim().split("\n")[0] ?? null,
    reason: "",
  };
}
