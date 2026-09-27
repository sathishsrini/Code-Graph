// ============================================================================
// Claude Code user settings merge  —  slice CTX-S1  (goal G2)
// ============================================================================
// Pure functions over a parsed `~/.claude/settings.json`, used by
// `scripts/claude-integration.ts`. The file belongs to the user and holds
// their own model choice, permissions and hooks, so the merge:
//
//   - never touches a key it did not write, and never mutates its input;
//   - finds its own entries by the hook file they run, not by position, so a
//     reinstall from a moved checkout replaces the old entry instead of
//     adding a second one;
//   - is idempotent: install(install(s)) equals install(s), and
//     uninstall(install(s)) equals s;
//   - refuses a shape it does not understand rather than replacing it.
// ============================================================================

import { MCP_SERVER_NAME } from "./claude-steering.ts";

export { MCP_SERVER_NAME };

/** Repo-relative path of the hook; also how our entries are recognised. */
export const HOOK_FILE = "src/integrations/claude-hook.ts";
/** The PreToolUse matcher: the exploratory tools the graph can replace. */
export const READ_MATCHER = "Read|Grep|Glob";
/** Seconds. A timed-out hook never blocks the tool call, so this only bounds latency. */
export const HOOK_TIMEOUT_SECONDS = 10;

/** Events this integration registers in. */
const EVENTS = ["SessionStart", "PreToolUse"] as const;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The command Claude Code runs for both events. Paths are absolute because the
 * hook runs with the target repo as cwd, and forward-slashed because Node
 * accepts them on Windows and they survive both cmd and bash quoting.
 */
export function hookCommand(repoRoot: string, configPath: string): string {
  return `node "${slash(repoRoot)}/${HOOK_FILE}" --config "${slash(configPath)}"`;
}

/** `claude` CLI arguments that register the MCP server at user scope. */
export function mcpAddArgs(repoRoot: string, dbPath: string): string[] {
  return [
    "mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--",
    "node", `${slash(repoRoot)}/src/cli.ts`, "mcp", "--db", slash(dbPath),
  ];
}

export const mcpRemoveArgs = (): string[] => ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME];
export const mcpGetArgs = (): string[] => ["mcp", "get", MCP_SERVER_NAME];

const isOurs = (handler: unknown): boolean =>
  isObject(handler) && typeof handler["command"] === "string" &&
  slash(handler["command"]).includes(HOOK_FILE);

function requireSettings(settings: unknown): Json {
  if (!isObject(settings)) throw new Error("settings must be a JSON object");
  if (settings["hooks"] !== undefined && !isObject(settings["hooks"])) {
    throw new Error("settings.hooks must be an object");
  }
  const hooks = (settings["hooks"] ?? {}) as Json;
  for (const event of EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`settings.hooks.${event} must be an array`);
    }
  }
  return settings;
}

/**
 * Remove every handler this integration wrote, from every event. A group left
 * empty by that is dropped, an event left empty is dropped, and `hooks` is
 * dropped if nothing remains. Groups and events the user owns are untouched,
 * including a user hook that shares a group with ours.
 */
export function uninstallHooks(settings: unknown): Json {
  const out = structuredClone(requireSettings(settings));
  if (!isObject(out["hooks"])) return out;
  const hooks = out["hooks"];

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group["hooks"])) { kept.push(group); continue; }
      const handlers = group["hooks"] as unknown[];
      const remaining = handlers.filter((h) => !isOurs(h));
      if (remaining.length === handlers.length) { kept.push(group); continue; }
      removed = true;
      if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
    }
    if (!removed) continue;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete out["hooks"];
  return out;
}

/** Add (or refresh) the SessionStart and PreToolUse hooks. */
export function installHooks(settings: unknown, command: string): Json {
  const out = uninstallHooks(settings);
  const hooks = isObject(out["hooks"]) ? out["hooks"] : {};
  const handler = { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };

  hooks["SessionStart"] = [...((hooks["SessionStart"] as unknown[]) ?? []), { hooks: [handler] }];
  hooks["PreToolUse"] = [
    ...((hooks["PreToolUse"] as unknown[]) ?? []),
    { matcher: READ_MATCHER, hooks: [{ ...handler }] },
  ];
  out["hooks"] = hooks;
  return out;
}

/** Which of the two events currently run this integration's hook. */
export function installedEvents(settings: unknown): string[] {
  if (!isObject(settings) || !isObject(settings["hooks"])) return [];
  const hooks = settings["hooks"];
  return EVENTS.filter((event) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g) =>
      isObject(g) && Array.isArray(g["hooks"]) && (g["hooks"] as unknown[]).some(isOurs));
  });
}

/** True when both events are registered. */
export function hooksInstalled(settings: unknown): boolean {
  return installedEvents(settings).length === EVENTS.length;
}
