// ============================================================================
// Connect Claude Code to code-intel  —  slice CTX-S1  (goal G1, G2)
// ============================================================================
// One idempotent command for the user-level wiring the plan (§5) describes:
//
//   install    merge the steering hooks into ~/.claude/settings.json (backing
//              the file up first), then register the MCP server at user scope
//              through the `claude` CLI
//   uninstall  remove exactly what install added
//   status     report hooks, .env reads, MCP registration, graph db and indexed folders
//
// And, separately, slice CTX-F2 (A/B finding M11 #5):
//
//   deny-env   add Read deny rules for .env and .env.* files in any directory
//              to permissions.deny in ~/.claude/settings.json (backup first)
//   allow-env  remove exactly those rules
//
// They are their own commands so install/uninstall stay exactly as they were.
// The rules, and why .env.example is blocked too: claude-settings.ts.
//
// Nothing here edits a target repo. Which folders the steering is active in is
// decided at hook time from config/repos.json, so onboarding another service
// (CTX-S17) is a config edit, not a reinstall.
//
// A settings file that does not parse is never overwritten: the command fails
// and names it. Every write goes to a temp file first and is renamed into
// place, so an interrupted install cannot leave half a JSON file behind.
//
//   node scripts/claude-integration.ts install|uninstall|status|deny-env|allow-env
//        [--settings PATH] [--config PATH] [--db PATH] [--claude-bin CMD] [--skip-mcp]
// ============================================================================

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadIndexedRepos } from "../src/integrations/claude-steering.ts";
import {
  allowEnvReads, deniedEnvRules, denyEnvReads, hookCommand, installHooks, installedEvents,
  mcpAddArgs, mcpGetArgs, mcpRemoveArgs, uninstallHooks, ENV_DENY_RULES, MCP_SERVER_NAME,
} from "../src/integrations/claude-settings.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: node scripts/claude-integration.ts install|uninstall|status|deny-env|allow-env\n" +
  "         [--settings PATH] [--config PATH] [--db PATH] [--claude-bin CMD] [--skip-mcp]\n";

interface Options {
  settings: string;
  config: string;
  db: string;
  claudeBin: string;
  skipMcp: boolean;
}

class Refusal extends Error {}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Refusal(`cannot parse ${path}: ${(e as Error).message}. Left unchanged.`);
  }
}

/** Write only when the content changes; back up an existing file first. */
function writeSettings(path: string, before: unknown, after: unknown): string {
  const text = JSON.stringify(after, null, 2) + "\n";
  if (existsSync(path) && JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  let note = "created";
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const backup = `${path}.bak-code-intel-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    note = `backup ${backup}`;
  }
  const tmp = `${path}.tmp-code-intel-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return note;
}

/**
 * Run the `claude` CLI. On Windows it is a .cmd shim, which only runs through
 * a shell, so there the command line is built and quoted here.
 */
function claude(opts: Options, args: string[]): { ok: boolean; out: string } {
  const quote = (a: string): string => (/[\s"^&|<>()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = process.platform === "win32"
    ? spawnSync([opts.claudeBin, ...args].map(quote).join(" "), { encoding: "utf8", shell: true })
    : spawnSync(opts.claudeBin, args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function describeIndexed(opts: Options): string {
  try {
    const repos = loadIndexedRepos(opts.config);
    return repos.map((r) => `\n  ${r.serviceName}  ${r.rootPath}`).join("");
  } catch (e) {
    return ` unreadable (${(e as Error).message}); the hook stays silent until it loads`;
  }
}

function install(opts: Options): number {
  const before = readSettings(opts.settings);
  const after = installHooks(before, hookCommand(REPO, opts.config));
  const note = writeSettings(opts.settings, before, after);
  process.stdout.write(`hooks     installed in ${opts.settings} (${note})\n`);
  process.stdout.write(`indexed   ${describeIndexed(opts)}\n`);

  if (opts.skipMcp) {
    process.stdout.write("mcp       skipped (--skip-mcp)\n");
    return 0;
  }
  if (!existsSync(opts.db)) {
    process.stdout.write(`warning   ${opts.db} does not exist yet; build the graph, or every answer will be empty\n`);
  }
  // Remove-then-add keeps the registration's paths current; "not found" is fine.
  claude(opts, mcpRemoveArgs());
  const add = claude(opts, mcpAddArgs(REPO, opts.db));
  if (!add.ok) {
    process.stderr.write(`mcp       registration failed: ${add.out}\n`);
    return 1;
  }
  process.stdout.write(`mcp       ${MCP_SERVER_NAME} registered at user scope (check: claude mcp list)\n`);
  return 0;
}

function uninstall(opts: Options): number {
  const before = readSettings(opts.settings);
  const note = writeSettings(opts.settings, before, uninstallHooks(before));
  process.stdout.write(`hooks     removed from ${opts.settings} (${note})\n`);
  if (opts.skipMcp) {
    process.stdout.write("mcp       skipped (--skip-mcp)\n");
    return 0;
  }
  const r = claude(opts, mcpRemoveArgs());
  process.stdout.write(`mcp       ${r.ok ? `${MCP_SERVER_NAME} removed` : `not removed: ${r.out}`}\n`);
  return 0;
}

function denyEnv(opts: Options): number {
  const before = readSettings(opts.settings);
  const note = writeSettings(opts.settings, before, denyEnvReads(before));
  process.stdout.write(`env reads denied in ${opts.settings} (${note}): ${ENV_DENY_RULES.join(", ")}\n`);
  return 0;
}

function allowEnv(opts: Options): number {
  const before = readSettings(opts.settings);
  const note = writeSettings(opts.settings, before, allowEnvReads(before));
  process.stdout.write(`env reads deny rules removed from ${opts.settings} (${note})\n`);
  return 0;
}

function status(opts: Options): number {
  const settings = readSettings(opts.settings);
  const events = installedEvents(settings);
  const hooks = events.length === 2 ? "installed" : events.length === 0 ? "not installed" : `partial (${events.join(", ")})`;
  process.stdout.write(`hooks     ${hooks} (${opts.settings})\n`);
  const rules = deniedEnvRules(settings);
  const env = rules.length === ENV_DENY_RULES.length ? "denied"
    : rules.length === 0 ? "not denied (npm run claude:deny-env)" : `partial (${rules.join(", ")})`;
  process.stdout.write(`env reads ${env}\n`);
  process.stdout.write(`graph db  ${existsSync(opts.db) ? "present" : "missing"} (${opts.db})\n`);
  process.stdout.write(`indexed   ${describeIndexed(opts)}\n`);
  if (opts.skipMcp) {
    process.stdout.write("mcp       not checked (--skip-mcp)\n");
  } else {
    const r = claude(opts, mcpGetArgs());
    process.stdout.write(`mcp       ${r.ok ? `registered\n${r.out}` : "not registered"}\n`);
  }
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      settings: { type: "string" },
      config: { type: "string" },
      db: { type: "string" },
      "claude-bin": { type: "string" },
      "skip-mcp": { type: "boolean" },
    },
  });
}

function main(argv: string[]): number {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const opts: Options = {
    settings: resolve(values.settings ?? join(homedir(), ".claude", "settings.json")),
    config: resolve(values.config ?? join(REPO, "config", "repos.json")),
    db: resolve(values.db ?? join(REPO, ".codeintel", "graph.db")),
    claudeBin: values["claude-bin"] ?? "claude",
    skipMcp: values["skip-mcp"] === true,
  };

  try {
    switch (positionals[0]) {
      case "install": return install(opts);
      case "uninstall": return uninstall(opts);
      case "status": return status(opts);
      case "deny-env": return denyEnv(opts);
      case "allow-env": return allowEnv(opts);
      default:
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
