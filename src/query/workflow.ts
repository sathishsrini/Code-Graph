// Stage-1 fuzzy seed resolution (P3-T3, R43) over a prebuilt FTS5 search table.
//
// Everything below Search here is the deterministic query engine (R66); this
// module answers one question only: "given a fuzzy phrase, which seed could
// this start from?" via three hand-picked lexical aspects of the indexed text
// — the individual tokens AND-ed together, the whole phrase fused into a single
// token (so `checkUserAuth`, which FTS5 reads as one token, still matches
// "check user auth"), and that fused token as a prefix for partial spellings —
// optionally fused with R67 cosine vectors.
//
// The lexical and vector signals are merged by reciprocal rank fusion, not by
// averaging scores: compatibility across representations is the evidence a
// seed is real, and one signal must never be buried under another's magnitude.

import type { FactStore } from "../store/db.ts";
import { applyRRF, type RrfCandidate, type RrfMerged } from "../retrieval/rrf.ts";
import { fromBlob, VectorIndex, type EmbeddingProvider } from "../retrieval/vector-store.ts";
import { parseRouteKey } from "../normalize/keys.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

export interface SearchCandidate {
  /** Canonical `nodes.key` the search converged on. */
  nodeKey: string;
  kind: "symbol" | "route" | "file";
  /** Human-facing display for seeding the CLI / UI. */
  display: string;
  /** Owner context — file path for a symbol, service for a route, repo for a file. */
  where: string;
  /** RRF composite, used ONLY to order candidates within this page. */
  score: number;
  /** Which signals contributed, e.g. `["lexical"]` or `["lexical","vector:m3"]`. */
  sources: string[];
  /** Best lexical signal (negated bm25, so higher = better). Null when absent. */
  bm25: number | null;
  /** Cosine when a vector contributed. Never compared with bm25. */
  cosine: number | null;
}

export type FollowQuery =
  | { query: "endpoint_flow"; service: string; method: string; url: string }
  | { query: "impact"; seed: string };

export interface SearchOutput {
  phrase: string;
  correctedSeed: string | null;
  notBuilt: boolean;
  candidates: SearchCandidate[];
  chosen: SearchCandidate | null;
  follow: FollowQuery | null;
  reason: string;
}

export interface SearchOptions {
  topK?: number;
  /** A node key supplied by the user as an explicit correction. */
  correctedSeed?: string;
  /** Same EmbeddingProvider the index was built with, when vectors exist (R67). */
  embeddings?: EmbeddingProvider | null;
}

const RRF_K = 60;
const DEFAULT_TOP_K = 8;

export function searchIndexState(store: FactStore): "not-built" | "built" {
  const row = store
    .raw()
    .prepare(`SELECT 1 AS n FROM search_meta WHERE id = 1 AND rows > 0`)
    .get();
  return row ? "built" : "not-built";
}

// ---------------------------------------------------------------------------
// lexical
// ---------------------------------------------------------------------------

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokensOf(phrase: string): string[] {
  return (phrase.match(TOKEN_RE) ?? []).filter((t) => t.length > 0);
}

function ftsQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

interface LexHit {
  nodeKey: string;
  kind: string;
  bm25: number;
  aspects: string[]; // which of the three lexical aspects matched
}

function lexicalCandidates(store: FactStore, phrase: string, limit: number): RrfCandidate[] {
  const tokens = tokensOf(phrase);
  if (tokens.length === 0) return [];

  const squash = tokens.join("").toLowerCase();
  const queries: Array<{ aspect: string; sql: string }> = [
    { aspect: "and", sql: tokens.map(ftsQuote).join(" AND ") },
    { aspect: "phrase", sql: ftsQuote(squash) },
    { aspect: "prefix", sql: `${squash}*` },
  ];

  const db = store.raw();
  const hits = new Map<string, LexHit>();
  const stmt = db.prepare(
    `SELECT node_key, kind, bm25(search) AS bm FROM search WHERE search MATCH ? ORDER BY bm LIMIT ?`,
  );
  for (const q of queries) {
    let rows: Array<{ node_key: string; kind: string; bm: number }>;
    try {
      rows = stmt.all(q.sql, limit) as Array<{ node_key: string; kind: string; bm: number }>;
    } catch {
      continue; // a jump in MATCH syntax must not sink the whole question
    }
    for (const r of rows) {
      const cur = hits.get(r.node_key);
      if (!cur) {
        hits.set(r.node_key, { nodeKey: r.node_key, kind: r.kind, bm25: r.bm, aspects: [q.aspect] });
      } else {
        cur.bm25 = Math.min(cur.bm25, r.bm); // best (most negative) across aspects
        cur.aspects.push(q.aspect);
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => a.bm25 - b.bm25 || (a.nodeKey < b.nodeKey ? -1 : 1))
    .slice(0, limit)
    .map((h) => ({
      id: h.nodeKey,
      // Conservative label: which aspects were involved in the winning row.
      source: `lexical:${[...new Set(h.aspects)].sort().join("+")}`,
      score: h.bm25, // raw bm25 kept as diagnostic; RRF uses rank, not this
    }));
}

// ---------------------------------------------------------------------------
// vector (R67, only when the build was given a provider)
// ---------------------------------------------------------------------------

function vectorCandidates(
  store: FactStore,
  phrase: string,
  embeddings: EmbeddingProvider | null,
  limit: number,
): RrfCandidate[] {
  if (!embeddings) return [];
  const db = store.raw();
  const rows = db
    .prepare(`SELECT node_key, vector FROM search_vectors`)
    .all() as Array<{ node_key: string; vector: Uint8Array }>;
  if (rows.length === 0) return [];

  const idx = new VectorIndex();
  for (const r of rows) idx.upsert(r.node_key, fromBlob(r.vector));

  const q = embeddings.embed(phrase);
  if (q.length !== embeddings.dimension) {
    throw new Error(
      `EmbeddingProvider "${embeddings.name}" returned ${q.length} dims for the phrase, expected ${embeddings.dimension}`,
    );
  }
  return idx
    .search(q, limit)
    // Cosine <= 0 is "the provider has no evidence either way" — including it
    // would rank a genuinely-orthogonal row above nothing and let RRF count a
    // neutral as corroboration.
    .filter((h) => h.score > 0)
    .map((h) => ({
      id: h.id,
      source: `vector:${embeddings.name}`,
      score: h.score,
    }));
}

// ---------------------------------------------------------------------------
// identification
// ---------------------------------------------------------------------------

function nodeKind(store: FactStore, key: string): string | null {
  const r = store.raw().prepare(`SELECT kind FROM nodes WHERE key = ?`).get(key) as
    | { kind: string }
    | undefined;
  return r?.kind ?? null;
}

function identify(store: FactStore, nodeKey: string, kind: string): SearchCandidate | null {
  const db = store.raw();
  if (kind === "symbol") {
    const s = db
      .prepare(
        `SELECT s.display_name, f.path AS file
           FROM nodes n
           LEFT JOIN symbols s ON s.node_id = n.id
           LEFT JOIN files f ON f.id = s.file_id
          WHERE n.key = ?`,
      )
      .get(nodeKey) as { display_name: string | null; file: string | null } | undefined;
    return {
      nodeKey,
      kind,
      display: s?.display_name ?? displayNameOf(nodeKey),
      where: s?.file ?? "",
      score: 0,
      sources: [],
      bm25: null,
      cosine: null,
    };
  }
  if (kind === "route") {
    const r = db
      .prepare(
        `SELECT r.service_name, r.method, r.url
           FROM nodes n
           JOIN routes r ON r.node_id = n.id
          WHERE n.key = ?`,
      )
      .get(nodeKey) as { service_name: string; method: string; url: string } | undefined;
    if (!r) return null;
    return {
      nodeKey,
      kind,
      display: `${r.method.toUpperCase()} ${r.url}`,
      where: r.service_name,
      score: 0,
      sources: [],
      bm25: null,
      cosine: null,
    };
  }
  if (kind === "file") {
    const slash = nodeKey.lastIndexOf("/");
    return {
      nodeKey,
      kind,
      display: slash >= 0 ? nodeKey.slice(slash + 1) : nodeKey,
      where: slash >= 0 ? nodeKey.slice(0, slash) : "",
      score: 0,
      sources: [],
      bm25: null,
      cosine: null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

export function followOf(c: SearchCandidate): FollowQuery | null {
  if (c.kind === "route") {
    const parsed = parseRouteKey(c.nodeKey);
    if (!parsed) return null;
    return { query: "endpoint_flow", service: parsed.service, method: parsed.method, url: parsed.url };
  }
  if (c.kind === "symbol" || c.kind === "file") {
    return { query: "impact", seed: c.nodeKey };
  }
  return null;
}

export function search(store: FactStore, phrase: string, options: SearchOptions = {}): SearchOutput {
  const correctedSeed = options.correctedSeed ?? null;
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const embeddings = options.embeddings ?? null;

  if (searchIndexState(store) === "not-built") {
    return {
      phrase,
      correctedSeed,
      notBuilt: true,
      candidates: [],
      chosen: null,
      follow: null,
      reason: "no prebuilt search index (search_meta empty) — run `node src/cli.ts search build`",
    };
  }

  const noise = tokensOf(phrase);
  if (noise.length === 0 && !correctedSeed) {
    return {
      phrase,
      correctedSeed,
      notBuilt: false,
      candidates: [],
      chosen: null,
      follow: null,
      reason: "nothing but punctuation to search on",
    };
  }

  const lex = lexicalCandidates(store, phrase, topK * 4);
  const vec = vectorCandidates(store, phrase, embeddings, topK);

  const sets: RrfCandidate[][] = [];
  if (lex.length > 0) sets.push(lex);
  if (vec.length > 0) sets.push(vec);
  const merged: RrfMerged[] = sets.length > 0 ? applyRRF(sets, RRF_K) : [];

  // Attach identity + merged metadata to the top candidates.
  const candidates: SearchCandidate[] = [];
  for (const m of merged.slice(0, topK)) {
    const kind = nodeKind(store, m.id);
    if (!kind) continue; // a stale search row without a live node is not a seed
    const c = identify(store, m.id, kind);
    if (!c) continue;
    c.sources = m.sources;
    c.score = m.rrfScore;
    const hasLex = m.sources.some((s) => s.startsWith("lexical"));
    const hasVec = m.sources.some((s) => s.startsWith("vector"));
    if (hasLex) {
      const raw = lex.find((l) => l.id === m.id);
      c.bm25 = raw?.score ?? null;
    }
    if (hasVec) {
      const raw = vec.find((v) => v.id === m.id);
      c.cosine = raw?.score ?? null;
    }
    candidates.push(c);
  }
  candidates.sort((a, b) => b.score - a.score || (a.nodeKey < b.nodeKey ? -1 : 1));

  // --- explicit correction path ---------------------------------------------
  if (correctedSeed) {
    const kind = nodeKind(store, correctedSeed);
    if (kind === null) {
      return {
        phrase,
        correctedSeed,
        notBuilt: false,
        candidates,
        chosen: null,
        follow: null,
        reason: `"${correctedSeed}" is not a node in the store — nothing corrected`,
      };
    }
    const chosen = identify(store, correctedSeed, kind);
    if (!chosen) {
      return {
        phrase,
        correctedSeed,
        notBuilt: false,
        candidates,
        chosen: null,
        follow: null,
        reason: `"${correctedSeed}" resolved to a node that lost its detail row — nothing corrected`,
      };
    }
    chosen.sources = ["user-seed"];
    chosen.score = Number.POSITIVE_INFINITY;
    return {
      phrase,
      correctedSeed,
      notBuilt: false,
      candidates,
      chosen,
      follow: followOf(chosen),
      reason: `corrected from "${phrase}" to ${chosen.nodeKey}`,
    };
  }

  if (candidates.length === 0) {
    return {
      phrase,
      correctedSeed,
      notBuilt: false,
      candidates,
      chosen: null,
      follow: null,
      reason: `nothing in the index matched "${phrase}"`,
    };
  }

  const chosen = candidates[0]!;
  return {
    phrase,
    correctedSeed,
    notBuilt: false,
    candidates,
    chosen,
    follow: followOf(chosen),
    reason: `seed → ${chosen.nodeKey}`,
  };
}