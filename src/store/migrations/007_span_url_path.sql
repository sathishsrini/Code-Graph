-- ===========================================================================
-- 007_span_url_path  —  task P2-T7  (requirements R52, R54)
-- ===========================================================================
-- `url.path` — the CONCRETE request path, beside `http.route`'s template.
--
-- R52 claims `http.route` "comes free" from OTel auto-instrumentation. Measured
-- against `40-kri-router` under `@opentelemetry/auto-instrumentations-node`,
-- it does not arrive at all. What arrives is:
--
--   http.request.method = GET
--   url.path            = /api/v1/po        <- concrete, not a template
--   server.address      = 127.0.0.1
--   server.port         = 3001
--
-- `http.route` is set by *framework* instrumentation, which upgrades the
-- concrete path to the route template it matched. The HTTP instrumentation
-- alone cannot know the template — it never sees the router.
--
-- So the runtime channel has to work from `url.path`, which means matching a
-- concrete path against route templates. That match is an INFERENCE
-- (`/api/v1/po/42` could match two templates), and it is recorded as one:
-- an edge confirmed this way is `observed` about the traffic and `inferred`
-- about which route it hit. Storing the raw path keeps that distinction
-- available instead of guessing once at ingest and forgetting.
-- ===========================================================================

ALTER TABLE spans ADD COLUMN url_path TEXT;
ALTER TABLE spans ADD COLUMN server_port INTEGER;
CREATE INDEX IF NOT EXISTS idx_spans_urlpath ON spans(service_name, url_path);
