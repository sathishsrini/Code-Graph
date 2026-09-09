-- ===========================================================================
-- 010_summaries  —  task P3-T2  (requirements R34, R62, R63, R64)
-- ===========================================================================
-- The ONLY table an LLM may write to.
--
-- R63 asks for the LLM boundary to be enforced **structurally**, not by
-- convention, and this table is that enforcement. It has no foreign key any
-- traversal joins against, and no query in `src/query/` references it. If the
-- model cannot reach `edges`, `route_chain` or `function_cfg`, it cannot
-- corrupt them — and "cannot" is a much stronger property than "is not
-- supposed to".
--
-- The failure this prevents is specific and was the previous attempt's: a
-- model writes a plausible relationship, a traversal treats it as a fact, and
-- six months later nobody can tell which edges were observed and which were
-- imagined. Confidence enums do not help, because the model would be filling
-- those in too.
--
-- **`node_id` is deliberately NOT a foreign key.** That looks like a mistake
-- and is the point: a real FK would make `summaries` a joinable relation, and
-- the next person writing a query would join it. Orphaning on delete is
-- acceptable here — a stale summary is caught by `input_sha256` never matching
-- again, and it is never read as fact.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS summaries (
  id            INTEGER PRIMARY KEY,
  -- The node this describes, by KEY not by id. Deliberately a loose reference:
  -- see the header. Resolving it is the caller's job, and only for display.
  node_key      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('function', 'module', 'service', 'path')),
  -- R64: the cache key. Regenerate only when this changes — that is what keeps
  -- the cost at "cents per week" rather than per query.
  input_sha256  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  -- Which model wrote it, so a bad batch is identifiable and removable.
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  /** Tokens in and out, so R64's cost claim is measurable rather than asserted. */
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  generated_at  TEXT NOT NULL,
  UNIQUE (node_key, kind, input_sha256)
);

CREATE INDEX IF NOT EXISTS idx_summaries_node ON summaries(node_key, kind);
CREATE INDEX IF NOT EXISTS idx_summaries_model ON summaries(provider, model);
