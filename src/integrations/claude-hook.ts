#!/usr/bin/env node
// ============================================================================
// Claude Code hook entrypoint  —  slice CTX-S1  (goal G2)
// ============================================================================
// What `~/.claude/settings.json` runs for SessionStart and PreToolUse(Read|
// Grep|Glob). Claude Code passes the event as JSON on stdin; whatever this
// prints is what Claude sees. The logic is in `claude-steering.ts`; this file
// only does I/O, and turns every failure into silence with exit 0, because
// a user-level hook that errors or blocks costs every session on the machine.
//
//   node src/integrations/claude-hook.ts [--config PATH] [--state-dir PATH]
// ============================================================================

import { parseArgs } from "node:util";
import {
  runHook, loadIndexedRepos, DEFAULT_CONFIG, DEFAULT_STATE_DIR,
} from "./claude-steering.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<void> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { config: { type: "string" }, "state-dir": { type: "string" } },
      strict: false,
    });
    const configPath = typeof values.config === "string" ? values.config : DEFAULT_CONFIG;
    const stateDir = typeof values["state-dir"] === "string" ? values["state-dir"] : DEFAULT_STATE_DIR;

    const input: unknown = JSON.parse(await readStdin());
    const out = runHook(input, { repos: loadIndexedRepos(configPath), stateDir });
    if (out !== "") process.stdout.write(out);
  } catch {
    // Silence is the only safe failure mode for a user-level hook.
  }
}

await main(process.argv.slice(2));
process.exitCode = 0;
