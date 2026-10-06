// ============================================================================
// Data-flow side-car  —  task P3-T4  (requirement R68)
// ============================================================================
// The escape hatch the plan reserves for the ONE question this engine refuses
// to answer. From the CFG's scope boundary in §2.8:
//
//   "It answers 'this call sits inside the if (authErr) branch, which exits
//    with an error'. It does NOT answer 'authErr is non-null when the token is
//    invalid' — that is interprocedural data flow, which stays out of scope.
//    R68 (Joern side-car) remains the escape hatch if you ever need it."
//
// So this module asks an external analyser one question at a time and returns
// its answer. Three properties make that safe, and none is optional.
//
// **It cannot write edges.** Not "does not" — cannot. It imports no
// `GraphWriter` and no `FactStore`, takes no insert path, and returns a value.
// An external tool's taint verdict is an inference from a different analyser
// with different soundness assumptions; a row in `edges` would make it
// indistinguishable from a compiler-resolved call. The same structural
// discipline as `writeSummary`, which takes no writer, and `feature-pack.ts`,
// which cannot reach the model cache.
//
// **"Nobody looked" is not "nothing found".** `answered: false` and
// `answered: true, findings: []` are different answers, and the type forces a
// caller to distinguish them. This is R61 applied to a tool that may not be
// installed: rendering a missing analyser the same as a clean result converts
// an unknown into a false negative.
//
// **Per question, per invocation.** No background pass, no cache, no stored
// result — the plan's acceptance criterion. A cached taint result ages into a
// lie the moment the code changes, with nothing to invalidate it, because
// nothing here participates in the incremental-indexing hash.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Analysers this adapter knows how to invoke or, at minimum, look for. */
export type SideCarName = "opengrep" | "semgrep" | "joern";

export interface DataflowQuestion {
  /**
   * What is being asked about — a verbatim node key or a display name. Carried
   * into the answer so a result is never separated from its question.
   */
  about: string;
  /** Paths to analyse. */
  paths: string[];
  /** The reviewed rule file holding the taint query. */
  rules: string;
}

export interface DataflowFinding {
  ruleId: string;
  message: string;
  file: string;
  startLine: number;
  endLine: number;
  /** The tool's own severity string, verbatim. Never remapped to confidence. */
  severity: string;
}

export interface DataflowAnswer {
  question: DataflowQuestion;
  /**
   * FALSE means nobody looked. Never render this the same as an empty
   * `findings` — see the header.
   */
  answered: boolean;
  tool: SideCarName | null;
  toolVersion: string | null;
  /** Why it is unanswered. Empty when `answered` is true. */
  unansweredReason: string;
  /** How to make it answerable. Empty when `answered` is true. */
  remedy: string;
  findings: DataflowFinding[];
  /**
   * Always `inferred`, and an enum rather than a number (CLAUDE.md rule 4).
   * An external analyser's verdict is a lead, never a fact — its soundness
   * assumptions are its own and this engine cannot check them.
   */
  confidence: "inferred";
  durationMs: number;
}

interface SideCar {
  name: SideCarName;
  versionArgs: string;
  install: string;
  /** False when this repo has never run it and parsed real output. */
  verified: boolean;
  /** Null when invocation is not implemented — probe-only. */
  invoke: ((q: DataflowQuestion) => SpawnOutcome) | null;
}

interface SpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Preference order, most-preferred first.
 *
 * Opengrep and Semgrep share a rule format and an output schema, so one parser
 * serves both. Joern is probe-only: its output is a Scala-REPL JSON whose shape
 * depends on the query script, and shipping a parser that has never seen real
 * output would be a guess presented as support.
 */
const SIDECARS: readonly SideCar[] = [
  {
    name: "opengrep",
    versionArgs: "--version",
    install: "https://github.com/opengrep/opengrep — or use semgrep, same rule format",
    verified: false,
    invoke: (q) => runSemgrepLike("opengrep", q),
  },
  {
    name: "semgrep",
    versionArgs: "--version",
    install: "pipx install semgrep",
    verified: false,
    invoke: (q) => runSemgrepLike("semgrep", q),
  },
  {
    name: "joern",
    versionArgs: "--version",
    install: "https://docs.joern.io/installation — needs a JVM",
    verified: false,
    invoke: null,
  },
] as const;

function runSemgrepLike(binary: string, q: DataflowQuestion): SpawnOutcome {
  const args = [
    "--json", "--quiet", "--no-git-ignore",
    "--config", JSON.stringify(q.rules),
    ...q.paths.map((p) => JSON.stringify(p)),
  ].join(" ");
  const r = spawnSync(`${binary} ${args}`, {
    encoding: "utf8", shell: true, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
  };
}

export interface SideCarStatus {
  name: SideCarName;
  available: boolean;
  version: string | null;
  canInvoke: boolean;
  verified: boolean;
  install: string;
}

/** Which analysers are present. Reported in full so a refusal is actionable. */
export function sideCarStatus(): SideCarStatus[] {
  return SIDECARS.map((s) => {
    const r = spawnSync(`${s.name} ${s.versionArgs}`, {
      encoding: "utf8", shell: true, timeout: 60_000,
    });
    const available = !r.error && r.status === 0;
    return {
      name: s.name,
      available,
      version: available ? ((r.stdout ?? "").trim().split("\n")[0] ?? null) : null,
      canInvoke: available && s.invoke !== null,
      verified: s.verified,
      install: s.install,
    };
  });
}

/**
 * Parse Semgrep/Opengrep `--json` output. Returns null when the payload is not
 * recognisable, which the caller must treat as UNANSWERED rather than clean.
 *
 * Pure, and therefore the part of this module that is actually tested: the
 * invocation needs a tool nobody here has installed, but the schema is stable
 * and a fixture exercises it.
 */
export function parseSemgrepJson(stdout: string): DataflowFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  // `JSON.parse("null")` succeeds and yields null, and reading `.results` off
  // it throws. A tool emitting `null` would then crash the caller instead of
  // being reported as unanswered — the one outcome this module exists to make
  // impossible.
  if (parsed === null || typeof parsed !== "object") return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  return results.map((row) => {
    const r = row as Record<string, unknown>;
    const extra = (r["extra"] ?? {}) as Record<string, unknown>;
    const start = (r["start"] ?? {}) as Record<string, unknown>;
    const end = (r["end"] ?? {}) as Record<string, unknown>;
    return {
      ruleId: String(r["check_id"] ?? "(unnamed rule)"),
      message: String(extra["message"] ?? "").trim(),
      file: String(r["path"] ?? ""),
      startLine: Number(start["line"] ?? 0) || 0,
      endLine: Number(end["line"] ?? 0) || 0,
      // The tool's own word, never remapped onto this engine's confidence axis.
      severity: String(extra["severity"] ?? "unknown"),
    };
  });
}

/**
 * Ask one data-flow question.
 *
 * Takes no store and no writer, by construction. The answer is returned to the
 * caller and goes nowhere else.
 */
export function askDataflow(question: DataflowQuestion): DataflowAnswer {
  const started = Date.now();
  const base = {
    question,
    confidence: "inferred" as const,
    findings: [] as DataflowFinding[],
    tool: null as SideCarName | null,
    toolVersion: null as string | null,
  };

  if (!existsSync(question.rules)) {
    return {
      ...base,
      answered: false,
      unansweredReason: `no rule file at ${question.rules}`,
      remedy: "write the taint query, or pass --rules",
      durationMs: Date.now() - started,
    };
  }

  const statuses = sideCarStatus();
  const usable = statuses.find((s) => s.canInvoke);
  if (!usable) {
    const present = statuses.filter((s) => s.available).map((s) => s.name);
    return {
      ...base,
      answered: false,
      unansweredReason: present.length > 0
        ? `installed but this adapter cannot invoke it: ${present.join(", ")}`
        : "no data-flow analyser is installed",
      remedy: statuses.map((s) => `${s.name}: ${s.install}`).join("  |  "),
      durationMs: Date.now() - started,
    };
  }

  const sidecar = SIDECARS.find((s) => s.name === usable.name)!;
  const r = sidecar.invoke!(question);
  const findings = parseSemgrepJson(r.stdout);
  if (findings === null) {
    // Unparseable output is UNANSWERED, not clean. This is the branch where a
    // lazy implementation turns a broken tool into a passing security check.
    return {
      ...base,
      answered: false,
      tool: usable.name,
      toolVersion: usable.version,
      unansweredReason:
        `${usable.name} produced output this adapter could not parse` +
        (r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ` (exit ${r.status})`),
      remedy: "run the tool by hand with --json and compare its schema",
      durationMs: Date.now() - started,
    };
  }

  return {
    ...base,
    answered: true,
    tool: usable.name,
    toolVersion: usable.version,
    unansweredReason: "",
    remedy: "",
    findings,
    durationMs: Date.now() - started,
  };
}

/** Plain-text rendering. Separate from the data, as every other query here. */
export function renderDataflow(answer: DataflowAnswer): string {
  const nl = String.fromCharCode(10);
  const out: string[] = [
    `DATA-FLOW QUESTION  ${answer.question.about}`,
    `  rules : ${answer.question.rules}`,
    `  paths : ${answer.question.paths.join(", ") || "(none)"}`,
    "",
  ];

  if (!answer.answered) {
    // The wording matters. "UNANSWERED" must not read as "clean".
    out.push("UNANSWERED — nobody looked. This is NOT a clean result.");
    out.push(`  reason : ${answer.unansweredReason}`);
    out.push(`  remedy : ${answer.remedy}`);
    return out.join(nl) + nl;
  }

  out.push(
    `ANSWERED by ${answer.tool}${answer.toolVersion ? ` ${answer.toolVersion}` : ""}` +
    `  (confidence: ${answer.confidence} — an external analyser's verdict is a lead)`,
  );
  if (answer.findings.length === 0) {
    out.push("  no tainted path matched the rule. The rule's own limits still apply.");
  }
  for (const f of answer.findings) {
    out.push(`  ${f.file}:${f.startLine}  [${f.severity}] ${f.ruleId}`);
    if (f.message) out.push(`      ${f.message}`);
  }
  return out.join(nl) + nl;
}
