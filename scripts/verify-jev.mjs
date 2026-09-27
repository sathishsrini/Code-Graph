// ============================================================================
// Manual smoke test: is `jev-key` valid and can it reach the TypeSafe API?
// ============================================================================
// Run with `npm run jev:verify`, which loads the repo-root .env if present.
// It sends ONE `noul` question to Jev and prints the model and the answer.
// It makes a real network call with the real key, so it is not part of
// `npm test`.
//
// It goes through `createJevClient()` rather than constructing the SDK client
// itself, so a pass here also proves the module's `jev-key` wiring, not just
// the key. The key is never printed.
// ============================================================================

import { noul } from "@typesafe-ai/sdk";
import { createJevClient } from "../src/llm/jev-client.ts";

let client;
try {
  client = createJevClient();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  const result = await client.systemOne({
    state: "code-intel indexes a codebase into a call graph stored in SQLite.",
    questions: {
      mentions_code: noul("Does this text mention code or a codebase?"),
    },
  });

  console.log("Jev responded with model:", result.model);
  console.log("mentions_code -> P(yes) =", result.answers.mentions_code.noul);
  console.log("OK: jev-key is valid and reachable.");
} catch (err) {
  // Name, HTTP status and message only: enough to tell auth from network.
  // Response headers and body are deliberately not printed.
  const status = typeof err?.status === "number" ? ` (HTTP ${err.status})` : "";
  console.error(`Jev request failed: ${err?.name ?? "Error"}${status}: ${err?.message ?? String(err)}`);
  process.exit(1);
}
