-- ===========================================================================
-- 005_function_cfg  —  tasks P1-T17, P1-T18  (requirements R75, R76, R77)
-- ===========================================================================
-- Per-function control flow, and the column that attributes an edge to a
-- branch.
--
-- This is the v2 addition, and it exists because of a measurement. The source
-- doc excludes control-flow analysis (§C fn.14, §G.2, §Q.2) on the reasoning
-- that `THROWS` plus a call graph is enough for a failure surface. On this
-- corpus `THROWS` is **zero on every backend service** (measurements M8 / delta
-- D12): failures are `return envelopeError({...})` and guards are
-- `if (authErr) return authErr;`. A throw-only failure surface finds nothing at
-- all here, which is not a small inaccuracy — it is the whole feature missing.
--
-- Scope, stated so it is not over-promised: this is a SYNTACTIC, per-function
-- CFG. It answers "this call sits inside the `if (authErr)` branch, which exits
-- with an error". It does NOT answer "authErr is non-null when the token is
-- invalid" — that is interprocedural data flow and stays out of scope.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS function_cfg (
  id             INTEGER PRIMARY KEY,
  symbol_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  block_index    INTEGER NOT NULL,     -- ordinal within the function
  parent_index   INTEGER,              -- nesting; NULL = function root
  kind           TEXT NOT NULL CHECK (kind IN
                   ('root', 'branch', 'guard', 'try', 'catch', 'finally', 'loop', 'exit')),
  -- Verbatim source of the condition. NEVER evaluated, and never parsed for
  -- meaning: `if (authErr)` is recorded as text because what makes `authErr`
  -- truthy is interprocedural and out of scope.
  condition_text TEXT,
  outcome        TEXT CHECK (outcome IN ('success', 'error_exit', 'unknown')),
  exit_form      TEXT CHECK (exit_form IN
                   ('throw', 'return_error', 'return_value', 'implicit')),
  -- Error constructor or error-code literal, when one is detectable.
  -- `KRI40-AUTH-001` on this corpus; `ValidationError` on code that throws.
  error_name     TEXT,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  run_id         INTEGER NOT NULL REFERENCES runs(id),
  UNIQUE (symbol_node_id, block_index)
);

CREATE INDEX IF NOT EXISTS idx_cfg_symbol ON function_cfg(symbol_node_id, block_index);
-- Provenance delete (R28): a CFG is owned by the file it was parsed from.
CREATE INDEX IF NOT EXISTS idx_cfg_prov   ON function_cfg(file_id);
CREATE INDEX IF NOT EXISTS idx_cfg_exit   ON function_cfg(outcome, symbol_node_id);

-- R77: which CFG block an edge's call site sits in.
--
-- Nullable, and null is the norm rather than a gap: a boot-reported hook and an
-- otel span have no source position inside a function body, so there is no
-- block to attribute them to. Only edges the static channel placed at a line
-- inside a parsed function get a value.
ALTER TABLE edges ADD COLUMN cfg_block_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_edges_cfg ON edges(src_node_id, cfg_block_index);
