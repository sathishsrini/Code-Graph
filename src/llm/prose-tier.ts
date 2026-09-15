// ============================================================================
// Model prose, for a context pack  —  task P3-T10  (R83, under R62/R63)
// ============================================================================
// R62 permits the model to explain a function. R63 forbids its output ever
// being read as fact, and enforces that STRUCTURALLY rather than by convention:
// model output lands in one table, and no module under `src/query/` may
// reference it. `tests/summaries.test.ts` greps every query source for that
// table's name and requires zero matches.
//
// So this module exists on THIS side of the line. `feature-pack.ts` declares
// the `ProseNote` type and accepts notes through an option; the reader that
// produces them lives here, next to the write path, and imports the type
// upward. The dependency therefore points from the LLM layer at the query
// layer and never back — the packer has no code path to this cache even if
// someone wanted one, the same way `writeSummary` takes no `GraphWriter`.
//
// The label is carried by the TYPE, not by a string a renderer might forget:
// `ProseNote` is not a `FeatureItem` and cannot enter `pack.items`, so mixing
// a paraphrase into the extracted rows is a compile error rather than a review
// miss.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import type { ProseNote } from "../query/feature-pack.ts";
import { type SummaryKind } from "./summaries.ts";

const DEFAULT_KINDS: SummaryKind[] = ["function", "module", "service"];

/**
 * The cached prose for these nodes, newest generation per node.
 *
 * Cache-only: this never invokes a model. A pack must not stall on weight
 * loading, and generation is `summaries generate`'s job — a context query that
 * silently triggers a download is a query nobody can budget for.
 */
export function collectProse(
  store: FactStore, nodeKeys: string[], kinds: SummaryKind[] = DEFAULT_KINDS,
): ProseNote[] {
  const keys = [...new Set(nodeKeys)].filter(Boolean);
  if (keys.length === 0 || kinds.length === 0) return [];

  const keyMarks = keys.map(() => "?").join(", ");
  const kindMarks = kinds.map(() => "?").join(", ");
  const rows = store.raw().prepare(
    `SELECT node_key, kind, summary, model, provider, generated_at
       FROM summaries
      WHERE node_key IN (${keyMarks}) AND kind IN (${kindMarks})
      ORDER BY generated_at DESC, id DESC`,
  ).all(...keys, ...kinds) as Array<Record<string, string>>;

  const seen = new Set<string>();
  const notes: ProseNote[] = [];
  for (const r of rows) {
    // One note per (node, kind): the table keeps every input hash, and showing
    // three paraphrases of one function is three chances to believe one.
    const dedupe = `${r["node_key"]}${r["kind"]}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    notes.push({
      about: String(r["node_key"]),
      scope: String(r["kind"]),
      text: String(r["summary"]),
      model: String(r["model"]),
      provider: String(r["provider"]),
      generatedAt: String(r["generated_at"]),
      origin: "model-generated",
    });
  }
  return notes;
}
