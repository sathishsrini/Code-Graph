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
import { search, type SearchOutput } from "../query/workflow.ts";
import {
  featurePack, featurePackToToon, measureFeatureDelta, type FeatureTier,
} from "../query/feature-pack.ts";
import { collectProse } from "../llm/prose-tier.ts";
import { loadFeatures, DEFAULT_FEATURES_PATH } from "../config/features.ts";
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

/**
 * Ranking is not confidence, and it must not be reported as a number.
 *
 * `SearchCandidate` carries an RRF score, a bm25 and a cosine. A model shown
 * `0.0163` reads it as a probability of being right, which it is not — it is a
 * position in a list. So the tool emits an ordinal rank and the names of the
 * signals that agreed, and no magnitude at all. The raw values stay on the CLI
 * `--json` path, where a human is diagnosing the retrieval rather than acting
 * on it.
 */
const RANKING_NOTE =
  "The order is a RANKING, not a confidence: it says which indexed rows your " +
  "words matched best, never that the top row is what you meant. Candidates " +
  "report an ordinal rank and which retrieval signals agreed; no score is " +
  "given, because a number here would be read as a probability and it is not " +
  "one. An empty result means your words did not match the index — it is " +
  "never evidence that the behaviour does not exist.";

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
  {
    name: "search",
    description:
      "Search the CODE GRAPH — symbols, routes and files the engine indexed — " +
      "not the filesystem. It returns candidate SEEDS to pass to the other " +
      "tools, never file contents. Use it when you have a phrase rather than a " +
      "symbol: it is the way in when you do not already know what something is " +
      "called. " +
      `${RANKING_NOTE} ` +
      "Business names usually do not appear in identifiers. On this corpus " +
      "'GRN creation' matches nothing while POST /api/v1/grn exists, because " +
      "the only place that feature is named is the URL. For a business " +
      "capability rather than a code identifier, prefer feature_pack, which " +
      "consults a reviewed manifest before falling back to this search.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "What to look for, in your own words." },
        topK: { type: "number", description: "Candidates to return. Default 8." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["symbol", "route", "file"] },
          description:
            "Restrict to these node kinds. Applied before the top-K cut, so a " +
            "route ranked below K can still surface.",
        },
        seed: {
          type: "string",
          description:
            "A verbatim node key to use instead of the ranking, when you " +
            "already know which candidate is right.",
        },
      },
      required: ["phrase"],
    },
  },
  {
    name: "feature_pack",
    description:
      "Everything needed to change one BUSINESS FEATURE, as a single " +
      "token-budgeted document: its entry points across every service, the " +
      "security checks on them, the decision branches inside the handlers, " +
      "what they call, what else breaks if you change them, the config and " +
      "datastores they touch, and the gaps. " +
      "Use this when you have a capability in mind rather than a symbol — " +
      "'GRN creation', 'PO approval'. It checks a human-reviewed manifest " +
      "first and falls back to lexical search, and the output says which " +
      "answered: a manifest entry was reviewed by a person, a search hit was " +
      "not. " +
      `${CONFIDENCE_NOTE} ${GAP_NOTE} ` +
      "Two sections carry their own caveat and neither may be read as the " +
      "other. The cfg tier's 'when' is a SYNTACTIC guard path — which arm of " +
      "which enclosing branch a row sits in — not an execution trace. The " +
      "prose section is MODEL-GENERATED and is not extracted fact; every " +
      "other section came from a compiler, a boot dump or a parser. " +
      "Tiers too large for the budget are cut, never silently: the output " +
      "reports the number shown and the true total. The gaps section is " +
      "never cut.",
    inputSchema: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "The feature, in the words people use for it." },
        entries: {
          type: "array",
          items: { type: "string" },
          description:
            "Verbatim node keys to use as entry points, overriding both the " +
            "manifest and search. Use when you already know where a feature starts.",
        },
        budget: { type: "number", description: "Token budget. Default 12000." },
        maxSeeds: { type: "number", description: "Entry points to follow. Default 6." },
        skipTiers: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "entrypoints", "security", "callees", "cfg", "callers", "impact",
              "config", "datastores", "transitive", "prose",
            ],
          },
          description: "Tiers to omit, to spend the budget elsewhere. 'gaps' cannot be skipped.",
        },
      },
      required: ["phrase"],
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

    case "search": {
      // No try/catch: `search` reports `notBuilt` and a `reason` rather than
      // throwing, so every outcome is already an answer the model can act on.
      const kinds = Array.isArray(args["kinds"])
        ? (args["kinds"] as unknown[]).filter(
          (k): k is "symbol" | "route" | "file" =>
            k === "symbol" || k === "route" || k === "file",
        )
        : undefined;
      const seed = typeof args["seed"] === "string" ? args["seed"] : undefined;
      return encodeToon(searchForModel(search(store, str(args, "phrase"), {
        topK: num(args, "topK"),
        kinds: kinds && kinds.length > 0 ? kinds : undefined,
        correctedSeed: seed,
      })));
    }

    case "feature_pack": {
      const entries = Array.isArray(args["entries"])
        ? (args["entries"] as unknown[]).filter((e): e is string => typeof e === "string")
        : undefined;
      const skipTiers = Array.isArray(args["skipTiers"])
        ? (args["skipTiers"] as unknown[]).filter((t): t is FeatureTier => typeof t === "string")
        : undefined;

      let manifest = null;
      try {
        manifest = loadFeatures(DEFAULT_FEATURES_PATH);
      } catch (e) {
        // A malformed manifest must not look like "this feature is not listed".
        return encodeToon({
          error: `${DEFAULT_FEATURES_PATH}: ${(e as Error).message}`,
          fix: "run `node src/cli.ts features check`",
        });
      }

      // Seeds first, so the prose lookup asks about the nodes this pack is
      // actually built on. The packer itself has no path to that cache.
      const first = featurePack(store, str(args, "phrase"), {
        budget: num(args, "budget"),
        maxSeeds: num(args, "maxSeeds"),
        entries: entries && entries.length > 0 ? entries : undefined,
        skipTiers, manifest,
      });
      const prose = skipTiers?.includes("prose")
        ? []
        : collectProse(store, first.seeds.map((s) => s.seed.key));

      const pack = prose.length === 0 ? first : featurePack(store, str(args, "phrase"), {
        budget: num(args, "budget"),
        maxSeeds: num(args, "maxSeeds"),
        entries: entries && entries.length > 0 ? entries : undefined,
        skipTiers, manifest, prose,
      });

      const delta = measureFeatureDelta(store, pack);
      return `${featurePackToToon(pack)}${encodeToon({
        tokensVsFileDump: `${(delta.ratio * 100).toFixed(0)}%`,
        filesThisReplaces: delta.files,
      })}
`;
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
/**
 * Search output for a model: ordinals and signal names, never magnitudes.
 *
 * `SearchCandidate` carries `score`, `bm25` and `cosine`, and none of the three
 * crosses this boundary — see RANKING_NOTE. `signals` keeps what the numbers
 * were evidence OF (which retrieval channels agreed) without the number that
 * would be mistaken for a confidence.
 */
function searchForModel(out: SearchOutput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    phrase: out.phrase,
    indexBuilt: !out.notBuilt,
    chosen: out.chosen?.nodeKey ?? "",
    chosenKind: out.chosen?.kind ?? "",
    follow: out.follow?.query ?? "",
    followArg: out.follow
      ? out.follow.query === "impact"
        ? out.follow.seed
        : `${out.follow.service} ${out.follow.method} ${out.follow.url}`
      : "",
    reason: out.reason,
    candidates: out.candidates.map((c, i) => ({
      rank: i + 1,
      kind: c.kind,
      display: c.display,
      where: c.where,
      signals: c.sources.join("+"),
      key: c.nodeKey,
    })),
  };
  // A miss is a result, so it gets the next move rather than an empty table.
  if (out.candidates.length === 0 && !out.notBuilt) {
    body["hint"] =
      "Nothing matched. A business capability is usually not spelled in the " +
      "code — try feature_pack with the same phrase, which checks a reviewed " +
      "manifest first.";
  }
  return body;
}

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
