-- ===========================================================================
-- 008_co_changed  —  task P3-T1  (requirement R65)
-- ===========================================================================
-- Files that change together, from `git log`.
--
-- The plan calls this "the one v2 association type worth building", and the
-- reason it survived the cull is that it is DERIVED FROM EVIDENCE rather than
-- from a model's opinion: two files appeared in N of the same commits, which is
-- a fact about the repository's history and is checkable by anyone with `git`.
-- The 20 other v2 relationship types were dropped because nothing produced
-- them.
--
-- **It is a ranking signal and nothing else.** Two files that change together
-- may share a real coupling, or may simply both be touched by whoever does the
-- release bumps. Nothing in this table is evidence that A depends on B, and no
-- traversal joins it — it reorders results the graph already found.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS co_changed (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  -- Ordered lexicographically so a pair is stored once, not twice. Without it
  -- (a,b) and (b,a) are two rows and every count is silently doubled.
  file_a       TEXT NOT NULL,
  file_b       TEXT NOT NULL,
  commits      INTEGER NOT NULL,
  -- commits(a,b) / commits(a). Directional: a small file that always ships
  -- with a large one has a high score toward it and a low one back.
  support_a    REAL NOT NULL,
  support_b    REAL NOT NULL,
  last_commit  TEXT,
  last_date    TEXT,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  UNIQUE (repo_id, file_a, file_b),
  CHECK (file_a < file_b)
);

CREATE INDEX IF NOT EXISTS idx_cochanged_a ON co_changed(repo_id, file_a, commits DESC);
CREATE INDEX IF NOT EXISTS idx_cochanged_b ON co_changed(repo_id, file_b, commits DESC);
