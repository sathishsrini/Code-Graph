// ============================================================================
// OTel bootstrap  —  task P2-T7  (requirement R52)
// ============================================================================
// Preloaded into a target service with `node --import`, so the service's own
// source is never edited:
//
//   OTEL_SERVICE_NAME=40-kri-router \
//   node --import ./adapters/otel/preload.mjs server.js
//
// **Not editing the fixtures is the point, not a convenience.** OPEN-7 says
// real-service instrumentation is outside the engine team's control, and a
// mechanism that requires a PR against every service is a mechanism that never
// ships. This one requires a flag on the start command, which is the same
// change a platform team would make anyway.
//
// `http.route` comes free from the auto-instrumentation — that is R52's whole
// claim, and it is the join key R54 leans on hardest. `code.*` attributes need
// a manual span per function and are deliberately NOT added wholesale here:
// wrapping every function would change the shape of the thing being measured.
// `withCodeSpan` below is the opt-in for the few that matter.
// ============================================================================

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  "http://127.0.0.1:4318/v1/traces";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "unknown-service",
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? "0.0.0",
  }),
  // JSON, matching what `otlp serve` accepts. The receiver says so in its
  // error message too, so a protobuf misconfiguration names its own fix.
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Filesystem spans drown a trace and join to nothing in this graph:
      // there is no `file` node a `fs.readFile` span could confirm.
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
    }),
  ],
});

sdk.start();

// Flush on the way out. A service that exits without flushing loses the last
// batch, and the last batch of a crashing service is the interesting one.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}
process.once("beforeExit", () => { void sdk.shutdown(); });
