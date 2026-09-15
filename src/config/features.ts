// ============================================================================
// Reviewed feature manifest  —  task P3-T8  (requirement R81)
// ============================================================================
// A business feature is a name people use that the code does not contain.
//
// That is not a hypothesis. On this corpus `search("GRN creation")` matches
// nothing at all — the `and` aspect needs every token and no indexed row
// contains "creation" — and bare `search("grn")` returns 29 rows whose top 19
// are Next.js form-field variables (`grn_number0`, `remarks1`, …), putting the
// six routes actually named `/api/v1/grn` at ranks 20-29, below the default
// top-K of 8. The router's handler is the generic `proxyToEngine`, shared by
// fifteen routes; the engine's is anonymous. **The only place the feature is
// named is the URL.** Lexical search cannot get there, and no amount of
// ranking tuning changes that.
//
// So a human writes it down. Entries are VERBATIM node keys — copied from
// `search --json`, never composed — which is the same rule as everywhere else
// in this codebase: identity comes from SCIP and the boot dump, and inventing
// a key beside them is the second-identity-system failure this project exists
// to avoid.
//
// **No table, deliberately.** The working rule is "no table or column without
// an extractor that fills it this week", and there is no extractor here by
// construction: a person writes this file after reviewing the graph. Reading
// it at query time keeps one source of truth, needs no reindex to add a
// feature, and costs one parse of a short file per call. `features check`
// covers the only real risk, which is an entry going stale.
//
// This module writes no facts. It resolves nothing — it hands specs to
// `resolveSeed`, which is the thing that knows what a node is.
// ============================================================================

import { readFileSync } from "node:fs";

export interface FeatureEntry {
  kind: "route" | "symbol" | "file";
  /** Verbatim, exactly as written in the manifest. */
  spec: string;
  /** 1-based line, so `features check` can point at the row to fix. */
  line: number;
}

export interface FeatureDef {
  id: string;
  name: string;
  aliases: string[];
  /** Declaration order is seed priority. */
  entries: FeatureEntry[];
  notes: string | null;
  line: number;
}

export interface FeatureManifest {
  path: string;
  /** False when the file does not exist. Not an error — a manifest is optional. */
  present: boolean;
  features: FeatureDef[];
}

export const DEFAULT_FEATURES_PATH = "rules/features.yml";

const LIST_KEYS = new Set(["aliases", "routes", "symbols", "files"]);
const SCALAR_KEYS = new Set(["name", "notes"]);
const KIND_OF: Record<string, FeatureEntry["kind"]> = {
  routes: "route", symbols: "symbol", files: "file",
};

/**
 * Parse the fixed YAML subset this file uses — the same approach as
 * `loadCheckKindRules`, and for the same reason: a general YAML dependency to
 * read a forty-line file is a dependency that buys nothing.
 *
 * **One departure from `check-kinds.yml` that matters.** Its list values are
 * matched with `[A-Za-z0-9_$.-]+`, which rejects every route key (spaces and
 * slashes) and every SCIP symbol (backticks, spaces, parentheses). List values
 * here are therefore taken VERBATIM to end of line. The cost is that a value
 * may not contain ` #`, since that is still stripped as a trailing comment.
 */
export function loadFeatures(path: string): FeatureManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // A missing manifest is a state, not a failure: the feature pack falls
    // back to search and says in its output that it did.
    return { path, present: false, features: [] };
  }

  const features: FeatureDef[] = [];
  let current: FeatureDef | null = null;
  let list: string | null = null;
  let sawRoot = false;

  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    if (line === "features:") { sawRoot = true; current = null; list = null; continue; }

    const id = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
    if (id) {
      current = {
        id: id[1]!, name: id[1]!, aliases: [], entries: [], notes: null, line: lineNo,
      };
      features.push(current);
      list = null;
      continue;
    }

    const listHeader = /^ {4}([a-z]+):$/.exec(line);
    if (listHeader && current && LIST_KEYS.has(listHeader[1]!)) {
      list = listHeader[1]!;
      continue;
    }

    const scalar = /^ {4}([a-z]+): (.+)$/.exec(line);
    if (scalar && current && SCALAR_KEYS.has(scalar[1]!)) {
      if (scalar[1] === "name") current.name = scalar[2]!.trim();
      else current.notes = scalar[2]!.trim();
      list = null;
      continue;
    }

    // Verbatim to end of line — see the note above.
    const item = /^ {6}- (.+)$/.exec(line);
    if (item && current && list) {
      const value = item[1]!.trim();
      if (list === "aliases") current.aliases.push(value);
      else current.entries.push({ kind: KIND_OF[list]!, spec: value, line: lineNo });
      continue;
    }

    throw new Error(`invalid ${path} at line ${lineNo}: ${raw}`);
  }

  if (!sawRoot && features.length === 0) {
    throw new Error(`${path} has no 'features:' block`);
  }
  return { path, present: true, features };
}

// ---------------------------------------------------------------------------

/** Lowercase alphanumeric tokens — so "GRN creation" and "grn-creation" agree. */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export interface FeatureMatch {
  feature: FeatureDef;
  how: "id" | "name" | "alias" | "tokens";
}

/**
 * Which feature a phrase names, if any.
 *
 * Exact id, name and alias first; then a token-subset match, so "create a GRN"
 * still reaches the `create grn` alias. Nothing fuzzier than that on purpose —
 * an unmatched phrase falls through to `search()`, and the pack SAYS which of
 * the two answered. A manifest that guesses would be worse than one that
 * misses, because a miss is visible and a wrong match is not.
 */
export function matchFeature(
  manifest: FeatureManifest, phrase: string,
): FeatureMatch | null {
  const want = tokens(phrase);
  if (want.length === 0) return null;
  const key = want.join(" ");

  for (const feature of manifest.features) {
    if (tokens(feature.id).join(" ") === key) return { feature, how: "id" };
  }
  for (const feature of manifest.features) {
    if (tokens(feature.name).join(" ") === key) return { feature, how: "name" };
  }
  for (const feature of manifest.features) {
    if (feature.aliases.some((a) => tokens(a).join(" ") === key)) {
      return { feature, how: "alias" };
    }
  }

  // Every token of some label is present in the phrase. Longest label wins, so
  // a two-word alias beats a one-word one rather than whichever came first.
  let best: FeatureMatch | null = null;
  let bestLength = 0;
  const seen = new Set(want);
  for (const feature of manifest.features) {
    for (const label of [feature.name, feature.id, ...feature.aliases]) {
      const need = tokens(label);
      if (need.length === 0 || need.length <= bestLength) continue;
      if (need.every((t) => seen.has(t))) {
        best = { feature, how: "tokens" };
        bestLength = need.length;
      }
    }
  }
  return best;
}
