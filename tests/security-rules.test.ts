import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadCheckKindRules, classifyCheckKind, classifyHelpers } from "../src/static/security-rules.ts";

describe("security check-kind rules", () => {
  test("loads the reviewed rule pack", () => {
    const rules = loadCheckKindRules("rules/check-kinds.yml");
    assert.equal(classifyCheckKind("checkUserAuth", rules), "auth");
    assert.equal(classifyCheckKind("requireTenant", rules), "tenant");
    // The corpus's own service-verifier (41-kri-engine:77) must be classified.
    assert.equal(classifyCheckKind("serviceAuth", rules), "auth");
  });

  test("matches exact helper names only", () => {
    const rules = loadCheckKindRules("rules/check-kinds.yml");
    assert.equal(classifyCheckKind("checkUserAuthExtra", rules), null);
    assert.deepEqual(classifyHelpers(["checkUserAuth", "unknown"], rules), [
      { helperName: "checkUserAuth", checkKind: "auth" },
    ]);
  });

  test("rejects malformed rule structure", () => {
    assert.throws(() => loadCheckKindRules("package.json"), /invalid check-kinds/);
  });
});
