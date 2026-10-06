// Tests for the data-flow side-car (task P3-T4, R68).
//
// Two properties carry this feature, and both are about honesty rather than
// capability.
//
// The side-car CANNOT write edges — enforced the way R63's LLM boundary is,
// by checking the source rather than trusting a convention. An external
// analyser's taint verdict comes from a different tool with its own soundness
// assumptions, and a row in `edges` would make it indistinguishable from a
// compiler-resolved call.
//
// "Nobody looked" is NOT "nothing found". A missing analyser, an unparseable
// payload and a clean run are three outcomes, and only one of them is a clean
// bill of health. Collapsing them is how a broken security tool becomes a
// passing security check.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askDataflow, parseSemgrepJson, renderDataflow, sideCarStatus,
  type DataflowAnswer,
} from "../src/static/sidecar.ts";

/** One real-shaped Semgrep `--json` payload. */
const SEMGREP_JSON = JSON.stringify({
  version: "1.2.3",
  results: [
    {
      check_id: "request-value-reaches-sql",
      path: "server.js",
      start: { line: 210, col: 5 },
      end: { line: 214, col: 9 },
      extra: {
        message: "A request-controlled value reaches a SQL string.",
        severity: "WARNING",
        metavars: {},
      },
    },
  ],
  errors: [],
  paths: { scanned: ["server.js"] },
});

describe("parsing an analyser's output", () => {
  test("a real-shaped payload yields findings with positions intact", () => {
    const findings = parseSemgrepJson(SEMGREP_JSON);
    assert.ok(findings, "a valid payload must parse");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.ruleId, "request-value-reaches-sql");
    assert.equal(findings[0]!.file, "server.js");
    assert.equal(findings[0]!.startLine, 210);
    assert.equal(findings[0]!.endLine, 214);
    assert.equal(findings[0]!.severity, "WARNING", "the tool's own word, verbatim");
    assert.ok(findings[0]!.message.includes("SQL"));
  });

  test("an empty results array is a CLEAN answer — an array, not null", () => {
    // This is the one case that legitimately means "the rule matched nothing".
    assert.deepEqual(parseSemgrepJson(JSON.stringify({ results: [] })), []);
  });

  test("garbage is NULL, never an empty array", () => {
    // The distinction the whole feature rests on. Returning [] here would turn
    // a crashed analyser into a passing security check.
    for (const bad of ["", "not json", "null", "[]", "{}", '{"results":"nope"}']) {
      assert.equal(parseSemgrepJson(bad), null, `"${bad}" must not read as clean`);
    }
  });

  test("a finding missing optional fields still parses rather than throwing", () => {
    // A tool version that drops `extra` must degrade, not crash — a crash here
    // would be reported as "unanswered" when the data was usable.
    const findings = parseSemgrepJson(JSON.stringify({ results: [{ check_id: "r" }] }));
    assert.ok(findings);
    assert.equal(findings[0]!.ruleId, "r");
    assert.equal(findings[0]!.startLine, 0);
    assert.equal(findings[0]!.severity, "unknown");
  });
});

describe("asking a question when nothing is installed", () => {
  const ask = (rules: string): DataflowAnswer =>
    askDataflow({ about: "test", paths: ["."], rules });

  test("a missing rule file is unanswered, and says which file", () => {
    const a = ask("rules/does-not-exist.yml");
    assert.equal(a.answered, false);
    assert.ok(a.unansweredReason.includes("does-not-exist.yml"));
    assert.ok(a.remedy.length > 0, "a refusal must say how to fix itself");
    assert.deepEqual(a.findings, []);
  });

  test("with the real rule file and no analyser, it is unanswered with install hints", () => {
    // If an analyser IS installed on the machine running this, the assertion
    // flips to the answered branch — both outcomes are correct, and neither is
    // allowed to be "clean with no findings" by default.
    const a = ask("rules/dataflow.yml");
    if (a.answered) {
      assert.ok(a.tool, "an answered result names the tool that answered");
      assert.equal(a.unansweredReason, "");
    } else {
      assert.ok(a.unansweredReason.length > 0);
      assert.ok(a.remedy.includes("semgrep"), "the remedy names an installable tool");
      assert.equal(a.tool, null);
    }
  });

  test("confidence is the enum 'inferred', whatever happened", () => {
    // CLAUDE.md rule 4. An external analyser's verdict is a lead, and a number
    // here would be read as a probability this engine cannot justify.
    assert.equal(ask("rules/dataflow.yml").confidence, "inferred");
    assert.equal(ask("rules/nope.yml").confidence, "inferred");
  });

  test("every known analyser is probed and reports an install hint", () => {
    const statuses = sideCarStatus();
    assert.deepEqual(statuses.map((s) => s.name), ["opengrep", "semgrep", "joern"]);
    for (const s of statuses) {
      assert.ok(s.install.length > 0, `${s.name} has no install hint`);
      if (!s.available) assert.equal(s.version, null);
    }
  });

  test("joern is probe-only and says so rather than pretending to run", () => {
    // Its output is a Scala-REPL JSON whose shape depends on the query script.
    // Shipping a parser that has never seen real output would be a guess
    // presented as support.
    const joern = sideCarStatus().find((s) => s.name === "joern")!;
    assert.equal(joern.canInvoke, false);
  });
});

describe("the rendering refuses to look clean", () => {
  test("an unanswered result says so in words a reader cannot misread", () => {
    const text = renderDataflow(askDataflow({
      about: "x", paths: ["."], rules: "rules/nope.yml",
    }));
    assert.ok(text.includes("UNANSWERED"));
    assert.ok(text.includes("NOT a clean result"));
    assert.ok(!text.includes("no tainted path"), "it must not borrow the clean wording");
  });

  test("an answered-and-empty result still states the rule's limits", () => {
    const text = renderDataflow({
      question: { about: "x", paths: ["."], rules: "rules/dataflow.yml" },
      answered: true, tool: "semgrep", toolVersion: "1.0.0",
      unansweredReason: "", remedy: "", findings: [],
      confidence: "inferred", durationMs: 1,
    });
    assert.ok(text.includes("no tainted path"));
    assert.ok(text.includes("limits still apply"), "empty is not a clean bill of health");
    assert.ok(text.includes("inferred"), "and it is still only a lead");
  });

  test("findings carry file, line, severity and rule id", () => {
    const text = renderDataflow({
      question: { about: "x", paths: ["."], rules: "r.yml" },
      answered: true, tool: "opengrep", toolVersion: null,
      unansweredReason: "", remedy: "",
      findings: parseSemgrepJson(SEMGREP_JSON)!,
      confidence: "inferred", durationMs: 1,
    });
    assert.ok(text.includes("server.js:210"));
    assert.ok(text.includes("[WARNING]"));
    assert.ok(text.includes("request-value-reaches-sql"));
  });
});

describe("the side-car cannot write to the graph", () => {
  test("it imports no writer and no store", () => {
    // Checked against the real source, the same way R63's containment test is
    // checked. "Invoked per-question only; never writes edges" is the plan's
    // acceptance criterion, and a structural property nothing checks is a
    // convention.
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "static", "sidecar.ts"), "utf8",
    );
    // IMPORT lines only. The header explains at length why no writer is
    // imported, so a whole-file substring search matches its own documentation
    // — which would make this test unfailable for the opposite reason.
    const imports = source.split(/\r?\n/)
      .filter((l) => /^\s*import\b/.test(l))
      .join(" ");
    for (const forbidden of ["GraphWriter", "FactStore", "db.ts", "graph.ts"]) {
      assert.ok(
        !imports.includes(forbidden),
        `sidecar.ts imports ${forbidden} — an external analyser's verdict must ` +
        "not become indistinguishable from a compiler-resolved fact",
      );
    }
    // And it calls nothing that writes, even transitively through a re-export.
    for (const call of ["insertEdge", "upsertNode", "replaceCfg", "insertChainEntry"]) {
      assert.ok(!source.includes(`.${call}(`), `sidecar.ts calls ${call}`);
    }
  });

  test("the rule file exists and declares taint queries, not plain patterns", () => {
    // A `mode: taint` rule answers "does a value flow from here to there".
    // A plain pattern answers "does this shape appear", which the tree-sitter
    // pass already does and which is not what R68 is for.
    const rules = readFileSync("rules/dataflow.yml", "utf8");
    assert.ok(rules.includes("mode: taint"));
    assert.ok(rules.includes("pattern-sources"));
    assert.ok(rules.includes("pattern-sinks"));
    assert.ok(rules.includes("pattern-sanitizers"), "a taint rule without these is noise");
  });
});
