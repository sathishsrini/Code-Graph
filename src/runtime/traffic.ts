// ============================================================================
// Traffic generator  —  task P2-T7  (OPEN-7)
// ============================================================================
// The corpus has no traffic, so the runtime channel has nothing to confirm.
// This drives enough requests at instrumented fixtures to exercise the ingest
// and promotion path end to end.
//
// **It proves the pipeline, not the services.** OPEN-7's decision was that the
// engine team instruments the *fixtures* and writes a small generator "purely
// to prove the ingest and promotion path"; real-service instrumentation is
// somebody else's, tracked as an external dependency. Nothing here should ever
// be read as load testing or as a health check.
//
// Errors are driven ON PURPOSE and are the more valuable half: R53 keeps 100%
// of errored traces and ~1% of the rest, so a generator that only sent happy
// requests would exercise the sampler's cheap path and none of its real one.
// ============================================================================

export interface TrafficTarget {
  service: string;
  baseUrl: string;
  requests: Array<{
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Marks a request expected to fail. Its trace is the one worth keeping. */
    expectError?: boolean;
  }>;
}

export interface TrafficResult {
  sent: number;
  ok: number;
  failed: number;
  unreachable: string[];
  byStatus: Record<string, number>;
}

export interface TrafficOptions {
  /** Passes over the request list. Default 3. */
  rounds?: number;
  /** Milliseconds between requests, so spans do not all share a timestamp. */
  delayMs?: number;
  timeoutMs?: number;
}

export async function generateTraffic(
  targets: TrafficTarget[], options: TrafficOptions = {},
): Promise<TrafficResult> {
  const rounds = options.rounds ?? 3;
  const delayMs = options.delayMs ?? 25;
  const timeoutMs = options.timeoutMs ?? 5000;

  const result: TrafficResult = {
    sent: 0, ok: 0, failed: 0, unreachable: [], byStatus: {},
  };
  const unreachable = new Set<string>();

  for (let round = 0; round < rounds; round += 1) {
    for (const target of targets) {
      if (unreachable.has(target.service)) continue;

      for (const request of target.requests) {
        const url = `${target.baseUrl.replace(/\/$/, "")}${request.path}`;
        result.sent += 1;
        try {
          const res = await fetch(url, {
            method: request.method,
            headers: {
              "content-type": "application/json",
              // A correlation id per request, because the corpus's own
              // middleware logs on it and it makes a generated trace findable
              // in the service's log as well as in the store.
              "x-correlation-id": `traffic-${round}-${result.sent}`,
              ...request.headers,
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const bucket = `${Math.floor(res.status / 100)}xx`;
          result.byStatus[bucket] = (result.byStatus[bucket] ?? 0) + 1;
          if (res.ok) result.ok += 1; else result.failed += 1;
          // Draining the body lets the server finish its span; an undrained
          // response can leave the request span open past the flush.
          await res.arrayBuffer().catch(() => undefined);
        } catch {
          // A service that is not running is reported once, by name, and the
          // rest of its requests are skipped. Retrying a closed port for three
          // rounds produces nothing but delay.
          unreachable.add(target.service);
          result.failed += 1;
          break;
        }
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }

  result.unreachable = [...unreachable];
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A request plan for the validation corpus.
 *
 * Deliberately mixed. The unauthenticated calls are the ones that exercise
 * `checkUserAuth`'s error exit — the CFG says that branch returns
 * `KRI40-AUTH-001`, and this is what makes a trace agree.
 */
export function corpusTargets(ports: Map<string, number>): TrafficTarget[] {
  const at = (service: string, fallback: number) =>
    `http://127.0.0.1:${ports.get(service) ?? fallback}`;

  return [
    {
      service: "40-kri-router",
      baseUrl: at("40-kri-router", 3001),
      requests: [
        { method: "GET", path: "/health" },
        { method: "GET", path: "/ready" },
        // No Authorization header: reaches the inline auth check and returns
        // 401, which is the error exit the static surface predicts.
        { method: "GET", path: "/api/v1/po", expectError: true },
        {
          method: "POST", path: "/api/v1/po", expectError: true,
          body: { po_number: "TRAFFIC-1", vendor_name: "gen" },
        },
        {
          method: "POST", path: "/api/v1/auth/login",
          body: { email: "nobody@example.com", password: "wrong" },
          expectError: true,
        },
      ],
    },
    {
      service: "41-kri-engine",
      baseUrl: at("41-kri-engine", 3002),
      requests: [
        { method: "GET", path: "/health" },
        { method: "GET", path: "/api/v1/po", expectError: true },
      ],
    },
    {
      service: "51-integration",
      baseUrl: at("51-integration", 8000),
      requests: [
        { method: "GET", path: "/health" },
        {
          method: "POST", path: "/api/v1/mail/send", expectError: true,
          body: { event: "PO_CREATED", recipient: "a@b.c", reference_type: "PO", reference_id: "1" },
        },
      ],
    },
  ];
}
