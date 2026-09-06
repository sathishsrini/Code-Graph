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
import {
  ScipProtobufReader, summarize, roleNames, syntaxKindLabel,
  ROLE_DEFINITION, hasRole,
} from "./static/scip/reader.ts";
import { displayNameOf } from "./static/scip/symbol.ts";
import { deriveCalls, dedupe } from "./derive/calls.ts";

const DEFAULT_DB = ".codeintel/graph.db";
const DEFAULT_CONFIG = "config/repos.json";

const USAGE = `code-intel — architecture-aware code intelligence engine

USAGE
  node src/cli.ts <command> [options]

COMMANDS
  db bootstrap        Create or verify the SQLite fact store
  config check        Validate config/repos.json and print the resolved repos
  scip dump           Summarise a .scip index and sample its symbols
  derive calls        Derive CALLS edges from a .scip index (P0-T6)
  help                Show this message

OPTIONS
  --db <path>         Database path            (default: ${DEFAULT_DB})
  --config <path>     Config path              (default: ${DEFAULT_CONFIG})
  --index <path>      scip dump: path to a .scip file
  --sample <n>        scip dump: symbols to print   (default: 20)
  --reset             db bootstrap: delete an existing database first
  --skip-path-check   config check: don't verify rootPath exists on disk
  --json              Machine-readable output

STATUS
  Phase 0 in progress. See plans/code-intelligence-engine-plan-v2.md
`;

interface Options {
  db: string;
  config: string;
  index: string;
  sample: number;
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
        index: { type: "string" },
        sample: { type: "string" },
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
    index: values.index ?? "",
    sample: values.sample ? Number(values.sample) : 20,
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

    case "scip":
      if (sub !== "dump") {
        process.stderr.write(`unknown subcommand: scip ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdScipDump(options);

    case "derive":
      if (sub !== "calls") {
        process.stderr.write(`unknown subcommand: derive ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdDeriveCalls(options);

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

function cmdScipDump(options: Options): number {
  if (!options.index) {
    process.stderr.write("scip dump requires --index <path to .scip>\n");
    return 2;
  }

  const reader = new ScipProtobufReader();
  const index = reader.read(options.index);
  const summary = summarize(index);

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `index      : ${resolve(options.index)}\n` +
    `tool       : ${summary.tool}\n` +
    `projectRoot: ${summary.projectRoot}\n` +
    `documents  : ${summary.documents}\n` +
    `symbols    : ${summary.symbols}\n` +
    `occurrences: ${summary.occurrences} (${summary.definitions} definitions, ` +
    `${summary.references} references)\n` +
    `external   : ${summary.externalSymbols}\n\n` +
    `field coverage (what this indexer actually populates):\n` +
    `  enclosingRange   : ${summary.occurrencesWithEnclosingRange} occurrences ` +
    `(${summary.multiLineEnclosingRanges} span >1 line)\n` +
    `  enclosingSymbol  : ${summary.symbolsWithEnclosingSymbol} / ${summary.symbols} symbols\n` +
    `  displayName      : ${summary.symbolsWithDisplayName} / ${summary.symbols}\n` +
    `  documentation    : ${summary.symbolsWithDocumentation} / ${summary.symbols}\n` +
    `  relationships    : ${summary.symbolsWithRelationships} / ${summary.symbols}\n\n`,
  );

  process.stdout.write("languages:\n");
  for (const l of summary.languages) {
    process.stdout.write(`  ${String(l.n).padStart(5)}  ${l.language || "(none)"}\n`);
  }

  process.stdout.write("\nsymbol roles (occurrences may carry several):\n");
  for (const r of summary.roles) {
    process.stdout.write(`  ${String(r.n).padStart(5)}  ${r.role}\n`);
  }

  // The distribution that P0-T6's CALLS filters will be chosen from. Printed
  // because the SyntaxKind numbering has shifted between SCIP versions and
  // guessing it would silently drop real call edges.
  process.stdout.write("\nsyntax kinds:\n");
  for (const k of summary.syntaxKinds) {
    process.stdout.write(
      `  ${String(k.n).padStart(5)}  ${String(k.kind).padStart(3)}  ${k.label}\n`,
    );
  }

  // Eyeball sample — the P0-T4 acceptance criterion.
  process.stdout.write(`\nsample of ${options.sample} definitions:\n`);
  let shown = 0;
  outer: for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (!hasRole(occ.symbolRoles, ROLE_DEFINITION)) continue;
      const info = doc.symbols.find((s) => s.symbol === occ.symbol);
      const body = occ.enclosingRange
        ? `L${occ.enclosingRange.startLine + 1}-${occ.enclosingRange.endLine + 1}`
        : `L${occ.range.startLine + 1}`;
      process.stdout.write(
        `\n  ${doc.relativePath}:${body}  [${syntaxKindLabel(occ.syntaxKind)}]` +
        `  roles=${roleNames(occ.symbolRoles).join("|") || "none"}\n` +
        `    name  : ${info?.displayName || "(no displayName)"}\n` +
        `    symbol: ${occ.symbol}\n`,
      );
      shown += 1;
      if (shown >= options.sample) break outer;
    }
  }

  return 0;
}

function cmdDeriveCalls(options: Options): number {
  if (!options.index) {
    process.stderr.write("derive calls requires --index <path to .scip>\n");
    return 2;
  }

  const index = new ScipProtobufReader().read(options.index);
  const { calls, stats } = deriveCalls(index);
  const unique = dedupe(calls);

  if (options.json) {
    process.stdout.write(JSON.stringify({ stats, calls: unique }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `index      : ${resolve(options.index)}\n` +
    `documents  : ${stats.documents}\n` +
    `occurrences: ${stats.occurrences} (${stats.definitions} defs, ${stats.references} refs)\n` +
    `bodies     : ${stats.bodies}   (definitions with an enclosingRange)\n\n` +
    `CALLS emitted : ${stats.emitted}  (${unique.length} unique)\n` +
    `  certain     : ${stats.certain}\n` +
    `  inferred    : ${stats.inferred}\n` +
    `  module scope: ${stats.fromModuleScope}  (caller is a module, not a function)\n\n` +
    `skipped references:\n`,
  );
  const skippedRows = Object.entries(stats.skipped).sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of skippedRows) {
    process.stdout.write(`  ${String(n).padStart(5)}  ${reason}\n`);
  }
  const totalSkipped = skippedRows.reduce((s, [, n]) => s + n, 0);
  process.stdout.write(`  ${String(totalSkipped).padStart(5)}  TOTAL\n`);

  // Sample for the P0-T7 manual verification.
  const limit = options.sample;
  if (limit > 0) {
    process.stdout.write(`\nsample of ${Math.min(limit, unique.length)} CALLS edges:\n`);
    const step = Math.max(1, Math.floor(unique.length / limit));
    let shown = 0;
    for (let i = 0; i < unique.length && shown < limit; i += step) {
      const c = unique[i]!;
      process.stdout.write(
        `\n  ${c.filePath}:${c.line}  [${c.confidence}]` +
        `${c.fromModuleScope ? " (module scope)" : ""}\n` +
        `    ${displayNameOf(c.srcSymbol)}  ->  ${displayNameOf(c.dstSymbol)}\n` +
        `    src: ${c.srcSymbol}\n` +
        `    dst: ${c.dstSymbol}\n`,
      );
      shown += 1;
    }
  }

  return 0;
}

process.exitCode = main(process.argv.slice(2));
