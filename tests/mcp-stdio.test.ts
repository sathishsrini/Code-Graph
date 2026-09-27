// The MCP server as Claude Code actually launches it — slice CTX-S1 (goal G1).
//
// `tests/mcp.test.ts` calls the tools in-process. That never exercises what
// `claude mcp add --scope user code-intel -- node <abs>/src/cli.ts mcp --db
// <abs>` sets up: a child process started from the *target repo's* folder,
// speaking JSON-RPC on stdout. Anything else written to stdout (a banner, a
// warning, a stray console.log) breaks the handshake, and a relative path
// resolved against the wrong cwd opens the wrong database. Both failures are
// invisible to an in-process test, so this one starts the real command from a
// folder that is not this repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FactStore } from "../src/store/db.ts";
import { mcpAddArgs } from "../src/integrations/claude-settings.ts";

test("the registered MCP command starts from another folder and answers over stdio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeintel-mcp-stdio-"));
  const db = join(dir, "graph.db");
  new FactStore(db).close();

  // The exact argv the installer registers, after `--`.
  const argv = mcpAddArgs(resolve("."), db);
  const command = argv.slice(argv.indexOf("--") + 1);
  assert.equal(command[0], "node");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: command.slice(1),
    cwd: dir, // not this repo: Claude starts the server from the target repo
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-stdio-test", version: "1" });
  try {
    await client.connect(transport, { timeout: 60_000 });

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["context_pack", "endpoint_flow", "error_trace", "impact", "security_path"],
    );

    // An empty graph is an answer, not a transport failure.
    const r = await client.callTool(
      { name: "endpoint_flow", arguments: { service: "svc", method: "GET", path: "/x" } },
      undefined, { timeout: 60_000 },
    );
    assert.notEqual(r.isError, true);
    const content = r.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.type, "text");
    assert.match(content[0]?.text ?? "", /error:/);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
