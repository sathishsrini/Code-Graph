// ============================================================================
// MCP server  —  task P1-T16  (requirement R48)  ·  PHASE 1 EXIT CRITERION
// ============================================================================
// Exposes the four queries over MCP so an agent can call them instead of
// dumping files. This is the gate: the phase is done when an agent in a real
// setup gets materially better context this way than by reading source.
//
// Three decisions worth stating, because each is a place where an MCP server
// can quietly ruin the thing it exposes:
//
// **The tools return TOON, not JSON.** R44's whole point is that the consumer
// is a model with a context budget. Returning the raw report object would undo
// the packing — `context_pack` measured 4-26% of a file dump (M9), and JSON
// with a repeated key per row gives most of that back.
//
// **Errors are results, not protocol failures.** An ambiguous symbol or a
// missing route is an *answer* — "here are the four things you might have
// meant" — and a model can act on it. Throwing turns it into a transport error
// the model sees as a broken tool.
//
// **Every tool description states its confidence semantics.** The graph
// distinguishes certain from inferred everywhere, and a model that does not
// know that will read an inferred edge as fact. The descriptions are part of
// the contract, not documentation.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FactStore } from "../store/db.ts";
import { endpointFlow, RouteNotFound } from "../query/endpoint-flow.ts";
import { impact, SeedNotFound } from "../query/impact.ts";
import { securityPath } from "../query/security.ts";
import { contextPack, packToToon, measureTokenDelta } from "../query/context-pack.ts";
import { encodeToon } from "../serializers/toon.ts";

const CONFIDENCE_NOTE =
  "Every edge carries a confidence: 'certain' (the compiler resolved it), " +
  "'inferred' (a parser guessed it), 'observed' (runtime saw it), 'unresolved' " +
  "(a known gap). A path is only as trustworthy as its weakest edge. Treat " +
  "'inferred' as a lead, never as a fact.";

const GAP_NOTE =
  "Results include an UNKNOWN/gaps section listing call sites the engine could " +
  "not resolve. It is never empty because nothing was found — it is empty only " +
  "when nothing was missed. Read it before concluding a path is complete.";

export const TOOLS = [
  {
    name: "endpoint_flow",
    description:
      "What executes on one HTTP endpoint: the ordered middleware/auth chain, " +
      "then the call tree beneath it, following outbound HTTP calls into other " +
      "services. Use this to answer 'what happens when this endpoint is hit'. " +
      `${CONFIDENCE_NOTE} ${GAP_NOTE} ` +
      "The chain is reported in two blocks that must not be conflated: boot " +
      "(what the framework itself reported, certain) and inline security checks " +
      "(what a parser found in the handler body, inferred).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. '40-kri-router'." },
        method: { type: "string", description: "HTTP method, e.g. 'POST'." },
        path: { type: "string", description: "Route template as the framework reports it, e.g. '/api/v1/po/:id'." },
        depth: { type: "number", description: "Call-tree depth cap. Default 12." },
        followRemote: { type: "boolean", description: "Follow outbound calls into other services. Default true." },
      },
      required: ["service", "method", "path"],
    },
  },
  {
    name: "impact",
    description:
      "What breaks if a symbol changes: direct callers, transitive callers, and " +
      "the HTTP routes they serve, segmented by confidence. Also reports " +
      "configuration and data coupling — other code reading the same env var or " +
      "writing the same table — which no call graph can see. " +
      "A high fan-in symbol is flagged as a utility rather than listed against " +
      "200 endpoints, because an answer of 'everything' is not an answer. " +
      `${CONFIDENCE_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "A function name, or a verbatim SCIP symbol, or a repo-relative " +
            "file path. An ambiguous name returns the candidates instead of guessing.",
        },
        depth: { type: "number", description: "Reverse-closure depth cap. Default 12." },
        routeLimit: { type: "number", description: "Routes to list before trimming. The count stays exact. Default 25." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "security_path",
    description:
      "Security coverage: a routes x check-kinds matrix, and the anomaly query " +
      "'routes that write data with no tenant check'. " +
      "It answers which checks run and in what order. It does NOT answer whether " +
      "a check is correct — 'requireRole(admin)' where 'requireRole(owner)' was " +
      "meant is indistinguishable here. Never report a route as secure on this " +
      "basis; report which checks were found and by which channel. " +
      "'No check' means 'none this engine can see' — a public health route and a " +
      "route whose guard went undetected look identical.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Limit to one service. Omit for all." },
        anomalyKind: { type: "string", description: "Check kind whose absence over a write is flagged. Default 'tenant'." },
      },
    },
  },
  {
    name: "context_pack",
    description:
      "The minimum context needed to edit a function, as a token-budgeted pack: " +
      "its signature and source, what it calls, who calls it, the routes it runs " +
      "on, the security checks on those routes, config and datastores it touches, " +
      "and the gaps the engine could not resolve. " +
      "Prefer this over reading whole files — it measured 4-26% of the tokens of " +
      "dumping the files it covers. Tiers dropped for budget are named in the " +
      "output; the gaps section is never dropped. " +
      `${CONFIDENCE_NOTE} ` +
      "Items marked [file-scope] were attributed to the file, not to this " +
      "symbol — the coupling is real but coarser than the function you asked about.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Function name, verbatim SCIP symbol, or file path." },
        budget: { type: "number", description: "Token budget. Default 4000." },
        includeSource: { type: "boolean", description: "Include the seed's raw source. Default true. Set false for the smallest pack." },
      },
      required: ["symbol"],
    },
  },
] as const;

type Args = Record<string, unknown>;

const str = (a: Args, k: string): string => String(a[k] ?? "");
const num = (a: Args, k: string): number | undefined =>
  typeof a[k] === "number" ? (a[k] as number) : undefined;
const bool = (a: Args, k: string): boolean | undefined =>
  typeof a[k] === "boolean" ? (a[k] as boolean) : undefined;

/**
 * Run one tool against the store.
 *
 * Exported and store-injected so the tools can be tested without a transport.
 * An MCP server whose logic is only reachable through stdio is a server nobody
 * writes a test for.
 */
export function callTool(store: FactStore, name: string, args: Args): string {
  switch (name) {
    case "endpoint_flow": {
      try {
        const flow = endpointFlow(store, str(args, "service"), str(args, "method"), str(args, "path"), {
          maxDepth: num(args, "depth"),
          followRemote: bool(args, "followRemote"),
        });
        return encodeToon(flowForModel(flow));
      } catch (e) {
        if (e instanceof RouteNotFound) {
          // An answer, not a failure: the model can pick from these.
          return encodeToon({
            error: e.message,
            knownRoutes: e.candidates.map((c) => ({ method: c.method, url: c.url })),
          });
        }
        throw e;
      }
    }

    case "impact": {
      try {
        const r = impact(store, str(args, "symbol"), {
          maxDepth: num(args, "depth"),
          routeLimit: num(args, "routeLimit"),
        });
        return encodeToon({
          symbol: r.seed.display,
          file: r.seed.file ?? "",
          fanIn: r.fanIn,
          isUtility: r.isUtility,
          utilityNote: r.isUtility
            ? "High fan-in. Treat the route list as 'most of the service', not a review list."
            : "",
          totalRoutes: r.totalRoutes,
          routesTrimmed: r.routesTruncated,
          directCallers: r.direct.map((s) => ({ name: s.display, where: `${s.file}:${s.line}`, confidence: s.pathConfidence })),
          transitiveCallers: r.transitive.map((s) => ({ name: s.display, depth: s.depth, confidence: s.pathConfidence })),
          routesCertain: r.routes.certain.map(routeRow),
          routesInferred: r.routes.inferred.map(routeRow),
          routesUnknown: r.routes.unknown.map(routeRow),
          configCoupling: r.configuration.map((c) => ({ node: c.key, attributedTo: c.attributedTo, alsoUsedBy: c.alsoUsedBy.length })),
          dataCoupling: r.data.map((c) => ({ node: c.key, attributedTo: c.attributedTo, alsoUsedBy: c.alsoUsedBy.length })),
          runtimeCoupling: r.runtime.available ? "" : r.runtime.reason,
          gaps: r.unknownEdges.map((u) => ({ where: `${u.file}:${u.line}`, symbol: u.srcKey, reason: u.reason })),
        });
      } catch (e) {
        if (e instanceof SeedNotFound) {
          return encodeToon({
            error: e.message,
            candidates: e.matches.map((m) => ({ name: m.display, key: m.key })),
          });
        }
        throw e;
      }
    }

    case "security_path": {
      const service = str(args, "service");
      const anomalyKind = str(args, "anomalyKind") || "tenant";
      const r = securityPath(store, {
        service: service || undefined,
        anomalyKind,
      });
      return encodeToon({
        scopeNote:
          "Reports which checks run, never whether they are correct. " +
          "'No check' means none this engine can see.",
        coverage: r.routes.map((route) => ({
          route: `${route.method} ${route.url}`,
          service: route.service,
          boot: kindsBy(route.coverage, "boot"),
          inferred: kindsBy(route.coverage, "inline"),
          writes: route.writes.length,
        })),
        anomalyKind,
        anomalies: r.anomalies.map((a) => ({
          route: `${a.route.method} ${a.route.url}`,
          service: a.route.service,
          has: a.has.join("|"),
          writes: a.route.writes.map((w) => w.datastore).join("|"),
        })),
        noChecksFound: r.unprotected.map((x) => `${x.method} ${x.url}`),
        blindSpots: r.blindSpots.map((b) => ({ route: b.routeKey, phase: b.phase, at: b.key ?? "" })),
      });
    }

    case "context_pack": {
      try {
        const pack = contextPack(store, str(args, "symbol"), {
          budget: num(args, "budget"),
          includeSource: bool(args, "includeSource"),
        });
        const delta = measureTokenDelta(store, pack);
        return `${packToToon(pack)}\n${encodeToon({
          tokensVsFileDump: `${(delta.ratio * 100).toFixed(0)}%`,
          filesThisReplaces: delta.files,
        })}\n`;
      } catch (e) {
        if (e instanceof SeedNotFound) {
          return encodeToon({
            error: e.message,
            candidates: e.matches.map((m) => ({ name: m.display, key: m.key })),
          });
        }
        throw e;
      }
    }

    default:
      return encodeToon({
        error: `unknown tool "${name}"`,
        available: TOOLS.map((t) => t.name),
      });
  }
}

function routeRow(r: { service: string; method: string; url: string; depth: number; viaSymbol: string }) {
  return { service: r.service, route: `${r.method} ${r.url}`, depth: r.depth, via: r.viaSymbol };
}

function kindsBy(coverage: Record<string, string[]>, channel: string): string {
  return Object.entries(coverage)
    .filter(([, channels]) => channels.includes(channel))
    .map(([kind]) => kind)
    .sort()
    .join("|");
}

/** Flatten a flow for a model: the tree as indented rows, not nested objects. */
function flowForModel(flow: ReturnType<typeof endpointFlow>): Record<string, unknown> {
  const chainRows: Array<Record<string, unknown>> = [];
  const treeRows: Array<Record<string, unknown>> = [];

  for (const step of flow.chain) {
    chainRows.push({
      position: step.position,
      phase: step.phase,
      name: step.name ?? "(anonymous)",
      channel: step.evidenceKind === "boot" ? "boot" : "inferred",
      confidence: step.confidence,
      checkKind: step.checkKind ?? "",
      at: step.key ?? "",
    });
    if (!step.tree) continue;

    const walk = (node: typeof step.tree, depth: number): void => {
      if (!node) return;
      if (depth > 0) {
        treeRows.push({
          depth,
          name: node.display,
          edge: node.edgeType ?? "",
          confidence: node.edge,
          pathConfidence: node.pathConfidence,
          at: node.line ? `${node.file}:${node.line}` : "",
          note: node.cycle ? "cycle" : node.truncated ? "depth-cap" : node.boundary ? "boundary" : "",
        });
      }
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(step.tree, 0);
  }

  return {
    service: flow.service,
    route: `${flow.method} ${flow.url}`,
    chain: chainRows,
    callTree: treeRows,
    servicesReached: flow.visitedServices,
    unjoinedChainEntries: flow.unjoined.map((c) => ({ phase: c.phase, at: c.key ?? "" })),
    gaps: flow.unknown.map((u) => ({
      at: `${u.file}:${u.line}`, symbol: u.srcDisplay, reason: u.reason,
    })),
  };
}

// ---------------------------------------------------------------------------

export async function startMcpServer(dbPath: string): Promise<void> {
  const store = new FactStore(dbPath);
  const server = new Server(
    { name: "code-intel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    try {
      return { content: [{ type: "text" as const, text: callTool(store, name, args ?? {}) }] };
    } catch (e) {
      // A real fault — a broken query, a corrupt store. Reported as a tool
      // error so the model can tell it apart from "no such route", which is an
      // ordinary result above.
      return {
        content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
