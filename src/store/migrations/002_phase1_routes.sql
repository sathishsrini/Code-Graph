-- ===========================================================================
-- 002_phase1_routes  —  task P1-T1  (requirements R2, R6, R11)
-- ===========================================================================
-- Three tables, each with a producer landing in this phase:
--
--   routes            <- P1-T8  boot channel (Fastify) and P1-T4 (FastAPI)
--   route_chain       <- P1-T8  boot hooks, and P1-T10 inline security checks
--   unresolved_calls  <- P1-T11 persisting what P0-T6 already derives
--
-- `spans` and `summaries` from plan §H are deliberately absent: their
-- producers are P2-T8 and P3-T2. R72 is not a guideline here, it is the rule
-- that stops this becoming the 470-line DDL of the previous two attempts.
-- Recorded as delta D9 in implementation/PLAN-DELTAS.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- routes — detail for nodes of kind='route'
-- ---------------------------------------------------------------------------
-- R12: keyed BY node id. No parallel id space; the v2 root cause was a second
-- identity system that made every query carry a subquery to cross it.
--
-- `source` is not decoration. A route the framework reported at boot and a
-- route a parser guessed from source are different claims, and Fastify's
-- synthesised HEAD routes (6 of 23 on the router) exist in no source file at
-- all — so "which channel said this route exists" has to survive into storage.

CREATE TABLE IF NOT EXISTS routes (
  node_id          INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  repo_id          INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  service_name     TEXT NOT NULL,
  method           TEXT NOT NULL,             -- upper case, 'GET'
  url              TEXT NOT NULL,             -- as the framework reports it
  prefix           TEXT NOT NULL DEFAULT '',
  handler_node_id  INTEGER REFERENCES nodes(id),
  -- OPEN-6: null across this corpus. No Fastify route declares `schema:` and
  -- the FastAPI handler takes a raw Request, so app.openapi() emits nothing.
  -- Stored as null rather than back-filled by a fixture-specific extractor.
  request_schema   TEXT,
  response_schema  TEXT,
  has_schema       INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL CHECK (source IN ('boot', 'static')),
  run_id           INTEGER NOT NULL REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_routes_service ON routes(service_name, method, url);
CREATE INDEX IF NOT EXISTS idx_routes_repo    ON routes(repo_id);

-- ---------------------------------------------------------------------------
-- route_chain — an ORDERED RELATION, not an edge (R6)
-- ---------------------------------------------------------------------------
-- Middleware order is the one thing no static reader recovers, and an edge
-- table cannot express it: edges are a set, and `position` is the answer.
--
-- Two channels write here and they must stay distinguishable at a glance
-- (R26, R50):
--
--   phase != 'handler_inline'  boot said so.        certain / boot
--   phase == 'handler_inline'  a parser inferred it. inferred / treesitter|semgrep
--
-- The corpus is exactly why: `POST /api/v1/po` has no auth *hook*, and
-- `checkUserAuth` is the handler's first statement. Reading the boot rows
-- alone reports the route as unauthenticated. Merging the two channels into
-- one undifferentiated list would report an inference as a fact.

CREATE TABLE IF NOT EXISTS route_chain (
  id             INTEGER PRIMARY KEY,
  route_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,          -- execution order within `phase`
  phase          TEXT NOT NULL,             -- onRequest|preHandler|handler|handler_inline|...
  symbol_node_id INTEGER REFERENCES nodes(id),
  -- `file.js:line:col`, or a dotted dependency path for FastAPI. Identity for
  -- an anonymous arrow hook, which is 68-89% of this corpus (measurements M6).
  key            TEXT,
  name           TEXT,                      -- fn.name, null when anonymous
  check_kind     TEXT,                      -- auth|tenant|rbac|ratelimit|... (P1-T9)
  origin         TEXT NOT NULL CHECK (origin IN ('scope', 'route', 'framework', 'handler')),
  inherited_from TEXT,                      -- declaring scope, when shallower
  confidence     TEXT NOT NULL CHECK (confidence IN
                   ('certain', 'inferred', 'observed', 'unresolved')),
  evidence_kind  TEXT NOT NULL CHECK (evidence_kind IN
                   ('scip', 'treesitter', 'semgrep', 'boot', 'otel', 'manual')),
  file_id        INTEGER REFERENCES files(id) ON DELETE CASCADE,
  line           INTEGER,
  run_id         INTEGER NOT NULL REFERENCES runs(id),
  UNIQUE (route_node_id, phase, position)
);
CREATE INDEX IF NOT EXISTS idx_chain_route  ON route_chain(route_node_id, phase, position);
CREATE INDEX IF NOT EXISTS idx_chain_check  ON route_chain(check_kind, route_node_id);
CREATE INDEX IF NOT EXISTS idx_chain_symbol ON route_chain(symbol_node_id);
CREATE INDEX IF NOT EXISTS idx_chain_prov   ON route_chain(file_id, evidence_kind);

-- ---------------------------------------------------------------------------
-- unresolved_calls — the honest gaps (R11)
-- ---------------------------------------------------------------------------
-- Persisted and queryable. A tool that hides what it could not analyse turns
-- an unknown into a false negative, and the reader has no way to tell "nothing
-- here" from "we could not look."
--
-- P0-T9 proved the value concretely: the single most useful edge in the router
-- --- `return axios(axiosConfig)`, its only outbound HTTP call --- resolves to
-- a package namespace and lands here rather than in `edges`. Dropping it made
-- `forward()` render as a function that calls nothing.

CREATE TABLE IF NOT EXISTS unresolved_calls (
  id          INTEGER PRIMARY KEY,
  src_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('call', 'cross_service', 'datastore')),
  -- Whatever the indexer *did* resolve: usually a package or module symbol,
  -- or an unmatched URL for a cross-service miss.
  target_hint TEXT,
  reason      TEXT NOT NULL,
  file_id     INTEGER REFERENCES files(id) ON DELETE CASCADE,
  line        INTEGER,
  col         INTEGER,
  run_id      INTEGER NOT NULL REFERENCES runs(id)
);
-- Same COALESCE identity as edges: SQLite treats two NULLs as distinct, so a
-- plain UNIQUE would let every re-run insert fresh duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ux_unresolved_identity ON unresolved_calls(
  src_node_id, kind, COALESCE(target_hint, ''),
  COALESCE(file_id, -1), COALESCE(line, -1), COALESCE(col, -1)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_src  ON unresolved_calls(src_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_prov ON unresolved_calls(file_id);
