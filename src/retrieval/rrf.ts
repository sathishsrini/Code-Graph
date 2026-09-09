// ============================================================================
// Reciprocal Rank Fusion  —  task P3-T3  (requirement R43)
// ============================================================================
// Ported from `D:\facilitator\src\retrieval\rrf.ts`, which plan §5 rated "port
// as-is". The algorithm is unchanged; the types are this project's.
//
//   RRF(d) = Σ 1 / (k + rank_i(d))
//
// **Rank only, never raw scores.** FTS5 returns BM25 — negative, unbounded,
// corpus-dependent, lower is better. A vector search returns cosine — bounded
// 0..1, higher is better. Putting those on a common scale means inventing a
// conversion, and the conversion is exactly where a fusion silently starts
// preferring whichever source happens to produce larger numbers. Rank has no
// units, so there is nothing to get wrong.
//
// **A source that did not find a candidate contributes nothing**, rather than
// penalising it. A symbol only the lexical pass saw is not worse than one both
// passes saw; it is a symbol one signal could not see, which is a fact about
// the signal.
//
// **Agreement is the point.** With k = 60 a rank-1 hit contributes 1/61 and a
// rank-10 hit 1/70 — close enough that two sources agreeing outranks one
// source being confident. That is the property fusion exists for.
// ============================================================================

/** One result from one retrieval source, already ranked by that source. */
export interface RrfCandidate {
  /** What was retrieved. Fusion happens on this — here, a `nodes.key`. */
  id: string;
  /** Which signal produced it. Kept for diagnostics, never used for scoring. */
  source: string;
  /**
   * The source's own score. Reported alongside, never fused — and OPTIONAL,
   * because a source with no meaningful score should not have to invent one to
   * take part. Fusion reads rank, so an absent score costs nothing.
   */
  score?: number;
}

export interface RrfMerged {
  id: string;
  rrfScore: number;
  /** Every source that found it — the useful signal when two disagree. */
  sources: string[];
  /** How many sources found it. `sources.length`, named for what it means. */
  retrievalCount: number;
  /** Best (lowest) rank per source, 1-based. */
  ranks: Record<string, number>;
}

/** The constant from the original paper, and what facilitator used. */
export const DEFAULT_RRF_K = 60;

export function applyRRF(
  resultSets: RrfCandidate[][], k: number = DEFAULT_RRF_K,
): RrfMerged[] {
  const merged = new Map<string, RrfMerged>();

  for (const results of resultSets) {
    for (let i = 0; i < results.length; i += 1) {
      const candidate = results[i]!;
      const rank = i + 1;                     // 1-based; rank 0 would over-weight
      const contribution = 1 / (k + rank);
      const existing = merged.get(candidate.id);

      if (!existing) {
        merged.set(candidate.id, {
          id: candidate.id,
          rrfScore: contribution,
          sources: [candidate.source],
          retrievalCount: 1,
          ranks: { [candidate.source]: rank },
        });
        continue;
      }

      existing.rrfScore += contribution;
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
        existing.retrievalCount += 1;
      }
      // Keep the BEST rank a source gave, not the last one seen: a source that
      // returns a candidate twice should not be able to worsen it.
      const previous = existing.ranks[candidate.source];
      if (previous === undefined || rank < previous) {
        existing.ranks[candidate.source] = rank;
      }
    }
  }

  return [...merged.values()].sort((a, b) =>
    b.rrfScore - a.rrfScore ||
    // A tie broken by source count prefers what two signals agreed on, which
    // is more informative than either signal's own ordering.
    b.retrievalCount - a.retrievalCount ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
