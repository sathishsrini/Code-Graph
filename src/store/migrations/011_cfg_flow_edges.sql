-- ===========================================================================
-- 011_cfg_flow_edges  —  decision-structure flowchart rendering
--                         (extends P1-T17/P1-T18, requirements R75-R78)
-- ===========================================================================
-- `function_cfg.parent_index` is CONTAINMENT nesting — "this guard sits inside
-- this try" — not control flow. It cannot answer "which block runs next after
-- this diamond's True arm" or "where does the loop body return to", which is
-- exactly what a decision-structure flowchart needs: a diamond with a
-- labelled True arrow and a labelled False arrow, each pointing at a REAL
-- successor block, plus a loop's back-edge.
--
-- `function_cfg_edges` is that missing graph.
--
-- `branch_label` on `function_cfg` says which arm of ITS OWN PARENT a block
-- sits in (then/else/try_body/catch/finally/loop_body) — the piece that lets
-- two blocks share the same `parent_index` (both nested directly under one
-- `if`) while being on opposite sides of the diamond.
--
-- Both are derived from source structure alone, with NO evaluation of
-- `condition_text` — so both stay `evidence_kind='treesitter'`,
-- `confidence='inferred'` at the edges level, matching R75's own scope
-- boundary. `to_block` is NULL exactly at the point control falls off the end
-- of the function with no visible return: an implicit exit, recorded rather
-- than silently dropped (the same discipline as `unresolved_calls`).
-- ===========================================================================

ALTER TABLE function_cfg ADD COLUMN branch_label TEXT CHECK (branch_label IS NULL OR branch_label IN
  ('then', 'else', 'try_body', 'catch', 'finally', 'loop_body'));

CREATE TABLE IF NOT EXISTS function_cfg_edges (
  id             INTEGER PRIMARY KEY,
  symbol_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  from_block     INTEGER NOT NULL,
  -- NULL = falls off the end of the function with no visible return.
  to_block       INTEGER,
  label          TEXT NOT NULL CHECK (label IN ('true', 'false', 'next', 'loop_back', 'catch')),
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  run_id         INTEGER NOT NULL REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_cfg_edges_symbol ON function_cfg_edges(symbol_node_id, from_block);
-- Provenance delete (R28): an edge is owned by the file its function was parsed from.
CREATE INDEX IF NOT EXISTS idx_cfg_edges_prov ON function_cfg_edges(file_id);
