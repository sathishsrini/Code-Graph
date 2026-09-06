// Boot-dump artifact: the shape emitted by adapters/fastify/boot-dump.cjs.
//
// This is the boot channel's contract (R25). Everything here is `certain` —
// it is what the framework said about itself at boot, not what a parser
// inferred from source. P0-T9's `flow` and P1-T8's route_chain expander both
// read it, so the shape lives here rather than inside the CLI.

import { readFileSync } from "node:fs";

/** Fastify request lifecycle phase, plus the synthetic `handler` position. */
export type ChainPhase =
  | "onRequest" | "preParsing" | "preValidation" | "preHandler"
  | "handler"
  | "preSerialization" | "onSend" | "onResponse"
  | "onError" | "onTimeout" | "onRequestAbort";

/**
 * Where a chain entry came from. Kept separate from `phase` because they
 * answer different questions: `phase` is when it runs, `origin` is what put
 * it there — and only `scope` entries can be inherited.
 */
export type ChainOrigin = "scope" | "route" | "framework";

export interface ChainEntry {
  /** 0-based execution order within this route's chain. */
  position: number;
  phase: ChainPhase;
  /** `fn.name`, or null when the hook is an anonymous arrow. */
  name: string | null;
  /**
   * Stable identity: `relative/path.js:line:col`. Anonymous hooks are the
   * common case, so position — not name — is what a route_chain row is keyed
   * on, and what joins to the SCIP definition containing this line.
   */
  key: string;
  file: string | null;
  line: number | null;
  col: number | null;
  anonymous: boolean;
  origin: ChainOrigin;
  /** Encapsulation scope that declared it (`root`, or a plugin name). */
  declaredIn: string | null;
  /** Set only when the declaring scope is shallower than the route's own. */
  inheritedFrom: string | null;
}

export interface BootRoute {
  method: string;
  url: string;
  prefix: string;
  /** `<service> <METHOD> <url>` — the `route` node key. */
  routeKey: string;
  constraints: Record<string, unknown> | null;
  hasSchema: boolean;
  logLevel: string | null;
  /** Ordered execution chain: hooks and the handler, interleaved by phase. */
  chain: ChainEntry[];
  /** onError / onTimeout / onRequestAbort — real, but off the request path. */
  offPath: Omit<ChainEntry, "position">[];
}

export interface BootDump {
  schema: "codeintel.boot.fastify/1";
  service: string;
  generatedAt: string;
  evidenceKind: "boot";
  confidence: "certain";
  tool: {
    adapter: string;
    fastify: string | null;
    fastifyOverview: string | null;
    node: string;
  };
  entrypoint: string;
  repoRoot: string;
  stats: {
    routes: number;
    chainEntries: number;
    anonymousChainEntries: number;
    /** Non-zero means hooks exist that could not be located. A gap, not a zero. */
    unlocatedChainEntries: number;
  };
  routes: BootRoute[];
  /** fastify-overview's plugin tree; null unless --overview was passed. */
  overview: unknown;
  warnings: string[];
}

export function readBootDump(path: string): BootDump {
  const dump = JSON.parse(readFileSync(path, "utf8")) as BootDump;
  if (dump.schema !== "codeintel.boot.fastify/1") {
    throw new Error(`${path}: unexpected boot dump schema "${dump.schema}"`);
  }
  return dump;
}

/** Look up one route. `method` is matched case-insensitively. */
export function findRoute(
  dump: BootDump, method: string, url: string,
): BootRoute | undefined {
  const m = method.toUpperCase();
  return dump.routes.find((r) => r.method.toUpperCase() === m && r.url === url);
}
