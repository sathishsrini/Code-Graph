-- ===========================================================================
-- 009_search  —  task P3-T3  (requirements R43, R67)
-- ===========================================================================
-- FTS5 over the things a person names when describing a workflow: symbols,
-- routes and files.
--
-- **Not external-content, deliberately.** The facilitator port this is based on
-- declared `content=''` without `content_rowid`, which makes the table
-- contentless — `snippet()` and every column read then return nothing, and it
-- fails silently rather than erroring (plan §5). A plain FTS5 table duplicates
-- the indexed text and is a few hundred KB on this corpus. That is the correct
-- trade at this size, and the reason is written down so nobody "optimises" it
-- back into the broken form.
--
-- **This is stage 1 of R43, and stage 1 only.** It picks candidate SEEDS from
-- a fuzzy phrase. Everything after the seed — the flow, the chain, the call
-- tree — is the deterministic query engine. A search result never becomes an
-- answer; it becomes the starting node of one, and the user is shown which
-- seed was chosen so they can correct it.
-- ===========================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  -- What was matched, so a hit can be resolved back to a node.
  node_key    UNINDEXED,
  kind        UNINDEXED,
  -- The searchable columns. Weighted at query time via bm25(), not here.
  name,
  qualified,
  signature,
  doc,
  path,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- FTS5 tables cannot carry ordinary indexes or foreign keys, so provenance for
-- the delete-and-rebuild lives beside it. Rebuilt wholesale per run: an
-- incremental FTS5 delete needs the exact original row text, and getting that
-- subtly wrong leaves stale rows that outrank the live ones forever.
CREATE TABLE IF NOT EXISTS search_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  built_at    TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  run_id      INTEGER REFERENCES runs(id)
);

-- R67's optional embeddings, for the same seeds. Populated ONLY when the
-- search build is given an EmbeddingProvider (P3-T3 `src/retrieval/vector-store.ts`);
-- with none configured it stays empty and the workflow reports which signal
-- it actually had. The BLOB is the packed bytes of a Float32Array, which is
-- what the route between FTS5 (ranked) and vector search (ranked) feeds
-- into the RRF merge.
CREATE TABLE IF NOT EXISTS search_vectors (
  node_key TEXT PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('symbol', 'route', 'file')),
  vector   BLOB NOT NULL,
  built_at TEXT NOT NULL
);
