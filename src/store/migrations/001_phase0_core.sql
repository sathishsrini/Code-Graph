-- ===========================================================================
-- 001_phase0_core  —  tasks P0-T5
-- ===========================================================================
-- The six tables Phase 0 could actually fill: repos, runs, files, nodes,
-- symbols, edges. Shipped verbatim as written for P0-T5, then frozen — a
-- migration is an immutable record of what a database was asked to become.
-- Later shape changes arrive as later migrations, never by editing this file.
--
-- Requirement R72: nothing enters the schema until an extractor produces it.
-- The v1/v2 failure was ~470 lines of DDL for tables nobody could populate.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS repos (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,      -- '40-kri-router'
  root_path    TEXT NOT NULL,
  service_name TEXT
);

-- One row per extractor invocation. `channel` is the trust level of everything
-- the run produced, which is why it is recorded here and not inferred later.
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha  TEXT NOT NULL,              -- '' when the target is not a git repo
  channel     TEXT NOT NULL CHECK (channel IN ('static', 'boot', 'runtime')),
  tool        TEXT NOT NULL,              -- 'scip-typescript@0.4.0'
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo_id, channel, started_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,           -- repo-relative, forward slashes
  lang           TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  last_run_id    INTEGER REFERENCES runs(id),
  UNIQUE (repo_id, path)
);
-- Drives incremental indexing: changed set = hash differs (R27).
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(repo_id, content_sha256);

-- ---------------------------------------------------------------------------
-- Identity — ONE node table. Everything anchors here.
-- ---------------------------------------------------------------------------
-- R4: for kind='symbol', `key` is the VERBATIM SCIP symbol string. Never a
-- composed name. That is what makes identity stable across reindexing and
-- comparable across repos.
--
-- R9: `repo_id` is descriptive, not a scoping key. Node identity is global, so
-- an edge from a symbol in one service to a route in another is an ordinary
-- row — no mapping table.

CREATE TABLE IF NOT EXISTS nodes (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN
            ('service', 'route', 'symbol', 'file', 'external', 'datastore', 'config')),
  key     TEXT NOT NULL,
  repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo_id, kind);

-- Detail table: 1:1 with nodes, keyed BY node id. No parallel id space — the
-- two-identity-systems mistake is what made every v2 query carry a subquery.
CREATE TABLE IF NOT EXISTS symbols (
  node_id           INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  file_id           INTEGER REFERENCES files(id) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  symbol_kind       TEXT,                 -- function|method|class|const|...
  signature         TEXT,
  doc               TEXT,
  start_line        INTEGER,
  end_line          INTEGER,
  enclosing_node_id INTEGER REFERENCES nodes(id),
  is_exported       INTEGER NOT NULL DEFAULT 0,
  is_test           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id, start_line);
CREATE INDEX IF NOT EXISTS idx_symbols_encl ON symbols(enclosing_node_id);

-- ---------------------------------------------------------------------------
-- ONE edge table
-- ---------------------------------------------------------------------------
-- R7: `confidence` is an enum. Never a number, never bridged from one.
-- R8: `evidence_kind` records which channel produced the row, so provenance is
--     structural rather than a column someone remembers to fill.

CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY,
  src_node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN
                  ('CONTAINS', 'CALLS', 'HANDLES', 'REQUESTS', 'READS', 'WRITES',
                   'CALLS_EXTERNAL', 'THROWS', 'READS_CONFIG')),
  confidence    TEXT NOT NULL CHECK (confidence IN
                  ('certain', 'inferred', 'observed', 'unresolved')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN
                  ('scip', 'treesitter', 'semgrep', 'boot', 'otel', 'manual')),
  file_id       INTEGER REFERENCES files(id) ON DELETE CASCADE,  -- provenance owner
  line          INTEGER,
  detail        TEXT,                     -- error name, table name, sql shape...
  run_id        INTEGER NOT NULL REFERENCES runs(id)
);

-- DEVIATION FROM PLAN §H, deliberate.
--
-- The plan specifies UNIQUE (src, dst, type, evidence_kind, file_id, line).
-- In SQLite two NULLs are distinct, so that constraint does not deduplicate
-- boot- or otel-sourced edges, which legitimately have NULL file_id and line.
-- Re-running a boot dump would insert a fresh duplicate row every time.
--
-- COALESCE in an expression index gives the intended semantics: NULL file_id
-- and NULL line each collapse to a single sentinel, so identity is one row.
CREATE UNIQUE INDEX IF NOT EXISTS ux_edges_identity ON edges(
  src_node_id, dst_node_id, type, evidence_kind,
  COALESCE(file_id, -1), COALESCE(line, -1)
);

-- The three indexes that cover ~95% of queries (R10).
CREATE INDEX IF NOT EXISTS idx_edges_out  ON edges(src_node_id, type, confidence);
CREATE INDEX IF NOT EXISTS idx_edges_in   ON edges(dst_node_id, type, confidence);
-- Incremental delete-by-provenance (R28) reads exactly this index.
CREATE INDEX IF NOT EXISTS idx_edges_prov ON edges(file_id, evidence_kind);
