// ============================================================================
// OTLP ingest  —  task P2-T8  (requirements R53, R54, R55)
// ============================================================================
// Accepts OTLP/HTTP JSON on `POST /v1/traces`, normalises spans, applies
// tail-based sampling, and writes them to `spans`.
//
// **JSON, not protobuf, and deliberately.** Every OTel SDK and the collector
// both speak OTLP/HTTP JSON; accepting it costs a parser we do not write. The
// SCIP reader exists because SCIP has no JSON encoding — OTLP does, and adding
// a second hand-rolled protobuf decoder to save a few bytes on a localhost hop
// would be work with no answer attached.
//
// **No Jaeger, no Tempo.** R53 is explicit: this is a receiver and a table, not
// a tracing backend. The engine needs traces to confirm edges, not to render
// waterfalls, and taking a backend dependency to store rows we already have a
// database for is the kind of scope creep §Q.3 warns about.
//
// **Tail sampling, because head sampling loses the errors.** R53 wants 100% of
// errored traces and ~1% of successes. That decision cannot be made per span —
// a trace is errored if ANY span in it errored, and the root usually arrives
// last. So spans buffer by trace id and the decision is made when the trace
// looks complete, or when it times out.
// ============================================================================

import type { FactStore } from "../store/db.ts";

/** Pinned semconv (R55). Recorded per row, because a fleet migrates gradually. */
export const SEMCONV_VERSION = "1.27.0";

export interface NormalisedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string | null;
  serviceName: string;
  /** Microseconds, not nanoseconds — see migration 006 for why. */
  startUnixUs: number;
  endUnixUs: number;
  durationUs: number;
  status: "ok" | "error" | "unset";
  statusMessage: string | null;
  httpRoute: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  codeFunction: string | null;
  codeFilepath: string | null;
  dbSystem: string | null;
  dbName: string | null;
  dbOperation: string | null;
  serverAddress: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  semconv: string;
  attributes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// R55 — attribute spellings
// ---------------------------------------------------------------------------
// The `code.*` namespace was renamed between semconv versions, and a fleet
// mid-migration emits both at once. Reading only the new spelling silently
// drops every span from a service that has not upgraded; reading only the old
// one drops the ones that have. Both are accepted, new spelling preferred.

const ALIASES: Record<string, readonly string[]> = {
  "code.function.name": ["code.function.name", "code.function"],
  "code.file.path": ["code.file.path", "code.filepath"],
  "http.request.method": ["http.request.method", "http.method"],
  "http.response.status_code": ["http.response.status_code", "http.status_code"],
  "server.address": ["server.address", "net.peer.name", "http.host"],
  "db.namespace": ["db.namespace", "db.name"],
  "db.operation.name": ["db.operation.name", "db.operation"],
  "db.system.name": ["db.system.name", "db.system"],
};

/** Read an attribute by its canonical name, accepting every known spelling. */
export function attr(
  attributes: Record<string, unknown>, canonical: string,
): unknown {
  for (const name of ALIASES[canonical] ?? [canonical]) {
    const value = attributes[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const int = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// OTLP/JSON shapes — only the fields that are read
// ---------------------------------------------------------------------------

interface AnyValue {
  stringValue?: string; intValue?: string | number; doubleValue?: number;
  boolValue?: boolean; arrayValue?: { values?: AnyValue[] };
}
interface KeyValue { key?: string; value?: AnyValue }
interface OtlpEvent { name?: string; attributes?: KeyValue[] }
interface OtlpSpan {
  traceId?: string; spanId?: string; parentSpanId?: string; name?: string;
  kind?: number | string; startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number | string; message?: string };
  attributes?: KeyValue[]; events?: OtlpEvent[];
}
interface OtlpScopeSpans { spans?: OtlpSpan[] }
interface OtlpResourceSpans {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
  instrumentationLibrarySpans?: OtlpScopeSpans[];
}
export interface OtlpPayload { resourceSpans?: OtlpResourceSpans[] }

const SPAN_KINDS = [
  "unspecified", "internal", "server", "client", "producer", "consumer",
];

function flatten(kvs: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs ?? []) {
    if (!kv.key) continue;
    out[kv.key] = unwrap(kv.value);
  }
  return out;
}

function unwrap(v: AnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(unwrap);
  return null;
}

/**
 * Normalise one OTLP payload.
 *
 * Malformed spans are skipped, not thrown on: a receiver that rejects a whole
 * batch because one span lacks a trace id loses 999 good spans to fix one, and
 * the sender has already moved on.
 */
export function normalise(payload: OtlpPayload): NormalisedSpan[] {
  const out: NormalisedSpan[] = [];

  for (const rs of payload.resourceSpans ?? []) {
    const resource = flatten(rs.resource?.attributes);
    const serviceName = str(resource["service.name"]) ?? "unknown";
    const scopes = rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? [];

    for (const scope of scopes) {
      for (const span of scope.spans ?? []) {
        if (!span.traceId || !span.spanId) continue;

        const attributes = { ...resource, ...flatten(span.attributes) };
        // Divided at the edge, once. `Number()` on a nanosecond string is
        // already lossy above 2^53, so the conversion happens on the string's
        // numeric value before anything else reads it.
        const start = nsToUs(span.startTimeUnixNano);
        const end = nsToUs(span.endTimeUnixNano);

        // An `exception` event is where a thrown error lands; the span's own
        // status only says something failed, not what.
        const exception = (span.events ?? []).find((e) => e.name === "exception");
        const exceptionAttrs = flatten(exception?.attributes);

        out.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId && span.parentSpanId !== "" ? span.parentSpanId : null,
          name: span.name ?? "",
          kind: spanKind(span.kind),
          serviceName,
          startUnixUs: start,
          endUnixUs: end,
          durationUs: Math.max(0, end - start),
          status: statusOf(span.status?.code),
          statusMessage: span.status?.message ?? null,
          httpRoute: str(attr(attributes, "http.route")),
          httpMethod: str(attr(attributes, "http.request.method")),
          httpStatus: int(attr(attributes, "http.response.status_code")),
          codeFunction: str(attr(attributes, "code.function.name")),
          codeFilepath: str(attr(attributes, "code.file.path")),
          dbSystem: str(attr(attributes, "db.system.name")),
          dbName: str(attr(attributes, "db.namespace")),
          dbOperation: str(attr(attributes, "db.operation.name")),
          serverAddress: str(attr(attributes, "server.address")),
          exceptionType: str(exceptionAttrs["exception.type"]),
          exceptionMessage: str(exceptionAttrs["exception.message"]),
          semconv: SEMCONV_VERSION,
          attributes,
        });
      }
    }
  }
  return out;
}

/**
 * OTLP nanoseconds -> microseconds, without going through an unsafe Number.
 *
 * `Number("1700000000000000000")` is 1.7e18, beyond the safe integer range, so
 * the last digits are already wrong before any division. BigInt does the
 * divide exactly and the result is small enough to be a Number.
 */
function nsToUs(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  try {
    return Number(BigInt(String(value).split(".")[0] ?? "0") / 1000n);
  } catch {
    return 0;
  }
}

function spanKind(kind: number | string | undefined): string | null {
  if (typeof kind === "number") return SPAN_KINDS[kind] ?? null;
  if (typeof kind === "string") {
    return kind.replace(/^SPAN_KIND_/, "").toLowerCase() || null;
  }
  return null;
}

function statusOf(code: number | string | undefined): "ok" | "error" | "unset" {
  if (code === 2 || code === "STATUS_CODE_ERROR") return "error";
  if (code === 1 || code === "STATUS_CODE_OK") return "ok";
  return "unset";
}

// ---------------------------------------------------------------------------
// R53 — tail-based sampling
// ---------------------------------------------------------------------------

export interface SamplerOptions {
  /** Fraction of non-errored traces kept. Default 0.01 (R53's "~1%"). */
  successRate?: number;
  /** How long to hold a trace before deciding. Default 30s. */
  completionMs?: number;
  /** Injected for tests; defaults to a hash of the trace id. */
  now?: () => number;
}

interface Pending {
  spans: NormalisedSpan[];
  firstSeenMs: number;
  errored: boolean;
}

/**
 * Buffers spans by trace and decides, per trace, whether to keep it.
 *
 * The decision cannot be per span. A trace is errored if ANY span in it
 * errored, and the root — the one a head sampler would decide on — usually
 * arrives last. Head sampling therefore drops exactly the traces worth having.
 *
 * The success sample is chosen by hashing the trace id rather than by a random
 * draw, so the same trace decides the same way in every process and a re-run
 * over the same input produces the same rows. A random sampler would make the
 * store non-reproducible, which Phase 0's determinism criterion forbids.
 */
export class TailSampler {
  private readonly pending = new Map<string, Pending>();
  private readonly successRate: number;
  private readonly completionMs: number;
  private readonly now: () => number;

  constructor(options: SamplerOptions = {}) {
    this.successRate = options.successRate ?? 0.01;
    this.completionMs = options.completionMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Buffer a batch; returns the traces that became decidable. */
  add(spans: NormalisedSpan[]): NormalisedSpan[] {
    const ready: NormalisedSpan[] = [];
    const touched = new Set<string>();

    for (const span of spans) {
      let entry = this.pending.get(span.traceId);
      if (!entry) {
        entry = { spans: [], firstSeenMs: this.now(), errored: false };
        this.pending.set(span.traceId, entry);
      }
      entry.spans.push(span);
      if (span.status === "error") entry.errored = true;
      touched.add(span.traceId);
    }

    // A trace whose root has arrived is complete enough to decide on: every
    // child span finished before its parent could.
    for (const traceId of touched) {
      const entry = this.pending.get(traceId)!;
      if (entry.spans.some((s) => s.parentSpanId === null)) {
        ready.push(...this.decide(traceId, entry));
      }
    }
    ready.push(...this.flushExpired());
    return ready;
  }

  /** Decide every buffered trace, whatever its age. For shutdown and tests. */
  flushAll(): NormalisedSpan[] {
    const out: NormalisedSpan[] = [];
    for (const [traceId, entry] of [...this.pending]) {
      out.push(...this.decide(traceId, entry));
    }
    return out;
  }

  private flushExpired(): NormalisedSpan[] {
    const out: NormalisedSpan[] = [];
    const cutoff = this.now() - this.completionMs;
    for (const [traceId, entry] of [...this.pending]) {
      if (entry.firstSeenMs <= cutoff) out.push(...this.decide(traceId, entry));
    }
    return out;
  }

  private decide(traceId: string, entry: Pending): NormalisedSpan[] {
    this.pending.delete(traceId);
    // R53: every errored trace, no exceptions. An error nobody kept is an
    // error nobody can explain.
    if (entry.errored) return entry.spans;
    return keepByHash(traceId, this.successRate) ? entry.spans : [];
  }

  get bufferedTraces(): number {
    return this.pending.size;
  }
}

/** Deterministic sample: the same trace id always decides the same way. */
export function keepByHash(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let h = 2166136261;
  for (let i = 0; i < traceId.length; i += 1) {
    h ^= traceId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000 < rate;
}

// ---------------------------------------------------------------------------

export function insertSpans(store: FactStore, spans: NormalisedSpan[]): number {
  if (spans.length === 0) return 0;
  const stmt = store.raw().prepare(
    `INSERT INTO spans
       (trace_id, span_id, parent_span_id, name, kind, service_name,
        start_unix_us, end_unix_us, duration_us, status, status_message,
        http_route, http_method, http_status, code_function, code_filepath,
        db_system, db_name, db_operation, server_address,
        exception_type, exception_message, semconv, attributes, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             datetime('now'))
     ON CONFLICT DO NOTHING`,
  );

  let n = 0;
  store.transaction(() => {
    for (const s of spans) {
      stmt.run(
        s.traceId, s.spanId, s.parentSpanId, s.name, s.kind, s.serviceName,
        s.startUnixUs, s.endUnixUs, s.durationUs, s.status, s.statusMessage,
        s.httpRoute, s.httpMethod, s.httpStatus, s.codeFunction, s.codeFilepath,
        s.dbSystem, s.dbName, s.dbOperation, s.serverAddress,
        s.exceptionType, s.exceptionMessage, s.semconv,
        JSON.stringify(s.attributes),
      );
      n += 1;
    }
  });
  return n;
}
