// Tests for the TypeSafe Jev client (src/llm/jev-client.ts).
//
// The contract under test is the key name. The SDK's own fallback is
// `TYPESAFE_API_KEY`; this project keys Jev by `jev-key` and passes it
// explicitly, so a missing `jev-key` must fail loudly here rather than
// silently picking up some other variable. The env var is spelled out
// literally below on purpose — renaming it is a contract change, and this
// test should be the thing that says so.
//
// Both variables are cleared before each case and restored after it, so the
// environment of whoever runs the suite cannot decide the result. Without
// that, a machine with `TYPESAFE_API_KEY` set would pass the second case even
// if `createJevClient` stopped passing `apiKey` at all.
//
// No network: constructing a client makes no request.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient } from "../src/llm/jev-client.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("createJevClient", () => {
  const originalKey = process.env["jev-key"];
  const originalSdkKey = process.env["TYPESAFE_API_KEY"];

  beforeEach(() => {
    delete process.env["jev-key"];
    delete process.env["TYPESAFE_API_KEY"];
  });

  afterEach(() => {
    restoreEnv("jev-key", originalKey);
    restoreEnv("TYPESAFE_API_KEY", originalSdkKey);
  });

  test("throws when jev-key is not set", () => {
    // The SDK's own variable is present and must not be used instead.
    process.env["TYPESAFE_API_KEY"] = "some-other-key";
    assert.throws(() => createJevClient(), /jev-key/);
  });

  test("returns a configured TypeSafeClient when jev-key is set", () => {
    // TYPESAFE_API_KEY is unset and the SDK throws when it finds no key, so
    // getting a client back proves `jev-key` was handed over explicitly.
    process.env["jev-key"] = "test-key";
    assert.ok(createJevClient() instanceof TypeSafeClient);
  });
});
