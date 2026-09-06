// ============================================================================
// FastAPI boot artifact  —  task P1-T4  (requirements R22, R23, R25)
// ============================================================================
// The shape emitted by `adapters/fastapi/boot_dump.py`, and the adapter that
// narrows it onto the same `BootDump` the Fastify channel produces.
//
// Two frameworks, one downstream. P1-T8 ingests route chains, R40 queries them
// and P2-T4 colours them, and none of those should contain a branch on which
// framework a service uses. So the difference is absorbed here, once, and
// where the frameworks genuinely differ the difference is preserved rather
// than flattened:
//
//   Fastify hooks are PER ROUTE and inheritable through plugin scopes.
//   Starlette middleware is APP-WIDE — it wraps the router, so every route in
//   the app carries the same prefix, and `inheritedFrom` is the app itself.
//
// Collapsing that into "hooks" would be convenient and would make an
// inherited-hook query silently wrong on Python services.
// ============================================================================

import { readFileSync } from "node:fs";
import type { BootDump, BootRoute, ChainEntry, ChainPhase } from "./dump.ts";

export interface FastapiChainEntry {
  position: number;
  phase: "middleware" | "dependency" | "handler";
  name: string | null;
  key: string;
  file: string | null;
  line: number | null;
  col: number | null;
  anonymous: boolean;
  origin: "scope" | "route" | "framework";
  declaredIn: string | null;
  inheritedFrom: string | null;
  checkKind: string | null;
  locationError: string | null;
  /** dependency only: nesting depth of `Depends(...)` within `Depends(...)`. */
  depth?: number;
  /** dependency only: FastAPI classified this as a security scheme. */
  security?: boolean;
  /** middleware only: the Starlette class, when the callable is a dispatch fn. */
  middlewareClass?: string;
}

export interface FastapiRoute {
  method: string;
  url: string;
  prefix: string;
  routeKey: string;
  constraints: null;
  hasSchema: boolean;
  logLevel: null;
  endpointModule: string | null;
  endpointQualname: string | null;
  chain: FastapiChainEntry[];
  offPath: never[];
}

export interface FastapiDump {
  schema: "codeintel.boot.fastapi/1";
  service: string;
  generatedAt: string;
  evidenceKind: "boot";
  confidence: "certain";
  tool: { adapter: string; fastapi: string; starlette: string; python: string };
  entrypoint: string;
  repoRoot: string;
  stats: {
    routes: number;
    nonApiRoutes: number;
    chainEntries: number;
    anonymousChainEntries: number;
    unlocatedChainEntries: number;
    middleware: number;
  };
  routes: FastapiRoute[];
  middleware: FastapiChainEntry[];
  openapi: unknown;
  /** R23: key names and whether each is set. Never values. */
  config: Array<{ name: string; isSet: boolean }>;
  warnings: string[];
}

export function readFastapiDump(path: string): FastapiDump {
  const dump = JSON.parse(readFileSync(path, "utf8")) as FastapiDump;
  if (dump.schema !== "codeintel.boot.fastapi/1") {
    throw new Error(`${path}: unexpected boot dump schema "${dump.schema}"`);
  }
  return dump;
}

/**
 * Map a FastAPI phase onto the shared `ChainPhase` vocabulary.
 *
 * `middleware` and `dependency` both land on `preHandler` because that is when
 * they run relative to the handler, which is the question every downstream
 * query asks. The Python-specific distinction survives in `origin` and in the
 * `detail` the ingester writes, so nothing is lost — it is moved to the field
 * that does not have to mean the same thing across frameworks.
 */
function phaseOf(entry: FastapiChainEntry): ChainPhase {
  if (entry.phase === "handler") return "handler";
  return "preHandler";
}

/** Narrow one FastAPI route onto the shared shape. */
export function toBootRoute(route: FastapiRoute, service: string): BootRoute {
  const chain: ChainEntry[] = route.chain.map((c) => ({
    position: c.position,
    phase: phaseOf(c),
    name: c.name,
    key: c.key,
    file: c.file,
    line: c.line,
    col: c.col,
    anonymous: c.anonymous,
    origin: c.origin,
    declaredIn: c.declaredIn,
    // App-wide middleware IS inherited — by every route in the app. Saying so
    // is the accurate answer to "where did this come from", and leaving it
    // null would read as "declared on this route", which is false.
    inheritedFrom: c.inheritedFrom ?? (c.phase === "middleware" ? service : null),
  }));

  return {
    method: route.method,
    url: route.url,
    prefix: route.prefix,
    routeKey: route.routeKey,
    constraints: route.constraints,
    hasSchema: route.hasSchema,
    logLevel: route.logLevel,
    chain,
    offPath: [],
  };
}

export function toBootDump(dump: FastapiDump): BootDump {
  return {
    schema: "codeintel.boot.fastify/1",
    service: dump.service,
    generatedAt: dump.generatedAt,
    evidenceKind: "boot",
    confidence: "certain",
    tool: {
      adapter: dump.tool.adapter,
      fastify: null,
      fastifyOverview: null,
      node: dump.tool.python,
    },
    entrypoint: dump.entrypoint,
    repoRoot: dump.repoRoot,
    stats: {
      routes: dump.stats.routes,
      chainEntries: dump.stats.chainEntries,
      anonymousChainEntries: dump.stats.anonymousChainEntries,
      unlocatedChainEntries: dump.stats.unlocatedChainEntries,
    },
    routes: dump.routes.map((r) => toBootRoute(r, dump.service)),
    overview: null,
    warnings: dump.warnings,
  };
}

/**
 * Security dependencies FastAPI itself classified.
 *
 * The one auth signal the framework hands over for free, and `certain` in a
 * way nothing static can be. This corpus produces none: `51-integration`
 * compares a bearer token with a plain header read inside the handler, so
 * every route reports zero here and R26's inline detector is what has to find
 * it. Read an empty result as "no security dependency", never as "no auth".
 */
export function securityDependencies(dump: FastapiDump): Array<{
  routeKey: string; name: string | null; key: string;
}> {
  const out: Array<{ routeKey: string; name: string | null; key: string }> = [];
  for (const route of dump.routes) {
    for (const entry of route.chain) {
      if (entry.security) out.push({ routeKey: route.routeKey, name: entry.name, key: entry.key });
    }
  }
  return out;
}
