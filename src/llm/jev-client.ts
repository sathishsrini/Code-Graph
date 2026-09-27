// TypeSafe Jev client, keyed by the `jev-key` environment variable.
//
// Jev is TypeSafe's System One model: it returns typed judgments (noul /
// choice / score, i.e. probabilities and picks) rather than generated text.
// Docs: https://docs.typesafe.ai/llms.txt — read them before adding a new
// question type; do not invent request or response fields.
//
// **Why the key is passed explicitly:** the SDK falls back to
// `TYPESAFE_API_KEY` when `apiKey` is omitted. This project does not use that
// variable. Its key lives in the repo-root `.env` as `jev-key`, so this module
// reads it and hands it over, and fails with a message naming `jev-key` when
// it is absent. Without that check the SDK's error would name a variable
// nobody here sets.
//
// **Scope:** this constructs a client and nothing else. It is not wired into
// any pipeline, so it does not change the OPEN-8 decision (summaries run on the
// local model in `local.ts`). Any caller that uses it is bound by the LLM
// boundary like every other model output (R62/R63): a Jev judgment may inform
// a suggestion, and may never become a row a traversal treats as fact.

import { TypeSafeClient } from "@typesafe-ai/sdk";

/** The environment variable holding the Jev API key. */
export const JEV_KEY_ENV = "jev-key";

/**
 * Create a TypeSafe client authenticated with `jev-key`.
 * Throws when the variable is unset or empty. No network call is made here.
 */
export function createJevClient(): TypeSafeClient {
  const apiKey = process.env[JEV_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `Missing Jev API key: set '${JEV_KEY_ENV}' in the repo-root .env (see .env.example).`,
    );
  }
  return new TypeSafeClient({ apiKey });
}
