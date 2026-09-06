// Cross-service HTTP findings -> REQUESTS edges (task P1-T7, R31).
//
// The resolver is deliberately pure. Tree-sitter tells us what URL expressions
// and call sites exist; this module only matches that evidence against boot
// routes. It never invents a route and every non-match remains an explicit
// unresolved result for the store layer to persist.
//
// Revision (the corpus correction). The first implementation iterated client
// calls and hunted backwards for a URL. On 40-kri-router the only outbound
// call is `axios(axiosConfig)` *below* every real URL — one indirection down
// the `forward()` wrapper — so the loop could never reach a destination and
// the one resolvable edge in the corpus (INTEGRATION_BASE_URL →
// 51-integration POST /api/v1/mail/send) stayed invisible. This revision
// iterates URL expressions, attributes each to its enclosing function, and
// accepts it only when the function (or a wrapper it calls by name) contains
// an HTTP client call. That is the "wrapper indirection" P1-T7 names.

import type { RepoConfig } from "../config/repos.ts";
import {
  enclosingFunction,
  type FileFindings,
  type FunctionRange,
  type HttpFinding,
  type UrlExpr,
} from "../static/treesitter/extract.ts";

export interface RouteTarget {
  nodeId: number;
  service: string;
  method: string;
  url: string;
}

export interface RequestLink {
  routeNodeId: number;
  line: number;
  col: number;
  method: string | null;
  baseVar: string | null;
  path: string;
  detail: string;
}

export interface UnresolvedLink {
  line: number;
  col: number;
  targetHint: string;
  reason: string;
}

export interface LinkResult {
  requests: RequestLink[];
  unresolved: UnresolvedLink[];
}

export interface LinkInput {
  repo: RepoConfig;
  findings: FileFindings;
  targets: RouteTarget[];
  repos: RepoConfig[];
  /** The file's source, so a caller's invocation of a wrapper can be seen. */
  source: string;
}

/** Hosts that can name a service running in this workspace. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Resolve every URL expression in one file without writing facts.
 *
 * Each expression is attributed to its enclosing function. A URL only
 * participates if that function (or a callee wrapper it calls by name)
 * contains an HTTP client call — otherwise it is honest noise (a route
 * registration string, a CORS origin) recorded as unresolved, never silently
 * dropped and never resolved as a request.
 */
export function resolveCrossService(input: LinkInput): LinkResult {
  const requests: RequestLink[] = [];
  const unresolved: UnresolvedLink[] = [];
  const bindings = new Map(input.findings.envBindings.map((b) => [b.name, b]));
  const wrappers = wrapperHolders(input.findings);
  const consumption = new Map<number, boolean>();

  for (const url of input.findings.urls) {
    // A bare `/…` literal is a path, not an outbound URL, unless it is the
    // inline argument of an HTTP client call (axios.get('/health')). Route
    // registrations, `.startsWith('/api/v1/po')` comparisons and the corpus's
    // CORS/allow header strings would otherwise flood the gap log as phantom
    // cross-service requests. An absolute URL or a `${BASE}…` template is
    // always URL-shaped and always examined.
    const absolute = /^https?:\/\//i.test(url.literalPath);
    if (url.baseVar === null && !absolute && !isInlineHttpUrl(url, input.findings.https)) {
      continue;
    }
    // The default of an env binding is that binding's destination hint; a
    // standalone row for the same literal is double counting it.
    if (bindingDefaultOnly(url, input.findings.envBindings)) continue;

    const fn = enclosingFunction(input.findings.functions, url.line);
    if (!consumedByHttp(fn, input, wrappers, consumption)) {
      unresolved.push({
        line: url.line, col: url.col,
        targetHint: url.baseVar ?? url.literalPath,
        reason: fn === null
          ? "URL expression sits outside any function body"
          : "URL is not consumed by an HTTP call in its enclosing function or a callee wrapper",
      });
      continue;
    }

    const base = resolveBase(url, input.repo, input.repos, bindings);
    if (base === null) {
      unresolved.push({
        line: url.line, col: url.col,
        targetHint: url.baseVar ?? url.literalPath,
        reason: baseFailureReason(url, input.repo, bindings),
      });
      continue;
    }

    const method = inlineMethodFor(url, input.findings.https);
    const candidates = input.targets.filter((target) =>
      target.service === base.service &&
      (method === null || target.method === method) &&
      routeMatches(target.url, url.literalPath, url.dynamic),
    );

    if (candidates.length === 1) {
      const target = candidates[0]!;
      requests.push({
        routeNodeId: target.nodeId,
        line: url.line, col: url.col,
        method, baseVar: url.baseVar, path: url.literalPath,
        detail: `${url.raw} -> ${target.service} ${target.method} ${target.url}`,
      });
    } else if (candidates.length === 0) {
      unresolved.push({
        line: url.line, col: url.col,
        targetHint: `${base.service}${url.literalPath ? ` ${url.literalPath}` : ""}`,
        reason: url.dynamic && url.literalPath === ""
          ? "dynamic path cannot be matched to a unique route"
          : "no indexed route matches the URL",
      });
    } else {
      unresolved.push({
        line: url.line, col: url.col,
        targetHint: `${base.service} ${url.literalPath}`,
        reason: `ambiguous route match (${candidates.length} candidates)`,
      });
    }
  }

  // A config-style client call (`axios(config)`) whose URL never appears as an
  // expression anywhere in the file has nothing to iterate; name that absence
  // rather than presenting the call as resolved.
  for (const h of input.findings.https) {
    if (h.configVar === null) continue;
    if (h.urls.length === 0 && input.findings.urls.length === 0) {
      unresolved.push({
        line: h.line, col: h.col, targetHint: h.configVar,
        reason: "config-style client call has no URL expression anywhere in this file",
      });
    }
  }

  return {
    requests: dedupeRequests(requests),
    unresolved: dedupeUnresolved(unresolved),
  };
}

// ---------------------------------------------------------------------------
// Consumption: is this URL actually on an outbound HTTP path?
// ---------------------------------------------------------------------------

/**
 * True when the enclosing function either contains an HTTP client call itself
 * or calls, by name, a wrapper function that does.
 *
 * Function-level on purpose. The corpus URL is assigned to a `target` then
 * passed as `url: target` to `forward({…})`, which is where `axios()` lives;
 * tracking the variable would require per-expression dataflow, which is not
 * what P1-T7 is for. Being on an HTTP path inside the same function is enough
 * evidence for an `inferred` edge — the individual route match still has to
 * succeed for one to exist.
 */
function consumedByHttp(
  fn: FunctionRange | null,
  input: LinkInput,
  wrappers: FunctionRange[],
  cache: Map<number, boolean>,
): boolean {
  if (fn === null) return false;
  const cached = cache.get(fn.line);
  if (cached !== undefined) return cached;

  const direct = input.findings.https.some((h) => h.line >= fn.line && h.line <= fn.endLine);
  const viaWrapper = !direct && wrappers.some(
    (w) => w !== fn && callsByName(input.source, fn, w.name!),
  );

  cache.set(fn.line, direct || viaWrapper);
  return direct || viaWrapper;
}

/** Named functions whose bodies contain an HTTP client call. */
function wrapperHolders(findings: FileFindings): FunctionRange[] {
  return findings.functions.filter((f) =>
    f.name !== null &&
    findings.https.some((h) => h.line >= f.line && h.line <= f.endLine),
  );
}

/** Does `fn`'s body invoke `callee`? A name-then-open-paren test on its span. */
function callsByName(source: string, fn: FunctionRange, callee: string): boolean {
  const span = source.split(/\r?\n/).slice(fn.line - 1, fn.endLine).join("\n");
  return new RegExp(`\\b${escapeRegex(callee)}\\s*\\(`).test(span);
}

// ---------------------------------------------------------------------------
// Base resolution
// ---------------------------------------------------------------------------

interface BaseResolution {
  service: string;
}

function resolveBase(
  url: UrlExpr,
  sourceRepo: RepoConfig,
  repos: RepoConfig[],
  bindings: Map<string, FileFindings["envBindings"][number]>,
): BaseResolution | null {
  if (url.baseVar === null) return serviceFromUrl(url.literalPath, repos);

  // The local name (BASE, ENGINE_BASE_URL) is not the declared identity. The
  // binding map translates it to the env var (NEXT_PUBLIC_API_BASE_URL), and
  // `baseUrlEnvVars` declares *env vars*. Checking the local name against the
  // declaration is how a frontend call site got told "BASE is not declared"
  // when it was.
  const binding = bindings.get(url.baseVar);
  if (binding === undefined || binding.envVar === null) return null;
  if (!sourceRepo.baseUrlEnvVars.includes(binding.envVar)) return null;

  // Prefer the binding's default URL: it is the concrete destination this
  // code falls back to. Only when there is none (PROCUREMENT_BASE_URL defaults
  // to '') is the service guessed from the env var's name. A non-loopback
  // default returns null rather than falling through — guessing a service from
  // a name when the deployment clearly names a host is how `:3002` on a
  // Stripe URL became the engine.
  if (binding.defaultUrl) return serviceFromUrl(binding.defaultUrl, repos);
  return serviceFromName(binding.envVar, repos);
}

/** An HTTP client finding carries this exact URL among its inline arguments. */
function isInlineHttpUrl(url: UrlExpr, https: HttpFinding[]): boolean {
  return https.some((h) =>
    h.urls.some((u) => u.line === url.line && u.col === url.col),
  );
}

/** The URL is literally an env binding's default on the same line. */
function bindingDefaultOnly(
  url: UrlExpr,
  bindings: FileFindings["envBindings"],
): boolean {
  return bindings.some((b) => b.line === url.line && b.defaultUrl === url.literalPath);
}

function baseFailureReason(
  url: UrlExpr,
  sourceRepo: RepoConfig,
  bindings: Map<string, FileFindings["envBindings"][number]>,
): string {
  if (url.baseVar === null) {
    return /^https?:\/\//i.test(url.literalPath)
      ? "absolute URL host is not the loopback host of an indexed service"
      : "relative path has no base URL to resolve against a service";
  }
  const binding = bindings.get(url.baseVar);
  if (binding === undefined || binding.envVar === null) {
    return `local name ${url.baseVar} is not bound to any env var`;
  }
  if (!sourceRepo.baseUrlEnvVars.includes(binding.envVar)) {
    return `${binding.envVar} is not declared in baseUrlEnvVars`;
  }
  return `${binding.envVar} resolves to no indexed service via a loopback base URL`;
}

/**
 * Match an absolute URL to a service.
 *
 * Both halves must agree: the host must be loopback (a service in this
 * workspace) and the port must be a repo's declared port. Port alone is not
 * identity — `https://api.stripe.com:3002/x` previously resolved to the engine
 * because the engine's port is 3002.
 */
function serviceFromUrl(value: string, repos: RepoConfig[]): BaseResolution | null {
  try {
    const parsed = new URL(value);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const byPort = repos.find((r) => r.port === port);
    return byPort ? { service: byPort.serviceName } : null;
  } catch {
    return null;
  }
}

function serviceFromName(envName: string, repos: RepoConfig[]): BaseResolution | null {
  const wanted = tokens(envName.replace(/_BASE_URL$/, ""));
  const matches = repos.filter((repo) => {
    const names = tokens(`${repo.name} ${repo.serviceName}`);
    return wanted.some((token) => names.includes(token));
  });
  return matches.length === 1 ? { service: matches[0]!.serviceName } : null;
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Method and route matching
// ---------------------------------------------------------------------------

/**
 * The HTTP call that carries this URL, when the URL is an inline argument of
 * one — that call is the only place a static method is certain.
 *
 * A URL passed through a wrapper (`forward({ method, url })`) has no certain
 * method here; leaving it null means the route match is path-only, and if two
 * methods share the path the result is an explicit ambiguous row rather than
 * a guess.
 */
function inlineMethodFor(url: UrlExpr, https: HttpFinding[]): string | null {
  const owners = https.filter((h) =>
    h.urls.some((u) => u.line === url.line && u.col === url.col && u.baseVar === url.baseVar),
  );
  return owners.length === 1 && owners[0]!.method !== null ? owners[0]!.method : null;
}

function routeMatches(template: string, literalPath: string, dynamic: boolean): boolean {
  if (dynamic && literalPath === "") return false;
  const path = normalizePath(literalPath);
  const route = normalizePath(template);
  if (path === route) return true;
  if (!path) return false;

  const pattern = route
    .split("/")
    .map((segment) => {
      if (segment === "*" || segment.startsWith(":")) return "[^/]+";
      if (segment.startsWith("{") && segment.endsWith("}")) return "[^/]+";
      return escapeRegex(segment);
    })
    .join("/");
  return new RegExp(`^${pattern}/?$`).test(path);
}

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupeRequests(rows: RequestLink[]): RequestLink[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.routeNodeId}:${row.line}:${row.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeUnresolved(rows: UnresolvedLink[]): UnresolvedLink[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.line}:${row.col}:${row.targetHint}:${row.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}