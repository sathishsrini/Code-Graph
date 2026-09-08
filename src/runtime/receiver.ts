// ============================================================================
// OTLP/HTTP receiver  —  task P2-T8  (requirement R53)
// ============================================================================
// `node:http` and nothing else. This endpoint accepts a JSON body, normalises
// it and writes rows; a framework here would be a dependency carrying routing,
// middleware and a plugin system to serve two paths.
//
// It answers `POST /v1/traces` — the OTLP/HTTP path every SDK and the
// collector already send to — so pointing a service at it needs one env var
// and no adapter.
// ============================================================================

import { createServer, type Server } from "node:http";
import type { FactStore } from "../store/db.ts";
import {
  TailSampler, insertSpans, normalise, type OtlpPayload, type SamplerOptions,
} from "./otlp.ts";

export interface ReceiverOptions extends SamplerOptions {
  port?: number;
  host?: string;
  /** Reject bodies above this, in bytes. Default 16 MiB. */
  maxBodyBytes?: number;
  onBatch?: (received: number, kept: number) => void;
}

export interface Receiver {
  server: Server;
  port: number;
  /** Decide and write every buffered trace, then stop. */
  close: () => Promise<{ flushed: number }>;
  stats: () => { received: number; kept: number; bufferedTraces: number };
}

const DEFAULT_PORT = 4318;   // the OTLP/HTTP default, so senders need no config
const DEFAULT_MAX_BODY = 16 * 1024 * 1024;

export async function startReceiver(
  store: FactStore, options: ReceiverOptions = {},
): Promise<Receiver> {
  const sampler = new TailSampler(options);
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  let received = 0;
  let kept = 0;

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { ok: true, bufferedTraces: sampler.bufferedTraces });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/traces")) {
      return json(res, 404, { error: "only POST /v1/traces is served" });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        aborted = true;
        json(res, 413, { error: `body exceeds ${maxBody} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      let payload: OtlpPayload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpPayload;
      } catch (e) {
        // A protobuf body lands here, and saying so is more useful than
        // "invalid JSON" to whoever configured the exporter.
        return json(res, 400, {
          error: `could not parse body as OTLP/JSON: ${(e as Error).message}`,
          hint: "this receiver speaks OTLP/HTTP JSON; set the exporter's protocol to http/json",
        });
      }

      try {
        const spans = normalise(payload);
        received += spans.length;
        const decided = sampler.add(spans);
        kept += insertSpans(store, decided);
        options.onBatch?.(spans.length, decided.length);
        // 200 with an empty partialSuccess is what an OTLP sender expects; a
        // non-2xx makes it retry, and a retried batch of spans we chose not to
        // sample is pure load.
        json(res, 200, { partialSuccess: {} });
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });

  const port = options.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "127.0.0.1", resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: boundPort,
    stats: () => ({ received, kept, bufferedTraces: sampler.bufferedTraces }),
    close: async () => {
      // Buffered traces are decided rather than dropped. A trace whose root had
      // not yet arrived is exactly the kind most likely to be the errored one.
      const flushed = insertSpans(store, sampler.flushAll());
      kept += flushed;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return { flushed };
    },
  };
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
