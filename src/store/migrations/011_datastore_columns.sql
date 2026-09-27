-- ===========================================================================
-- 011_datastore_columns  —  slice CTX-S9  (goal G8; requirements R11, R12, R28, R72)
-- ===========================================================================
-- The columns of a table, as the SQL migrations in a repo's declared file set
-- declare them. Producer, in the same commit (R72): src/static/ddl.ts reads
-- CREATE TABLE / ALTER TABLE ADD COLUMN, src/static/ddl-ingest.ts writes the
-- rows, and `index` runs both (src/index/pipeline.ts, step 4c).
--
-- STORAGE DECISION: decided without Jev; owner to confirm with jev_decide.
--
-- The plan (CTX-S9) offered two options: (a) a new `column` node kind, or
-- (b) a detail table keyed by the datastore node id (R12). This is (b). The
-- reasons, each measured on this code on 2026-09-27:
--
--   1. Migration risk. 001 fixes the node kinds with a CHECK, and SQLite
--      cannot alter a CHECK, so (a) means rebuilding `nodes`. Ten columns in
--      six tables reference nodes(id), seven of them ON DELETE CASCADE.
--      src/store/migrate.ts runs each migration inside BEGIN … COMMIT, where
--      `PRAGMA foreign_keys = OFF` is a no-op, so `DROP TABLE nodes` performs
--      an implicit DELETE that cascades. A probe on a scratch store: 2 edges
--      before the rebuild, 0 after, and no error. (a) first needs a
--      no-transaction path in the shared runner.
--   2. R12 says "detail tables keyed by node id; no parallel id space". This
--      is that, 1:N like route_chain (route_node_id) and function_cfg
--      (symbol_node_id).
--   3. Readers. CTX-S10b will join the column names in a SQL literal to the
--      declared columns; here that is one join from the READS/WRITES edge it
--      already has (`datastore_node_id = edges.dst_node_id AND name = ?`).
--      endpoint_flow and context_pack already reach the datastore node. Under
--      (a) each would need a new key format for columns (keys.ts), CONTAINS
--      edges from table to column, and every node-kind list to grow (db.ts,
--      keys.ts, graph-json.ts, mermaid.ts, ui/app.html). No edge needs a
--      column as its endpoint today.
--   4. Incremental deletion (R28). Rows carry the migration's file_id and are
--      purged by provenance, like function_cfg. Under (a), column nodes are
--      never deleted, so a column removed from a migration would survive as a
--      node that reads as "this column exists".
--
-- Revisit (a) when a query needs a column as an edge endpoint (column-level
-- lineage).
--
-- A row is what the migration file DECLARES, not what the database holds: a
-- migration that was never applied, or a change made outside the migrations,
-- is invisible here. Statements the extractor cannot model (CREATE TABLE … AS,
-- ALTER … DROP COLUMN, DROP TABLE, a DO block, …) are stored as gaps in
-- `unresolved_calls` with kind = 'datastore', the slot 002 declared and nothing
-- filled until now (R11). The purge by provenance already removes them.
--
-- OPEN-9 limit, unchanged: the table key carries no database identity
-- (`postgres://?/<table>`), so same-named tables in two databases share one
-- node, and their columns are listed together, each with its source file.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS datastore_columns (
  id                INTEGER PRIMARY KEY,
  -- R12: keyed BY the datastore node id. One node per table: the migration's
  -- `users` and a SQL literal's `users` resolve to the same key.
  datastore_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  -- Unquoted and lower-cased: the rule `datastoreKey` applies to the table.
  name              TEXT NOT NULL,
  -- Declared type, verbatim with whitespace collapsed ('VARCHAR(255)',
  -- 'TIMESTAMP WITH TIME ZONE'). NULL when the definition declares none.
  data_type         TEXT,
  -- 1-based, among the column definitions of the declaring statement.
  position          INTEGER NOT NULL,
  not_null          INTEGER NOT NULL DEFAULT 0,
  -- Column-level PRIMARY KEY, or named by a table-level PRIMARY KEY (…).
  primary_key       INTEGER NOT NULL DEFAULT 0,
  statement         TEXT NOT NULL CHECK (statement IN ('create_table', 'alter_add')),
  statement_line    INTEGER NOT NULL,
  -- Provenance owner (R28): the migration file. `line` is the column's own.
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line              INTEGER NOT NULL,
  run_id            INTEGER NOT NULL REFERENCES runs(id),
  -- Identity: a re-index of an unchanged file inserts nothing new.
  UNIQUE (datastore_node_id, file_id, statement_line, statement, name)
);

-- Incremental delete-by-provenance (R28) reads exactly this index. Lookups by
-- table use the UNIQUE index, which leads with datastore_node_id.
CREATE INDEX IF NOT EXISTS idx_dscols_prov ON datastore_columns(file_id);
