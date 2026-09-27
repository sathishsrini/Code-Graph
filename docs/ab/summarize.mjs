// Summarise `claude -p --output-format stream-json` logs from the A/B token check
// (docs/ab-token-check.md). For each log: tokens, cost, turns, which tools ran,
// and the final answer written next to the log as <log>.answer.md for scoring.
//
//   node docs/ab/summarize.mjs <run.jsonl> [...]

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const rows = [];
for (const file of process.argv.slice(2)) {
  const events = readFileSync(file, "utf8").split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const tools = {};
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c?.type === "tool_use") tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
  }
  const result = events.findLast((e) => e.type === "result");
  if (!result) { rows.push({ run: basename(file), error: "no result line (run failed or was cut off)" }); continue; }

  const u = result.usage ?? {};
  const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
  const count = (re) => Object.entries(tools).filter(([n]) => re.test(n)).reduce((s, [, k]) => s + k, 0);

  writeFileSync(`${file}.answer.md`, String(result.result ?? ""));
  rows.push({
    run: basename(file, ".jsonl"),
    ok: result.subtype === "success" && !result.is_error,
    totalTokens: total,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    usd: Number((result.total_cost_usd ?? 0).toFixed(4)),
    turns: result.num_turns,
    seconds: Math.round((result.duration_ms ?? 0) / 1000),
    graphCalls: count(/^mcp__code-intel__/),
    fileReads: count(/^(Read|Grep|Glob)$/),
    denied: (result.permission_denials ?? []).length,
  });
}
console.table(rows);
