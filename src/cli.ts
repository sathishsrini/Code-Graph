#!/usr/bin/env node
// ============================================================================
// code-intel CLI  —  task P0-T9 (skeleton; grows with each Phase 0 task)
// ============================================================================
// Node >= 22.6 executes this .ts file directly. No build step, no loader flag.
// ============================================================================

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig, ConfigError } from "./config/repos.ts";
import { FactStore } from "./store/db.ts";

const DEFAULT_DB = ".codeintel/graph.db";
const DEFAULT_CONFIG = "config/repos.json";

const USAGE = `code-intel — architecture-aware code intelligence engine

USAGE
  node src/cli.ts <command> [options]

COMMANDS
  db bootstrap        Create or verify the SQLite fact store
  config check        Validate config/repos.json and print the resolved repos
  help                Show this message

OPTIONS
  --db <path>         Database path            (default: ${DEFAULT_DB})
  --config <path>     Config path              (default: ${DEFAULT_CONFIG})
  --reset             db bootstrap: delete an existing database first
  --skip-path-check   config check: don't verify rootPath exists on disk
  --json              Machine-readable output

STATUS
  Phase 0 in progress. See plans/code-intelligence-engine-plan-v2.md
`;

interface Options {
  db: string;
  config: string;
  reset: boolean;
  checkPaths: boolean;
  json: boolean;
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        config: { type: "string" },
        reset: { type: "boolean", default: false },
        // node:util parseArgs has no "--no-x" negation, so this is stated
        // positively. The default remains "do check paths".
        "skip-path-check": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const options: Options = {
    db: values.db ?? DEFAULT_DB,
    config: values.config ?? DEFAULT_CONFIG,
    reset: values.reset === true,
    checkPaths: values["skip-path-check"] !== true,
    json: values.json === true,
  };

  const command = positionals[0] ?? "";
  const sub = positionals[1] ?? "";

  if (values.help || command === "" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "db":
      if (sub !== "bootstrap") {
        process.stderr.write(`unknown subcommand: db ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdDbBootstrap(options);

    case "config":
      if (sub !== "check") {
        process.stderr.write(`unknown subcommand: config ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdConfigCheck(options);

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function cmdDbBootstrap(options: Options): number {
  const store = options.reset ? FactStore.reset(options.db) : new FactStore(options.db);
  try {
    const report = store.verifyIntegrity();

    if (options.json) {
      process.stdout.write(JSON.stringify({ path: store.path, ...report }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `database   : ${store.path}\n` +
        `schema     : ${report.tables} tables/views, ${report.indexes} indexes\n` +
        `foreign key: ${report.foreignKeyViolations === 0 ? "valid" : `${report.foreignKeyViolations} VIOLATION(S)`}\n` +
        `integrity  : ${report.integrityCheck}\n`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

function cmdConfigCheck(options: Options): number {
  try {
    const config = loadConfig(options.config, { checkPaths: options.checkPaths });

    if (options.json) {
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(`config: ${resolve(options.config)}\n`);
    process.stdout.write(`repos : ${config.repos.length}\n\n`);
    for (const r of config.repos) {
      const inc = r.include.length ? r.include.join(", ") : "(everything)";
      const exc = r.exclude.length ? r.exclude.join(", ") : "(nothing)";
      process.stdout.write(
        `  ${r.name}\n` +
        `    lang/framework : ${r.lang} / ${r.framework}\n` +
        `    root           : ${r.rootPath}\n` +
        `    entrypoint     : ${r.entrypoint || "(none)"}\n` +
        `    include        : ${inc}\n` +
        `    exclude        : ${exc}\n` +
        `    port           : ${r.port ?? "(unset)"}\n\n`,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
