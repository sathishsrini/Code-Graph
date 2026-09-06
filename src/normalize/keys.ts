// ============================================================================
// Canonical node keys  —  task P1-T2  (requirements R4, R9, R12)
// ============================================================================
// One rule decides everything in this file: **node identity is global**.
//
// A symbol in `60-kri-next` and a route in `40-kri-router` are joined by an
// ordinary `edges` row with no mapping table and no repo qualifier, because
// their keys are already unique across every repo the engine has ever seen.
// The moment identity becomes repo-scoped, every cross-service query grows a
// translation step — which is exactly how the v2 attempt ended up with a
// subquery in every traversal (plan §H, R12).
//
// The second rule follows from the first: **a key is composed once, here.**
// R4 says the SCIP symbol string is the canonical symbol identity, stored
// verbatim. `symbolKey` therefore does nothing at all, and that is the point —
// it exists so that every call site goes through the same function and nobody
// is ever tempted to build `service.dotted.path.Name`, the identity scheme
// whose instability is named in the source doc's §H.2.3 as a root cause.
// ============================================================================

import type { NodeKind } from "../store/db.ts";

/** A node key together with the kind it belongs to. */
export interface NodeRef {
  kind: NodeKind;
  key: string;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/**
 * The service name as declared in `repos.json`.
 *
 * Not the repo name: one repo can serve two services, and two repos can serve
 * one. `repos.json` carries both and the engine keys on the service, because
 * that is what a route, a span and a base-URL env var all refer to.
 */
export function serviceKey(serviceName: string): string {
  return serviceName;
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

/**
 * `<service> <METHOD> <url>` — the same string the Fastify boot adapter
 * already emits as `routeKey`, so the two channels agree by construction
 * rather than by a mapping.
 *
 * The url is the framework's own template (`/api/v1/po/:id`), never a
 * concrete request path. That is what makes a cross-service `REQUESTS` edge
 * resolvable: the caller has a URL, the callee has a template, and P1-T7
 * matches one against the other.
 */
export function routeKey(serviceName: string, method: string, url: string): string {
  return `${serviceName} ${method.toUpperCase()} ${url}`;
}

const ROUTE_KEY = /^(\S+) ([A-Z]+) (.+)$/;

export function parseRouteKey(
  key: string,
): { service: string; method: string; url: string } | null {
  const m = ROUTE_KEY.exec(key);
  return m ? { service: m[1]!, method: m[2]!, url: m[3]! } : null;
}

// ---------------------------------------------------------------------------
// symbol
// ---------------------------------------------------------------------------

/**
 * The verbatim SCIP symbol string (R4).
 *
 * Deliberately an identity function. Never compose your own — see the file
 * header. The one thing it does is refuse the empty string, because an empty
 * key would collide every unnamed symbol in the graph into a single node and
 * the resulting edges would look real.
 */
export function symbolKey(scipSymbol: string): string {
  if (scipSymbol === "") throw new Error("symbolKey: empty SCIP symbol");
  return scipSymbol;
}

// ---------------------------------------------------------------------------
// file
// ---------------------------------------------------------------------------

/**
 * `<repo>/<repo-relative path>`, forward slashes.
 *
 * Repo-qualified, which looks like it contradicts R9 and does not: R9 forbids
 * *scoping* identity by repo — a lookup that needs to know which repo you are
 * in first. Two repos genuinely can both contain `server.js`, and they are
 * different files; qualifying keeps one flat global namespace in which both
 * exist and neither shadows the other.
 */
export function fileKey(repoName: string, relativePath: string): string {
  return `${repoName}/${normalizeSlashes(relativePath)}`;
}

export function normalizeSlashes(path: string): string {
  return path.split("\\").join("/").replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// external
// ---------------------------------------------------------------------------

/**
 * A third-party package: `npm:axios@1.7.2`, `pypi:httpx@0.27.0`.
 *
 * The version is part of the key on purpose. An upgrade that changes a
 * package's behaviour should show up as a different node rather than silently
 * inheriting the old one's edges and traces.
 */
export function packageKey(manager: string, name: string, version?: string | null): string {
  const m = manager === "" ? "unknown" : manager;
  return version ? `${m}:${name}@${version}` : `${m}:${name}`;
}

/**
 * An HTTP destination that could not be resolved to a known service:
 * `http:api.stripe.com` or `http:localhost:3003`.
 *
 * This is the honest terminal for an outbound call. It is NOT a fallback for
 * "we did not try" — a call site whose destination could not be determined at
 * all belongs in `unresolved_calls` (R11), not on an edge to a plausible host.
 */
export function hostKey(host: string): string {
  return `http:${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

// ---------------------------------------------------------------------------
// datastore
// ---------------------------------------------------------------------------

export interface DatastoreRef {
  /** `postgres`, `redis`, `mongo`, … lower-cased. */
  engine: string;
  /** Logical database or namespace. `null` when not recoverable from source. */
  database?: string | null;
  /** Table, collection or key prefix. */
  table: string;
}

/**
 * `postgres://<database|?>/<table>`.
 *
 * The `?` for an unknown database is what makes OPEN-9 work. `51-integration`
 * writes `mail_events`; `41-kri-engine/migrations/001_init.sql` creates it.
 * Neither source names the database, and no code indexer can see the coupling
 * between the two services at all — they share a database, not a call. Because
 * both resolve to the same key, two `WRITES`/`READS` edges land on one node
 * and the coupling becomes a join.
 *
 * Deliberately NOT a stored service-to-service edge: that would duplicate what
 * the join already answers and violate R72. It surfaces as a *data dependency*
 * in `impact` (R38).
 */
export function datastoreKey(ref: DatastoreRef): string {
  const engine = ref.engine.toLowerCase() || "unknown";
  const db = ref.database && ref.database !== "" ? ref.database : "?";
  return `${engine}://${db}/${ref.table.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * `env:DATABASE_URL` — globally scoped, with no service qualifier.
 *
 * That is the whole value of the node. Two services reading one env var are
 * coupled through it, and R38's *configuration dependency* is the query "what
 * else reads what this change touches". Qualifying the key by service would
 * give each reader a private node and make the answer permanently empty.
 *
 * R23: the key name is stored. The value never is, not even redacted, not even
 * hashed — a hashed secret is still a secret with a confirmation oracle.
 */
export function configKey(varName: string): string {
  return `env:${varName}`;
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export const ref = {
  service: (name: string): NodeRef => ({ kind: "service", key: serviceKey(name) }),
  route: (service: string, method: string, url: string): NodeRef =>
    ({ kind: "route", key: routeKey(service, method, url) }),
  symbol: (scipSymbol: string): NodeRef => ({ kind: "symbol", key: symbolKey(scipSymbol) }),
  file: (repo: string, path: string): NodeRef => ({ kind: "file", key: fileKey(repo, path) }),
  package: (manager: string, name: string, version?: string | null): NodeRef =>
    ({ kind: "external", key: packageKey(manager, name, version) }),
  host: (host: string): NodeRef => ({ kind: "external", key: hostKey(host) }),
  datastore: (d: DatastoreRef): NodeRef => ({ kind: "datastore", key: datastoreKey(d) }),
  config: (varName: string): NodeRef => ({ kind: "config", key: configKey(varName) }),
} as const;
