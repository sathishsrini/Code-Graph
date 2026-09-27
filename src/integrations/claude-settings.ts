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

// ----------------------------------------------------------------------------
// .env Read deny rules  —  slice CTX-F2  (A/B finding M11 #5)
// ----------------------------------------------------------------------------
// In the A/B check, plain Claude read a corpus `.env` and quoted it. The
// "never read .env" rule lived only in this repo's CLAUDE.md, which no session
// elsewhere loads, so it is written into user settings as permission rules.
// Kept separate from the hooks: `deny-env`/`allow-env` never touch `hooks`, and
// install/uninstall never touch `permissions`.
//
// Syntax (https://code.claude.com/docs/en/permissions, "Read and Edit"): Read
// rules use gitignore patterns. `Read(.env)` and `Read(**/.env)` block a .env
// "at or under the current directory" only; `Read(//**/.env)` blocks "any
// `.env` anywhere on the filesystem", and on Windows "across all drives". A
// `/path` rule in user settings would anchor at ~/.claude, so `//` it is.
// Claude Code applies Read rules to Grep and Glob as a "best-effort attempt",
// and to Bash file commands it recognises (cat, head, …), not to scripts.
//
// Trade-off: `.env.*` also blocks `.env.example`, which this repo tells Claude
// to edit, and a Read deny also blocks Edit/Write on that path. Blocked anyway,
// because `.env.local` and `.env.production` are where real secrets live (the
// Next.js convention; 60-kri-next is a Next.js app). A `!.env.example` carve-out
// cannot help: a `!` pattern "can't reach a rule anchored with" `//`.
// ----------------------------------------------------------------------------

/** What deny-env adds to `permissions.deny`, and all that allow-env removes. */
export const ENV_DENY_RULES: readonly string[] = ["Read(//**/.env)", "Read(//**/.env.*)"];

function requirePermissions(settings: unknown): Json {
  if (!isObject(settings)) throw new Error("settings must be a JSON object");
  const permissions = settings["permissions"];
  if (permissions === undefined) return settings;
  if (!isObject(permissions)) throw new Error("settings.permissions must be an object");
  if (permissions["deny"] !== undefined && !Array.isArray(permissions["deny"])) {
    throw new Error("settings.permissions.deny must be an array");
  }
  return settings;
}

/** Add the .env Read deny rules after the user's own; a rule already present is not repeated. */
export function denyEnvReads(settings: unknown): Json {
  const out = structuredClone(requirePermissions(settings));
  const permissions = isObject(out["permissions"]) ? out["permissions"] : {};
  const deny = (permissions["deny"] as unknown[] | undefined) ?? [];
  const missing = ENV_DENY_RULES.filter((rule) => !deny.includes(rule));
  if (missing.length === 0) return out;
  permissions["deny"] = [...deny, ...missing];
  out["permissions"] = permissions;
  return out;
}

/**
 * Remove exactly the rules deny-env adds. A `deny` list left empty is dropped,
 * and `permissions` too if nothing remains, so allow(deny(s)) equals s unless
 * s already held one of these rules or an empty `deny` list.
 */
export function allowEnvReads(settings: unknown): Json {
  const out = structuredClone(requirePermissions(settings));
  const permissions = out["permissions"];
  if (!isObject(permissions) || !Array.isArray(permissions["deny"])) return out;
  const deny = permissions["deny"] as unknown[];
  const kept = deny.filter((rule) => !ENV_DENY_RULES.includes(rule as string));
  if (kept.length === deny.length) return out;
  if (kept.length > 0) permissions["deny"] = kept;
  else delete permissions["deny"];
  if (Object.keys(permissions).length === 0) delete out["permissions"];
  return out;
}

/** Which of the .env rules `permissions.deny` currently holds. */
export function deniedEnvRules(settings: unknown): string[] {
  if (!isObject(settings) || !isObject(settings["permissions"])) return [];
  const deny = settings["permissions"]["deny"];
  return Array.isArray(deny) ? ENV_DENY_RULES.filter((rule) => deny.includes(rule)) : [];
}

/** True when every .env rule is in place. */
export function envReadsDenied(settings: unknown): boolean {
  return deniedEnvRules(settings).length === ENV_DENY_RULES.length;
}
