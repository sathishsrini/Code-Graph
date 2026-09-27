// ============================================================================
// Claude Code steering  —  slice CTX-S1  (goal G1, G2)
// ============================================================================
// The logic behind `claude-hook.ts`, the hook Claude Code runs. It is
// installed at USER level (`~/.claude/settings.json`) by
// `scripts/claude-integration.ts`, so it runs in every Claude Code session on
// the machine: the CLI, `claude -p`, and the VS Code panel alike. It does two
// things, and only when the session's cwd is a folder `config/repos.json`
// lists (or contains one, so opening the parent workspace counts):
//
//   SessionStart  → prints the "ask the graph first" instruction. Plain stdout
//                   is what Claude Code adds to context for this event.
//   PreToolUse    → on the first Read/Grep/Glob of a session, one reminder via
//                   `hookSpecificOutput.additionalContext`. Never again in
//                   that session.
//
// **It never blocks.** The graph has gaps (UNKNOWN sections, a Python service
// with no call tree), and a hook that denied Read would hide exactly the code
// the graph cannot see. So the output never carries a permission decision,
// and the entrypoint turns every failure (bad stdin, a missing config, an
// unwritable state dir) into exit 0 with nothing printed. Exit code 2 is the
// one that blocks a tool call; nothing here produces it.
//
// "Once per session" is kept with a marker file per session id, created with
// the exclusive `wx` flag, so parallel tool calls cannot both win the race.
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/repos.ts";

/** The name the MCP server is registered under; tools appear as `mcp__<name>__<tool>`. */
export const MCP_SERVER_NAME = "code-intel";

/** Tools whose first use in a session earns the reminder. */
export const REMINDED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export interface IndexedRepo {
  name: string;
  serviceName: string;
  rootPath: string;
}

export interface HookDeps {
  repos: IndexedRepo[];
  /** Where the once-per-session markers live. */
  stateDir: string;
  /** Decides case sensitivity. Defaults to the running platform. */
  platform?: NodeJS.Platform;
}

/** Slash-normalised, trailing-slash-free; lower-cased on Windows. */
function normalise(path: string, platform: NodeJS.Platform): string {
  let p = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Is `a` equal to `b` or a path beneath it? Both already normalised. */
function within(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/**
 * The repos a cwd relates to: those it sits inside, and those it contains.
 * Comparison is by whole path segments, so `/ws/router-old` does not match
 * `/ws/router`.
 */
export function matchingRepos(
  cwd: string, repos: IndexedRepo[], platform: NodeJS.Platform = process.platform,
): IndexedRepo[] {
  if (cwd.trim() === "") return [];
  const c = normalise(cwd, platform);
  return repos.filter((r) => {
    const root = normalise(r.rootPath, platform);
    return within(c, root) || within(root, c);
  });
}

export function isIndexedFolder(
  cwd: string, repos: IndexedRepo[], platform: NodeJS.Platform = process.platform,
): boolean {
  return matchingRepos(cwd, repos, platform).length > 0;
}

const tool = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/**
 * The SessionStart instruction. It lists every indexed service, not only the
 * one the cwd matched, because a flow crosses services and `endpoint_flow`
 * takes the service name as an argument.
 */
export function sessionInstruction(repos: IndexedRepo[]): string {
  const services = [...new Set(repos.map((r) => r.serviceName))].join(", ");
  return [
    `code-intel: this folder is indexed in the code graph (services: ${services}).`,
    "Ask the graph before reading files to explore or plan:",
    `- ${tool("endpoint_flow")}: what runs on an endpoint (auth chain, call tree, other services)`,
    `- ${tool("context_pack")}: what you need before editing a function`,
    `- ${tool("impact")}: what a change breaks`,
    `- ${tool("security_path")}: which checks run on which routes`,
    "Then Read only the lines you will edit. Treat 'inferred' edges as leads, not facts.",
    "Where an answer lists a gap (UNKNOWN), read that code: the graph could not see it.",
  ].join("\n") + "\n";
}

/** The one-per-session PreToolUse reminder. */
export function readReminder(): string {
  return "code-intel (reminder, once per session): this folder is in the code graph. " +
    `Before exploring with Read/Grep/Glob, try ${tool("endpoint_flow")}, ` +
    `${tool("context_pack")} or ${tool("impact")}; they usually cost fewer tokens ` +
    "than the files. Reading is right for the lines you edit and for gaps the graph reports.";
}

/**
 * Claim the session's reminder. True exactly once per session id; false if it
 * was already claimed or the marker cannot be written (then no reminder is
 * better than one per tool call).
 */
function claimReminder(stateDir: string, sessionId: string): boolean {
  const marker = join(stateDir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.reminded`);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

const field = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined;

/**
 * Turn one hook payload (Claude Code's stdin JSON) into what to print.
 * Returns "" whenever the right answer is silence.
 */
export function runHook(input: unknown, deps: HookDeps): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const payload = input as Record<string, unknown>;
  const cwd = field(payload, "cwd");
  if (cwd === undefined || !isIndexedFolder(cwd, deps.repos, deps.platform)) return "";

  switch (field(payload, "hook_event_name")) {
    case "SessionStart":
      return sessionInstruction(deps.repos);

    case "PreToolUse": {
      const toolName = field(payload, "tool_name");
      const sessionId = field(payload, "session_id");
      if (toolName === undefined || !REMINDED_TOOLS.includes(toolName)) return "";
      if (sessionId === undefined || sessionId === "") return "";
      if (!claimReminder(deps.stateDir, sessionId)) return "";
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: readReminder() },
      });
    }

    default:
      return "";
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = resolve(HERE, "../../config/repos.json");
export const DEFAULT_STATE_DIR = join(tmpdir(), "code-intel-claude-hook");

/** Read the indexed repos. Paths are not checked: a missing corpus must not break the hook. */
export function loadIndexedRepos(configPath: string): IndexedRepo[] {
  return loadConfig(configPath, { checkPaths: false }).repos.map((r) => ({
    name: r.name, serviceName: r.serviceName, rootPath: r.rootPath,
  }));
}
