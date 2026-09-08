// ============================================================================
// Concrete path -> route template  —  task P2-T7  (requirements R52, R54)
// ============================================================================
// One place, because two callers needed it and the second one having its own
// copy is how they drift.
//
// R52 claims `http.route` — the TEMPLATE — comes free from OTel
// auto-instrumentation. Measured against this corpus it never arrived: the HTTP
// instrumentation emits `url.path`, the concrete path, and only *framework*
// instrumentation upgrades it, because only the router knows which template
// matched. So every runtime query that joins to a route needs this fallback,
// and every one of them should call it rather than re-deriving it.
//
// **The match is an inference and the callers say so.** `/api/v1/po/42` could
// match two templates; when it does, this returns nothing rather than picking
// one. A confident wrong route is worse than an unmatched span.
// ============================================================================

import type { FactStore } from "../store/db.ts";

export interface RouteCandidate {
  nodeId: number;
  service: string;
  method: string;
  url: string;
}

/** Strip query, fragment and a trailing slash. */
export function normalisePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? path;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Does a concrete path fit this route template? */
export function pathMatchesTemplate(path: string, template: string): boolean {
  const a = normalisePath(path).split("/");
  const b = normalisePath(template).split("/");
  if (a.length !== b.length) return false;
  return b.every((segment, i) =>
    segment.startsWith(":") ||
    segment === "*" ||
    (segment.startsWith("{") && segment.endsWith("}")) ||
    segment === a[i]);
}

/**
 * The single route a concrete path resolves to, or null.
 *
 * Exact template equality wins outright — that is what a router does, and it
 * is not an inference at all. Otherwise a parameterised match is accepted
 * ONLY when exactly one template fits: two candidates is a genuine ambiguity,
 * not a coin to flip.
 */
export function matchTemplate(
  store: FactStore, service: string, path: string, method: string | null,
): number | null {
  const candidates = store.raw().prepare(
    `SELECT node_id, url, method FROM routes
      WHERE service_name = ? AND (? IS NULL OR method = ?)`,
  ).all(service, method, method) as Array<{ node_id: number; url: string; method: string }>;

  const clean = normalisePath(path);
  const exact = candidates.filter((c) => normalisePath(c.url) === clean);
  if (exact.length === 1) return exact[0]!.node_id;

  const matches = candidates.filter((c) => pathMatchesTemplate(clean, c.url));
  return matches.length === 1 ? matches[0]!.node_id : null;
}

/**
 * Every span path in a service that resolves to this route.
 *
 * Returned as a list rather than a single value because a template with a
 * parameter is hit by many concrete paths, and a query that only looked for
 * one would find `/api/v1/po/1` and miss `/api/v1/po/2`.
 */
export function spanPathsForRoute(
  store: FactStore, service: string, url: string,
): string[] {
  const paths = (store.raw().prepare(
    `SELECT DISTINCT url_path FROM spans
      WHERE service_name = ? AND url_path IS NOT NULL`,
  ).all(service) as Array<{ url_path: string }>).map((r) => r.url_path);

  return paths.filter((p) => pathMatchesTemplate(p, url));
}
