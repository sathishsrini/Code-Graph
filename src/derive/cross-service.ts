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
//
// Revision (CTX-S12, frontend -> backend). The other wrapper shape: the URL is
// built *inside* the wrapper from a parameter — `fetch(`${BASE}${path}`)` in
// `60-kri-next/lib/api.ts` — so the path is only known at each caller, in
// other files. `collectPathWrappers` runs over the whole repo: a named
// function whose `${BASE}${param}` URL reaches a client call is a wrapper; its
// callers are the calls whose callee SCIP resolves to the wrapper's own
// definition symbol (never a name match); a caller that passes its own
// parameter on (`api.post = (path, b) => apiFetch(path, …)`) is a wrapper in
// turn. Each literal path at a final call site is then matched like any other
// URL, with the method taken from that call's options. The base still comes
// from the env binding's loopback default, so every such edge is `inferred`
// and says so: the env var may point elsewhere at runtime (plan §4.2).

import type { RepoConfig } from "../config/repos.ts";
import {
  enclosingFunction,
  type CallArg,
  type CallSite,
  type EnvBinding,
  type FileFindings,
  type FunctionRange,
  type HttpFinding,
  type UrlExpr,
} from "../static/treesitter/extract.ts";
import {
  hasRole, ROLE_DEFINITION, type ScipIndex, type ScipOccurrence,
} from "../static/scip/reader.ts";

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
  /**
   * CTX-S12. The repo's path wrappers, from `collectPathWrappers`. Call sites
   * in this file are resolved here; a wrapper's own URL is not.
   */
  wrappers?: PathWrapper[];
}

/** Hosts that can name a service running in this workspace. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Resolve every URL expression in one file without writing facts.
 *
 * Each expression is attributed to its enclosing function. A URL only
 * participates if that function (or a callee wrapper it calls by name)
 * contains an HTTP client call. A non-consumed string — a route registration,
 * a CORS origin, a header default — is not an unresolved *call*: R11's row
 * exists for call sites whose target could not be named, so config that can
 * never be a request yields neither a request nor a gap row (review, 2026-09-07).
 */
export function resolveCrossService(input: LinkInput): LinkResult {
  const requests: RequestLink[] = [];
  const unresolved: UnresolvedLink[] = [];
  const bindings = new Map(input.findings.envBindings.map((b) => [b.name, b]));
  const wrappers = wrapperHolders(input.findings);
  const consumption = new Map<number, boolean>();
  // CTX-S12: a path wrapper's own `${BASE}${path}` has no path to match; its
  // call sites carry the rows instead, so it is neither an edge nor a gap here.
  const pathWrappers = input.wrappers ?? [];
  const wrapperUrls = new Set(pathWrappers
    .filter((w) => w.root.file === input.findings.path)
    .map((w) => `${w.root.url.line}:${w.root.url.col}`));

  for (const url of input.findings.urls) {
    if (wrapperUrls.has(`${url.line}:${url.col}`)) continue;
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
    // Not consumed => not a request at this analysis depth, and not a gap.
    // `reply.header('Access-Control-Allow-Origin', origin || 'http://…')` and
    // FastAPI's `allow_origins=[…]` are config values; rows for strings that
    // can never be a call would dilute the "could not resolve this call"
    // signal that R11's table is for. A module-level URL can only be consumed
    // by a module-level client call, which itself records an HttpFinding, so
    // dropping the row loses no edge.
    if (!consumedByHttp(fn, input, wrappers, consumption)) continue;

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
        reason: url.dynamic && !dynamicOnlyInQuery(url.literalPath)
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

  // CTX-S12: calls of a path wrapper made in this file. A call that passes its
  // own parameter on is a link in a longer chain; its callers carry the rows.
  for (const w of pathWrappers) {
    for (const site of w.callSites) {
      if (site.file !== input.findings.path || site.chained) continue;
      const row = resolveWrapperCall(w, site.call, input);
      if ("routeNodeId" in row) requests.push(row);
      else unresolved.push(row);
    }
    // No caller found anywhere: the wrapper's own line keeps the gap (R11).
    if (w.file === input.findings.path && w.callSites.length === 0) {
      unresolved.push(uncalledWrapper(w));
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
  // CTX-S12: `/api/v1/po/${id}` is known only up to `/api/v1/po/`. Matching
  // that prefix as if it were the whole path lands on GET /api/v1/po, the
  // list route: a false edge. Only a dynamic query string leaves the path
  // itself complete. (Latent until frontend templates reached this matcher.)
  if (dynamic && !dynamicOnlyInQuery(literalPath)) return false;
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

/** The literal prefix already reached `?` or `#`, so every dynamic part is after the path. */
function dynamicOnlyInQuery(literalPath: string): boolean {
  return /[?#]/.test(literalPath);
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
// CTX-S12: path wrappers, traced to the literal each caller passes
// ---------------------------------------------------------------------------

/**
 * A method, or null when it cannot be known statically, and why. Null never
 * falls back to GET: the route match then uses the path alone, and a path
 * shared by two methods becomes an ambiguous gap rather than a guess.
 */
interface MethodFact {
  method: string | null;
  source: string;
}

/**
 * A function that sends a request to `${BASE}${param}`, directly or by passing
 * its own parameter to another wrapper.
 */
export interface PathWrapper {
  file: string;
  fn: FunctionRange;
  /** Verbatim SCIP symbol at the wrapper's name; null when SCIP has none (R4). */
  symbol: string | null;
  /** Which argument carries the path. */
  pathIndex: number;
  /** Literal text the URL puts between the base and the parameter. */
  prefix: string;
  /** Which argument is passed on as the request's options, if any. */
  optionsIndex: number | null;
  /** A method this wrapper, or one below it, states for every caller. */
  fixed: MethodFact | null;
  /** The URL at the bottom of the chain and its file's env bindings. */
  root: { file: string; url: UrlExpr; client: string; bindings: EnvBinding[] };
  /** Where the wrapper's own gap goes if nothing calls it. */
  at: { line: number; col: number };
  /** `post() lib/api.ts:12 -> apiFetch() lib/api.ts:6`, for the edge detail. */
  via: string;
  callSites: Array<{ file: string; call: CallSite; chained: boolean }>;
}

/** The SCIP symbol whose occurrence covers `path:line:col` (line 1-based, col 0-based). */
export type SymbolLookup = (path: string, line: number, col: number) => string | null;

/** Wrappers of wrappers, followed this far; deeper links stay gaps. */
const MAX_WRAPPER_DEPTH = 4;

/**
 * Occurrence lookup over a SCIP index. Positions come from tree-sitter, whose
 * columns are UTF-16 units like scip-typescript's. A definition wins over a
 * reference on the same range.
 */
export function scipSymbolLookup(index: ScipIndex): SymbolLookup {
  // Names are single-line occurrences; key them by file and 1-based line.
  const byLine = new Map<string, ScipOccurrence[]>();
  for (const doc of index.documents) {
    const file = doc.relativePath.split("\\").join("/");
    for (const occ of doc.occurrences) {
      if (occ.range.startLine !== occ.range.endLine) continue;
      const key = `${file}:${occ.range.startLine + 1}`;
      const list = byLine.get(key);
      if (list) list.push(occ); else byLine.set(key, [occ]);
    }
  }
  return (path, line, col) => {
    let best: ScipOccurrence | null = null;
    for (const occ of byLine.get(`${path}:${line}`) ?? []) {
      const r = occ.range;
      if (col < r.startChar || col >= r.endChar) continue;
      if (!best || (hasRole(occ.symbolRoles, ROLE_DEFINITION) && !hasRole(best.symbolRoles, ROLE_DEFINITION))) {
        best = occ;
      }
    }
    return best?.symbol ?? null;
  };
}

/**
 * Find every path wrapper in one repo and the calls made to each.
 *
 * Callers are identified only through SCIP: the symbol of the occurrence at a
 * call's callee must equal the wrapper's definition symbol. Without an index
 * (`symbolOf` null) the wrappers are still returned, with no callers, so each
 * keeps its gap instead of being matched by name.
 */
export function collectPathWrappers(
  files: FileFindings[], symbolOf: SymbolLookup | null,
): PathWrapper[] {
  const wrappers: PathWrapper[] = [];
  for (const findings of files) {
    for (const url of findings.urls) {
      if (url.baseVar === null || !url.pathVar) continue;
      const fn = enclosingFunction(findings.functions, url.line);
      const pathIndex = fn?.params?.indexOf(url.pathVar) ?? -1;
      // A local path variable, or an unnamed function, is not traceable: the
      // URL stays with the ordinary per-file rows.
      if (!fn || fn.name === null || pathIndex < 0) continue;
      const client = findings.https.find((h) => enclosingFunction(findings.functions, h.line) === fn);
      if (!client) continue;
      const optionsIndex = client.optionsVar ? fn.params!.indexOf(client.optionsVar) : -1;
      // The client's default method is only safe when every place a method
      // could come from is visible: a literal, or a caller's options.
      const opaque = client.optionsOpaque || (client.optionsVar && optionsIndex < 0);
      wrappers.push({
        file: findings.path, fn, symbol: definitionSymbol(symbolOf, findings.path, fn),
        pathIndex, prefix: url.literalPath,
        optionsIndex: optionsIndex >= 0 ? optionsIndex : null,
        fixed: client.method
          ? { method: client.method, source: `${fn.name}()'s own ${client.client}() options (${findings.path}:${client.line})` }
          : client.methodDynamic
            ? { method: null, source: `${fn.name}()'s ${client.client}() options set the method from an expression` }
            : opaque
              ? { method: null, source: `${fn.name}()'s ${client.client}() options come from ${client.optionsVar ? `\`${client.optionsVar}\`, a local` : "an expression"} the linker does not follow` }
              : null,
        root: { file: findings.path, url, client: client.client, bindings: findings.envBindings },
        at: { line: url.line, col: url.col },
        via: `${fn.name}() ${findings.path}:${url.line}`,
        callSites: [],
      });
    }
  }
  if (symbolOf === null) return wrappers;

  const sites = files.flatMap((findings) => findings.calls.map((call) => ({
    findings, call, symbol: symbolOf(findings.path, call.calleeAt.line, call.calleeAt.col),
  })));
  // Deduplicated by the function's position and its root URL, not its symbol:
  // a wrapper SCIP cannot name still needs its own gap row, and a function
  // that feeds two different wrappers sends two requests.
  const at = (w: PathWrapper): string =>
    `${w.file}#${w.fn.line}:${w.fn.col}>${w.root.file}#${w.root.url.line}:${w.root.url.col}`;
  const known = new Set(wrappers.map(at));
  let frontier = wrappers.filter((w) => w.symbol !== null);
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: PathWrapper[] = [];
    for (const w of frontier) {
      for (const site of sites) {
        if (!sameSymbol(site.symbol, site.findings.path, w)) continue;
        const derived = depth < MAX_WRAPPER_DEPTH
          ? chainedWrapper(w, site.findings, site.call, symbolOf) : null;
        w.callSites.push({ file: site.findings.path, call: site.call, chained: derived !== null });
        // A second path into a known wrapper (or recursion) adds no wrapper.
        if (derived && !known.has(at(derived))) {
          known.add(at(derived));
          next.push(derived);
        }
      }
    }
    wrappers.push(...next);
    frontier = next.filter((w) => w.symbol !== null);
  }
  return wrappers;
}

/** SCIP `local N` symbols are unique per document only. */
function sameSymbol(symbol: string | null, file: string, w: PathWrapper): boolean {
  if (symbol === null || symbol !== w.symbol) return false;
  return !symbol.startsWith("local ") || file === w.file;
}

function definitionSymbol(symbolOf: SymbolLookup | null, file: string, fn: FunctionRange): string | null {
  return symbolOf && fn.nameAt ? symbolOf(file, fn.nameAt.line, fn.nameAt.col) : null;
}

/** A call inside a named function that passes that function's own parameter as the path. */
function chainedWrapper(
  w: PathWrapper, findings: FileFindings, call: CallSite, symbolOf: SymbolLookup,
): PathWrapper | null {
  const arg = call.args[w.pathIndex];
  if (arg?.kind !== "identifier") return null;
  const fn = enclosingFunction(findings.functions, call.line);
  const pathIndex = fn?.params?.indexOf(arg.name) ?? -1;
  if (!fn || fn.name === null || pathIndex < 0) return null;
  const where = `${fn.name}()'s call to ${w.fn.name}() (${findings.path}:${call.line})`;
  return {
    file: findings.path, fn, symbol: definitionSymbol(symbolOf, findings.path, fn),
    pathIndex, prefix: w.prefix,
    ...forwardedMethod(w, call.args, fn.params!, where),
    root: w.root,
    at: { line: call.line, col: call.col },
    via: `${fn.name}() ${findings.path}:${call.line} -> ${w.via}`,
    callSites: [],
  };
}

/**
 * What a call's own arguments say about the method, or null when they say
 * nothing (no options passed, or options without a method).
 */
function statedMethod(w: PathWrapper, args: CallArg[], where: string): MethodFact | null {
  const arg = w.optionsIndex === null ? undefined : args[w.optionsIndex];
  if (arg === undefined) return null;            // the caller's options never reach the client
  if (arg.kind !== "object") {
    return { method: null, source: `${where} passes options as ${arg.raw}, not an object literal` };
  }
  if (arg.method !== null) {
    return w.fixed && w.fixed.method !== arg.method
      ? { method: null, source: `${where} sets ${arg.method} but ${w.fn.name}() also sets a method; which wins depends on spread order` }
      : { method: arg.method, source: where };
  }
  if (arg.methodDynamic) return { method: null, source: `${where} sets the method from an expression` };
  if (arg.spreads.length > 0) return { method: null, source: `${where} spreads options that may carry a method` };
  return null;
}

/** The method a call through `w` sends. The client's default applies last. */
function methodAt(w: PathWrapper, args: CallArg[], where: string): MethodFact {
  return statedMethod(w, args, where) ?? w.fixed ?? {
    method: "GET", source: `${w.root.client}'s default: no method in its options`,
  };
}

/** A chained wrapper either passes its caller's options on, or settles the method itself. */
function forwardedMethod(
  w: PathWrapper, args: CallArg[], params: string[], where: string,
): Pick<PathWrapper, "optionsIndex" | "fixed"> {
  const arg = w.optionsIndex === null ? undefined : args[w.optionsIndex];
  const passOn = arg?.kind === "identifier" ? arg.name
    : arg?.kind === "object" && arg.method === null && !arg.methodDynamic && arg.spreads.length === 1
      ? arg.spreads[0]! : null;
  if (passOn && params.includes(passOn)) return { optionsIndex: params.indexOf(passOn), fixed: w.fixed };
  return { optionsIndex: null, fixed: statedMethod(w, args, where) ?? w.fixed };
}

/** One final call of a wrapper: an inferred edge, or a gap that says why not. */
function resolveWrapperCall(w: PathWrapper, call: CallSite, input: LinkInput): RequestLink | UnresolvedLink {
  const pos = { line: call.line, col: call.col };
  const arg = call.args[w.pathIndex];
  const callText = `${call.callee}(${arg?.raw ?? ""})`;
  const gap = (targetHint: string, reason: string): UnresolvedLink => ({ ...pos, targetHint, reason });

  if (arg === undefined) return gap(callText, `no argument for the path parameter of ${w.fn.name}()`);
  if (arg.kind === "identifier") return gap(callText, identifierReason(arg.name, call, input.findings));
  if (arg.kind === "object" || arg.kind === "other") {
    return gap(callText, `path argument ${arg.raw} is an expression, not a literal`);
  }
  const dynamic = arg.kind === "template";
  const path = w.prefix + (arg.kind === "string" ? arg.text : arg.literalPrefix);

  const bindings = new Map(w.root.bindings.map((b) => [b.name, b]));
  const base = resolveBase(w.root.url, input.repo, input.repos, bindings);
  if (base === null) return gap(callText, baseFailureReason(w.root.url, input.repo, bindings));

  const method = methodAt(w, call.args, `the call site's options (${input.findings.path}:${call.line})`);
  const candidates = input.targets.filter((target) =>
    target.service === base.service &&
    (method.method === null || target.method === method.method) &&
    routeMatches(target.url, path, dynamic),
  );
  const hint = `${base.service} ${method.method ?? "?"} ${path}`;

  if (candidates.length === 1) {
    const target = candidates[0]!;
    return {
      routeNodeId: target.nodeId, ...pos, method: method.method, baseVar: w.root.url.baseVar, path,
      detail: [
        `${callText} -> ${target.service} ${target.method} ${target.url}`,
        `path traced through ${w.via}`,
        method.method
          ? `method ${method.method} from ${method.source}`
          : `method unknown (${method.source}), matched on path only`,
        baseNote(w, base.service),
      ].join(" · "),
    };
  }
  if (candidates.length === 0) {
    return gap(hint, dynamic && !dynamicOnlyInQuery(path)
      ? `path argument ${arg.raw} is a template: only its literal prefix ${JSON.stringify(path)} is known, so it cannot be matched to a unique route`
      : `no indexed route matches ${method.method ?? "any method"} ${path}`);
  }
  return gap(hint, `ambiguous route match (${candidates.length} candidates)` +
    (method.method === null ? `; method unknown (${method.source})` : ""));
}

function identifierReason(name: string, call: CallSite, findings: FileFindings): string {
  const fn = enclosingFunction(findings.functions, call.line);
  if (!fn?.params?.includes(name)) return `path argument \`${name}\` is a variable, not a literal`;
  return fn.name === null
    ? `path argument \`${name}\` is a parameter of an anonymous function, whose callers cannot be traced`
    : `path argument \`${name}\` is a parameter of ${fn.name}(); wrapper chains deeper than ${MAX_WRAPPER_DEPTH} are not traced`;
}

/** The base's provenance, and the limit that keeps the edge `inferred`. */
function baseNote(w: PathWrapper, service: string): string {
  const baseVar = w.root.url.baseVar!;
  const binding = w.root.bindings.find((b) => b.name === baseVar);
  const envVar = binding?.envVar ?? baseVar;
  const via = binding?.defaultUrl
    ? `its loopback default ${binding.defaultUrl}`
    : "the env var's name (it has no default)";
  return `base ${baseVar} = ${envVar}, resolved to ${service} through ${via}; ` +
    `inferred: ${envVar} may point elsewhere at runtime (env-driven fork, plan §4.2)`;
}

function uncalledWrapper(w: PathWrapper): UnresolvedLink {
  const param = w.fn.params?.[w.pathIndex] ?? "?";
  return {
    ...w.at,
    targetHint: `${w.fn.name}(${param})`,
    reason: `path is parameter \`${param}\` of ${w.fn.name}(); ` + (w.symbol === null
      ? "its callers are identified only by SCIP symbol, and SCIP has no definition at its name (no index, or the name is not indexed)"
      : `no call site of ${w.symbol} was found in this repo's indexed files`),
  };
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