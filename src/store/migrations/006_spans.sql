-- ===========================================================================
-- 006_spans  —  task P2-T8  (requirements R53, R54, R55)
-- ===========================================================================
-- The runtime channel. This table now has a producer — `src/runtime/otlp.ts`
-- — which is the only reason it exists at all: it was deliberately left out of
-- the Phase 1 schema (delta D9) because a structurally-empty table answers
-- "no evidence" when the truth is "no producer", and nothing in the output
-- distinguishes those.
--
-- The organising principle, quoted because it decides the shape here:
--
--   Runtime traces establish the boundaries with certainty.
--   Static analysis fills in the interiors with inference.
--
-- So spans are stored as *observations*, never as corrections. R56 is absolute:
-- runtime never deletes a static edge. It upgrades `inferred` -> `observed`, or
-- adds a new `observed` edge. A trace that did not exercise a path is not
-- evidence the path does not exist — it is evidence nobody hit it today.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS spans (
  id             INTEGER PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,
  parent_span_id TEXT,                  -- NULL at a trace root
  name           TEXT NOT NULL,
  kind           TEXT,                  -- server|client|internal|producer|consumer
  service_name   TEXT NOT NULL,         -- resource attribute service.name
  -- MICROSECONDS, not the nanoseconds OTLP sends.
  --
  -- A Unix nanosecond timestamp is ~1.7e18, and JavaScript's safe integer
  -- range ends at 9.007e15. SQLite stores it happily as a 64-bit INTEGER and
  -- then `node:sqlite` throws reading it back:
  --   RangeError: Value is too large to be represented as a JavaScript number
  -- Microseconds are ~1.7e15, safe until the year 2255, and keep the
  -- sub-millisecond ordering that separates sibling spans starting in the same
  -- millisecond. Nanosecond precision buys nothing any query here asks for.
  start_unix_us  INTEGER NOT NULL,
  end_unix_us    INTEGER NOT NULL,
  duration_us    INTEGER NOT NULL,
  -- 'ok' | 'error' | 'unset'. The sampling decision keys on this, and so does
  -- M.2's root-cause walk: the DEEPEST error span is the origin.
  status         TEXT NOT NULL,
  status_message TEXT,

  -- R54 join keys, extracted to columns because every runtime query is one of
  -- these joins and a JSON scan per row would make them all table scans.
  http_route     TEXT,                  -- http.route          -> routes.url
  http_method    TEXT,                  -- http.request.method
  http_status    INTEGER,
  code_function  TEXT,                  -- code.function.name  -> symbols
  code_filepath  TEXT,                  -- code.file.path      -> files.path
  db_system      TEXT,                  -- db.system           -> datastore
  db_name        TEXT,
  db_operation   TEXT,
  server_address TEXT,                  -- server.address      -> external/remote route

  -- exception.* from the span's events, when it recorded one.
  exception_type    TEXT,
  exception_message TEXT,

  -- The semconv version this row was normalised against (R55). Pinned per row
  -- rather than globally: a fleet mid-migration emits both spellings at once,
  -- and a single global setting would silently mis-read half the traffic.
  semconv        TEXT NOT NULL,
  /** Everything not promoted to a column, as JSON. Never joined against. */
  attributes     TEXT,
  received_at    TEXT NOT NULL,
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_spans_trace  ON spans(trace_id, start_unix_us);
CREATE INDEX IF NOT EXISTS idx_spans_route  ON spans(service_name, http_route, http_method);
CREATE INDEX IF NOT EXISTS idx_spans_code   ON spans(code_function, code_filepath);
CREATE INDEX IF NOT EXISTS idx_spans_status ON spans(status, start_unix_us DESC);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

-- R57: a static edge with no runtime confirmation is "possibly dead", not
-- proof. `last_observed_at` is what that question reads, and it is only ever
-- written forward — an edge that stops being observed keeps its last date.
ALTER TABLE edges ADD COLUMN last_observed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_edges_observed ON edges(type, last_observed_at);
