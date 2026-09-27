// Tests for the Claude Code connection (slice CTX-S1, goal G1/G2).
//
// Three properties make the steering safe to install at user level:
//   1. It is silent outside the folders `config/repos.json` lists. A user-level
//      hook fires in every repo on the machine; one that talks everywhere is
//      noise in every unrelated session.
//   2. It never blocks. The graph has gaps (UNKNOWN sections, the empty Python
//      call tree), so a hook that denied Read would hide code the graph cannot
//      see. The hook emits no permission decision and exits 0 on any error.
//   3. Its cost is bounded: one instruction per session start, at most one
//      reminder per session.
// The installer merges into a settings file the user owns. It must keep every
// key it did not write, be idempotent, and never overwrite a file it cannot parse.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isIndexedFolder, runHook, sessionInstruction, readReminder, type IndexedRepo,
} from "../src/integrations/claude-steering.ts";
import {
  installHooks, uninstallHooks, hooksInstalled, hookCommand, mcpAddArgs,
  MCP_SERVER_NAME, ENV_DENY_RULES, denyEnvReads, allowEnvReads, envReadsDenied,
} from "../src/integrations/claude-settings.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO, "src", "integrations", "claude-hook.ts");
const INSTALLER = join(REPO, "scripts", "claude-integration.ts");

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-claude-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const tokens = (s: string): number => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

const WIN_ROOTS: IndexedRepo[] = [
  { name: "40-kri-router", serviceName: "40-kri-router", rootPath: "D:/###facilitator/dev-workspace/40-kri-router" },
  { name: "41-kri-engine", serviceName: "41-kri-engine", rootPath: "D:/###facilitator/dev-workspace/41-kri-engine" },
];
const POSIX_ROOTS: IndexedRepo[] = [
  { name: "router", serviceName: "router", rootPath: "/ws/router" },
  { name: "engine", serviceName: "engine-svc", rootPath: "/ws/engine" },
];

describe("the indexed-folder check", () => {
  test("a cwd equal to a rootPath is indexed", () => {
    assert.equal(isIndexedFolder("/ws/router", POSIX_ROOTS, "linux"), true);
  });

  test("a cwd inside a rootPath is indexed", () => {
    assert.equal(isIndexedFolder("/ws/router/lib/deep", POSIX_ROOTS, "linux"), true);
  });

  test("a cwd containing a rootPath is indexed (opening the parent workspace)", () => {
    assert.equal(isIndexedFolder("/ws", POSIX_ROOTS, "linux"), true);
  });

  test("a sibling that only shares a name prefix is not indexed", () => {
    assert.equal(isIndexedFolder("/ws/router-old", POSIX_ROOTS, "linux"), false);
    assert.equal(isIndexedFolder("/ws/route", POSIX_ROOTS, "linux"), false);
  });

  test("an unrelated folder is not indexed", () => {
    assert.equal(isIndexedFolder("/home/me/other-project", POSIX_ROOTS, "linux"), false);
    assert.equal(isIndexedFolder("", POSIX_ROOTS, "linux"), false);
  });

  test("trailing separators do not matter", () => {
    assert.equal(isIndexedFolder("/ws/router/", POSIX_ROOTS, "linux"), true);
  });

  test("on Windows the comparison ignores case and slash direction", () => {
    assert.equal(
      isIndexedFolder("d:\\###facilitator\\Dev-Workspace\\40-KRI-router\\lib", WIN_ROOTS, "win32"), true);
    assert.equal(isIndexedFolder("D:\\###facilitator\\dev-workspace", WIN_ROOTS, "win32"), true);
    assert.equal(isIndexedFolder("D:\\###facilitator\\dev-workspace\\60-kri-next", WIN_ROOTS, "win32"), false);
    assert.equal(isIndexedFolder("C:\\Users\\me\\project", WIN_ROOTS, "win32"), false);
  });

  test("elsewhere the comparison is case-sensitive", () => {
    assert.equal(isIndexedFolder("/WS/router", POSIX_ROOTS, "linux"), false);
  });
});

describe("the hook's output", () => {
  const deps = () => ({ repos: POSIX_ROOTS, stateDir: join(dir, "state"), platform: "linux" as const });
  const start = (cwd: string) => ({ hook_event_name: "SessionStart", session_id: "s-start", cwd, source: "startup" });
  const pre = (session: string, tool = "Read", cwd = "/ws/router") => ({
    hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: tool,
    tool_input: { file_path: `${cwd}/server.js` },
  });

  test("SessionStart prints nothing in a folder that is not indexed", () => {
    assert.equal(runHook(start("/home/me/other"), deps()), "");
  });

  test("SessionStart prints the instruction as plain text in an indexed folder", () => {
    const out = runHook(start("/ws/router"), deps());
    assert.ok(out.length > 0);
    assert.throws(() => JSON.parse(out), "plain stdout is what SessionStart adds to context");
    for (const tool of ["endpoint_flow", "context_pack", "impact", "security_path", "error_trace"]) {
      assert.match(out, new RegExp(`mcp__${MCP_SERVER_NAME}__${tool}`), `names ${tool}`);
    }
    assert.match(out, /engine-svc/, "names the services by the name endpoint_flow expects");
    assert.match(out, /inferred/, "tells Claude an inferred edge is a lead");
    assert.match(out, /gap|UNKNOWN/, "tells Claude to read where the graph has a gap");
  });

  test("SessionStart repeats after compaction, so the instruction survives it", () => {
    assert.ok(runHook({ ...start("/ws/router"), source: "compact" }, deps()).length > 0);
  });

  test("the first Read in an indexed session gets one reminder, and no decision", () => {
    const out = runHook(pre("s-once"), deps());
    const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, unknown> };
    assert.equal(parsed.hookSpecificOutput["hookEventName"], "PreToolUse");
    assert.equal(parsed.hookSpecificOutput["additionalContext"], readReminder());
    assert.equal("permissionDecision" in parsed.hookSpecificOutput, false, "never allow/deny/ask");
    assert.equal("decision" in parsed, false);
    assert.equal("continue" in parsed, false);
  });

  test("the reminder appears once per session, across Read, Grep and Glob", () => {
    const d = deps();
    assert.notEqual(runHook(pre("s-many", "Read"), d), "");
    assert.equal(runHook(pre("s-many", "Read"), d), "");
    assert.equal(runHook(pre("s-many", "Grep"), d), "");
    assert.equal(runHook(pre("s-many", "Glob"), d), "");
  });

  test("a new session gets its own reminder", () => {
    const d = deps();
    assert.notEqual(runHook(pre("s-a"), d), "");
    assert.notEqual(runHook(pre("s-b"), d), "");
  });

  test("no reminder outside indexed folders, and none is used up there", () => {
    const d = deps();
    assert.equal(runHook(pre("s-out", "Read", "/home/me/other"), d), "");
    assert.notEqual(runHook(pre("s-out", "Read", "/ws/router"), d), "");
  });

  test("tools other than Read, Grep and Glob get nothing, even if a matcher lets them through", () => {
    assert.equal(runHook(pre("s-edit", "Edit"), deps()), "");
    assert.equal(runHook(pre("s-bash", "Bash"), deps()), "");
  });

  test("without a session id there is no reminder, because once-per-session cannot be kept", () => {
    const { session_id: _drop, ...noSession } = pre("x");
    assert.equal(runHook(noSession, deps()), "");
  });

  test("unknown events and malformed input print nothing", () => {
    assert.equal(runHook({ hook_event_name: "Stop", cwd: "/ws/router", session_id: "s" }, deps()), "");
    assert.equal(runHook(null, deps()), "");
    assert.equal(runHook("not an object", deps()), "");
    assert.equal(runHook({ hook_event_name: "SessionStart", cwd: 42 }, deps()), "");
  });

  test("the token overhead is bounded: instruction and reminder are short", () => {
    const instruction = sessionInstruction(POSIX_ROOTS);
    assert.ok(tokens(instruction) <= 250, `instruction is ${tokens(instruction)} tokens`);
    assert.ok(tokens(readReminder()) <= 100, `reminder is ${tokens(readReminder())} tokens`);
  });
});

describe("the hook process never blocks", () => {
  const configFor = (rootPath: string): string => {
    const path = join(dir, `repos-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({
      repos: [{ name: "svc", rootPath, lang: "js", framework: "fastify" }],
    }));
    return path;
  };
  const runProcess = (stdin: string, args: string[]) =>
    spawnSync(process.execPath, [HOOK, ...args], { input: stdin, encoding: "utf8" });

  test("SessionStart in an indexed folder prints the instruction and exits 0", () => {
    const root = join(dir, "indexed-svc");
    mkdirSync(root, { recursive: true });
    const r = runProcess(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "p1", cwd: root, source: "startup" }),
      ["--config", configFor(root), "--state-dir", join(dir, "proc-state")],
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /mcp__code-intel__endpoint_flow/);
  });

  test("the first PreToolUse prints valid JSON and exits 0", () => {
    const root = join(dir, "indexed-svc-2");
    mkdirSync(root, { recursive: true });
    const r = runProcess(
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "p2", cwd: root, tool_name: "Read" }),
      ["--config", configFor(root), "--state-dir", join(dir, "proc-state")],
    );
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "PreToolUse");
  });

  test("malformed stdin exits 0 silently", () => {
    const r = runProcess("{not json", ["--config", configFor(dir), "--state-dir", join(dir, "proc-state")]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });

  test("a missing or invalid config exits 0 silently", () => {
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "p3", cwd: dir });
    const missing = runProcess(input, ["--config", join(dir, "nope.json"), "--state-dir", join(dir, "proc-state")]);
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout, "");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ broken");
    const invalid = runProcess(input, ["--config", bad, "--state-dir", join(dir, "proc-state")]);
    assert.equal(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  });

  test("an unwritable state dir costs the reminder, never the tool call", () => {
    const root = join(dir, "indexed-svc-3");
    mkdirSync(root, { recursive: true });
    const blocker = join(dir, "state-is-a-file");
    writeFileSync(blocker, "");
    const r = runProcess(
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "p4", cwd: root, tool_name: "Read" }),
      ["--config", configFor(root), "--state-dir", join(blocker, "sub")],
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

describe("the settings merge", () => {
  const CMD = hookCommand("/opt/code-intel", "/opt/code-intel/config/repos.json");

  const userSettings = () => ({
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    env: { FOO: "bar" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/home/me/guard.sh" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: [{ hooks: [{ type: "command", command: "/home/me/stop.sh" }] }],
    },
  });

  test("the hook command runs the hook file with node and names the config", () => {
    assert.match(CMD, /^node "\/opt\/code-intel\/src\/integrations\/claude-hook\.ts" --config "\/opt\/code-intel\/config\/repos\.json"$/);
  });

  test("installing into empty settings adds one SessionStart and one PreToolUse(Read|Grep|Glob) hook", () => {
    const s = installHooks({}, CMD) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    assert.equal(s.hooks["SessionStart"]!.length, 1);
    assert.equal(s.hooks["SessionStart"]![0]!.hooks[0]!.command, CMD);
    assert.equal(s.hooks["PreToolUse"]!.length, 1);
    assert.equal(s.hooks["PreToolUse"]![0]!.matcher, "Read|Grep|Glob");
    assert.equal(s.hooks["PreToolUse"]![0]!.hooks[0]!.command, CMD);
    assert.equal(hooksInstalled(s), true);
    assert.equal(hooksInstalled({}), false);
  });

  test("installing keeps every key and hook the user already had", () => {
    const before = userSettings();
    const s = installHooks(before, CMD) as ReturnType<typeof userSettings>;
    assert.equal(s.model, "opus");
    assert.deepEqual(s.permissions, before.permissions);
    assert.deepEqual(s.env, before.env);
    assert.deepEqual(s.hooks.Stop, before.hooks.Stop);
    assert.deepEqual(s.hooks.PreToolUse[0], before.hooks.PreToolUse[0], "user hooks stay first, unchanged");
    assert.deepEqual(s.hooks.SessionStart[0], before.hooks.SessionStart[0]);
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.SessionStart.length, 2);
  });

  test("installing does not mutate its input", () => {
    const before = userSettings();
    const copy = structuredClone(before);
    installHooks(before, CMD);
    assert.deepEqual(before, copy);
  });

  test("installing twice is the same as installing once", () => {
    const once = installHooks(userSettings(), CMD);
    assert.deepEqual(installHooks(once, CMD), once);
  });

  test("reinstalling from a moved checkout replaces the old entry instead of adding one", () => {
    const moved = hookCommand("/new/place", "/new/place/config/repos.json");
    const s = installHooks(installHooks({}, CMD), moved) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    assert.equal(s.hooks["PreToolUse"]!.length, 1);
    assert.equal(s.hooks["PreToolUse"]![0]!.hooks[0]!.command, moved);
  });

  test("uninstalling removes only this integration's hooks", () => {
    for (const original of [userSettings(), {}, { model: "sonnet" }]) {
      assert.deepEqual(uninstallHooks(installHooks(original, CMD)), original);
    }
  });

  test("a group that mixes a user hook with ours keeps the user hook", () => {
    const mixed = {
      hooks: {
        PreToolUse: [{
          matcher: "Read|Grep|Glob",
          hooks: [{ type: "command", command: "/home/me/log.sh" }, { type: "command", command: CMD }],
        }],
      },
    };
    const s = uninstallHooks(mixed) as typeof mixed;
    assert.deepEqual(s.hooks.PreToolUse, [
      { matcher: "Read|Grep|Glob", hooks: [{ type: "command", command: "/home/me/log.sh" }] },
    ]);
  });

  test("settings that are not an object are refused, not replaced", () => {
    assert.throws(() => installHooks([], CMD), /settings/);
    assert.throws(() => installHooks({ hooks: "x" }, CMD), /hooks/);
    assert.throws(() => installHooks({ hooks: { PreToolUse: {} } }, CMD), /PreToolUse/);
  });

  test("MCP registration is user scope, named code-intel, with absolute paths", () => {
    const args = mcpAddArgs("/opt/code-intel", "/opt/code-intel/.codeintel/graph.db");
    assert.deepEqual(args, [
      "mcp", "add", "--scope", "user", "code-intel", "--",
      "node", "/opt/code-intel/src/cli.ts", "mcp", "--db", "/opt/code-intel/.codeintel/graph.db",
    ]);
  });
});

// CTX-F2 (A/B finding M11 #5): plain Claude read a corpus `.env` and quoted it.
// The "never read .env" rule lived only in this repo's CLAUDE.md, so it did not
// reach sessions elsewhere. deny-env puts it in user settings as permission rules.
describe("the .env deny rules (CTX-F2)", () => {
  const userSettings = () => ({
    model: "opus",
    permissions: {
      allow: ["Bash(npm test)"],
      deny: ["Read(./secrets/**)", "Read(./.env)"],
      defaultMode: "acceptEdits",
    },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/home/me/stop.sh" }] }] },
  });

  test("the rules cover .env and .env.* in any directory, anchored at the filesystem root", () => {
    // `Read(**/.env)` would only cover the session's cwd; `//` holds in every
    // project and, on Windows, across all drives.
    assert.deepEqual(ENV_DENY_RULES, ["Read(//**/.env)", "Read(//**/.env.*)"]);
  });

  test("deny-env adds the rules to permissions.deny in empty settings", () => {
    const s = denyEnvReads({});
    assert.deepEqual(s, { permissions: { deny: [...ENV_DENY_RULES] } });
    assert.equal(envReadsDenied(s), true);
    assert.equal(envReadsDenied({}), false);
  });

  test("deny-env keeps every other key and the user's own allow and deny rules", () => {
    const before = userSettings();
    const s = denyEnvReads(before) as ReturnType<typeof userSettings>;
    assert.equal(s.model, "opus");
    assert.deepEqual(s.hooks, before.hooks);
    assert.deepEqual(s.permissions.allow, before.permissions.allow);
    assert.equal(s.permissions.defaultMode, "acceptEdits");
    assert.deepEqual(s.permissions.deny, [...before.permissions.deny, ...ENV_DENY_RULES],
      "user rules stay first, unchanged");
  });

  test("deny-env is idempotent and does not mutate its input", () => {
    const before = userSettings();
    const copy = structuredClone(before);
    const once = denyEnvReads(before);
    assert.deepEqual(before, copy);
    assert.deepEqual(denyEnvReads(once), once);
  });

  test("deny-env adds only the rule that is missing", () => {
    const s = denyEnvReads({ permissions: { deny: [ENV_DENY_RULES[0]] } }) as { permissions: { deny: string[] } };
    assert.deepEqual(s.permissions.deny, [...ENV_DENY_RULES]);
  });

  test("allow-env removes exactly the rules deny-env adds", () => {
    for (const original of [userSettings(), {}, { model: "sonnet" }, { permissions: { allow: ["Read"] } }]) {
      assert.deepEqual(allowEnvReads(denyEnvReads(original)), original);
    }
    const kept = allowEnvReads(denyEnvReads(userSettings())) as ReturnType<typeof userSettings>;
    assert.ok(kept.permissions.deny.includes("Read(./.env)"), "a rule the user wrote survives");
  });

  test("the .env rules and the steering hooks install and uninstall independently", () => {
    const CMD = hookCommand("/opt/code-intel", "/opt/code-intel/config/repos.json");
    const both = installHooks(denyEnvReads(userSettings()), CMD);
    assert.equal(envReadsDenied(both), true);
    assert.equal(hooksInstalled(both), true);
    assert.deepEqual(uninstallHooks(both), denyEnvReads(userSettings()));
    assert.deepEqual(allowEnvReads(uninstallHooks(both)), userSettings());
  });

  test("a permissions shape it does not understand is refused, not replaced", () => {
    assert.throws(() => denyEnvReads([]), /settings/);
    assert.throws(() => denyEnvReads({ permissions: "x" }), /permissions/);
    assert.throws(() => denyEnvReads({ permissions: { deny: "Read" } }), /permissions\.deny/);
    assert.throws(() => allowEnvReads({ permissions: { deny: {} } }), /permissions\.deny/);
  });
});

describe("the installer script", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8" });

  test("install merges, backs up the original, and uninstall restores it", () => {
    const home = join(dir, "claude-home-1");
    mkdirSync(home, { recursive: true });
    const settings = join(home, "settings.json");
    const original = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };
    writeFileSync(settings, JSON.stringify(original, null, 2));

    const first = run(["install", "--settings", settings, "--skip-mcp"]);
    assert.equal(first.status, 0, first.stderr);
    const installed = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(hooksInstalled(installed), true);
    assert.equal(installed.model, "opus");

    const backups = readdirSync(home).filter((f) => f.startsWith("settings.json.bak-code-intel-"));
    assert.equal(backups.length, 1, "one backup of the original");
    assert.deepEqual(JSON.parse(readFileSync(join(home, backups[0]!), "utf8")), original);

    const second = run(["install", "--settings", settings, "--skip-mcp"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readdirSync(home).filter((f) => f.includes(".bak-code-intel-")).length, 1,
      "an unchanged file is not rewritten or backed up again");

    const status = run(["status", "--settings", settings, "--skip-mcp"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /hooks\s+installed/);

    const removed = run(["uninstall", "--settings", settings, "--skip-mcp"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);
  });

  test("install creates the settings file when there is none", () => {
    const settings = join(dir, "claude-home-2", "settings.json");
    const r = run(["install", "--settings", settings, "--skip-mcp"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hooksInstalled(JSON.parse(readFileSync(settings, "utf8"))), true);
  });

  test("a settings file that does not parse is left untouched and the install fails", () => {
    const home = join(dir, "claude-home-3");
    mkdirSync(home, { recursive: true });
    const settings = join(home, "settings.json");
    writeFileSync(settings, "{ \"model\": \"opus\", }");
    const r = run(["install", "--settings", settings, "--skip-mcp"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /settings\.json/);
    assert.equal(readFileSync(settings, "utf8"), "{ \"model\": \"opus\", }");
    assert.equal(readdirSync(home).length, 1, "no backup, no partial write");
  });

  test("deny-env backs up and merges, is idempotent, and allow-env restores the original (CTX-F2)", () => {
    const home = join(dir, "claude-home-env");
    mkdirSync(home, { recursive: true });
    const settings = join(home, "settings.json");
    const original = { model: "opus", permissions: { allow: ["Bash(npm test)"], deny: ["Read(./secrets/**)"] } };
    writeFileSync(settings, JSON.stringify(original, null, 2));

    const off = run(["status", "--settings", settings, "--skip-mcp"]);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /env reads\s+not denied/);

    const first = run(["deny-env", "--settings", settings]);
    assert.equal(first.status, 0, first.stderr);
    const denied = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(envReadsDenied(denied), true);
    assert.deepEqual(denied.permissions.allow, original.permissions.allow);
    assert.equal(denied.model, "opus");

    const backups = readdirSync(home).filter((f) => f.startsWith("settings.json.bak-code-intel-"));
    assert.equal(backups.length, 1, "one backup of the original");
    assert.deepEqual(JSON.parse(readFileSync(join(home, backups[0]!), "utf8")), original);

    const second = run(["deny-env", "--settings", settings]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readdirSync(home).filter((f) => f.includes(".bak-code-intel-")).length, 1,
      "an unchanged file is not rewritten or backed up again");

    const on = run(["status", "--settings", settings, "--skip-mcp"]);
    assert.match(on.stdout, /env reads\s+denied/);

    const allowed = run(["allow-env", "--settings", settings]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);
  });

  test("deny-env leaves a settings file that does not parse untouched and fails (CTX-F2)", () => {
    const home = join(dir, "claude-home-env-bad");
    mkdirSync(home, { recursive: true });
    const settings = join(home, "settings.json");
    writeFileSync(settings, "{ \"permissions\": { \"deny\": [] }, }");
    const r = run(["deny-env", "--settings", settings]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /settings\.json/);
    assert.equal(readFileSync(settings, "utf8"), "{ \"permissions\": { \"deny\": [] }, }");
    assert.equal(readdirSync(home).length, 1, "no backup, no partial write");
  });

  test("an unknown action prints usage and fails", () => {
    const r = run(["frobnicate"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /install\|uninstall\|status/);
  });
});
