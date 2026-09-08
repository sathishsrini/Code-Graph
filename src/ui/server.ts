// ============================================================================
// UI server  —  tasks P2-T1 … P2-T5, P2-T12  (requirements R45, R49, R50, R78)
// ============================================================================
// Serves one HTML page and three JSON endpoints. `node:http`, `node:fs`, and
// elkjs read straight out of `node_modules` — no bundler, no build step, and
// nothing fetched from a CDN at view time.
//
// That constraint is the project's, not a preference: `package.json` has no
// build script and Node runs the `.ts` sources directly. A UI that needed
// webpack would make `npm start` a two-stage thing for everyone, forever,
// to render a graph.
//
// **The UI is last, and deliberately.** Doc §Q.3 names building it first as
// the most common way this class of project dies: a beautiful renderer over a
// graph nobody trusts. Everything it draws was already answerable from the CLI
// before this file existed.
// ============================================================================

import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactStore } from "../store/db.ts";
import { routeGraph } from "../serializers/graph-json.ts";
import { RouteNotFound } from "../query/endpoint-flow.ts";
import { securityPath } from "../query/security.ts";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

export interface UiOptions {
  port?: number;
  host?: string;
}

export interface UiServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startUi(store: FactStore, options: UiOptions = {}): Promise<UiServer> {
  const html = readFileSync(join(HERE, "app.html"), "utf8");
  // Served from node_modules rather than a CDN so the viewer works offline and
  // pins the same version the tests ran against.
  const elk = readFileSync(require.resolve("elkjs/lib/elk.bundled.js"), "utf8");

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      if (url.pathname === "/elk.js") {
        return send(res, 200, "text/javascript; charset=utf-8", elk);
      }
      if (url.pathname === "/api/routes") {
        return json(res, 200, listRoutes(store));
      }
      if (url.pathname === "/api/graph") {
        const service = url.searchParams.get("service") ?? "";
        const method = url.searchParams.get("method") ?? "";
        const path = url.searchParams.get("path") ?? "";
        const followRemote = url.searchParams.get("remote") !== "0";
        const depth = Number(url.searchParams.get("depth") ?? 12);
        return json(res, 200, routeGraph(store, service, method, path, {
          maxDepth: Number.isFinite(depth) ? depth : 12,
          followRemote,
        }));
      }
      if (url.pathname === "/api/security") {
        const service = url.searchParams.get("service") ?? undefined;
        return json(res, 200, securityPath(store, { service }));
      }
      return json(res, 404, { error: `no route ${url.pathname}` });
    } catch (e) {
      if (e instanceof RouteNotFound) {
        // An answer, not a failure — the picker can show the alternatives.
        return json(res, 404, { error: e.message, candidates: e.candidates });
      }
      return json(res, 500, { error: (e as Error).message });
    }
  });

  const port = options.port ?? 7777;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();

  return {
    server,
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RouteListing {
  service: string;
  method: string;
  url: string;
  /** Check kinds present, and by which channel — the picker shows them (R50). */
  checks: Array<{ kind: string; channel: string }>;
  hasInline: boolean;
}

function listRoutes(store: FactStore): RouteListing[] {
  const rows = store.raw().prepare(
    `SELECT r.service_name, r.method, r.url, n.id AS node_id
       FROM routes r JOIN nodes n ON n.id = r.node_id
      ORDER BY r.service_name, r.url, r.method`,
  ).all() as Array<{ service_name: string; method: string; url: string; node_id: number }>;

  const checks = store.raw().prepare(
    `SELECT DISTINCT check_kind, evidence_kind FROM route_chain
      WHERE route_node_id = ? AND check_kind IS NOT NULL`,
  );

  return rows.map((r) => {
    const found = checks.all(r.node_id) as Array<{ check_kind: string; evidence_kind: string }>;
    return {
      service: r.service_name,
      method: r.method,
      url: r.url,
      checks: found.map((c) => ({
        kind: c.check_kind,
        channel: c.evidence_kind === "boot" ? "boot" : "inline",
      })),
      hasInline: found.some((c) => c.evidence_kind !== "boot"),
    };
  });
}

function send(
  res: import("node:http").ServerResponse, status: number, type: string, body: string,
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // A viewer of a private codebase should not be cached by anything.
    "cache-control": "no-store",
  });
  res.end(body);
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}
