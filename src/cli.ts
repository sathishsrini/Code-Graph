#!/usr/bin/env node
// ============================================================================
// code-intel CLI  —  task P0-T9 (skeleton; grows with each Phase 0 task)
// ============================================================================
// Node >= 22.6 executes this .ts file directly. No build step, no loader flag.
// ============================================================================

import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  loadConfig, repoByName, ConfigError, type RepoConfig,
} from "./config/repos.ts";
import { FactStore } from "./store/db.ts";
import {
  ScipProtobufReader, summarize, roleNames, syntaxKindLabel,
  ROLE_DEFINITION, hasRole,
} from "./static/scip/reader.ts";
import { displayNameOf } from "./static/scip/symbol.ts";
import { deriveCalls, dedupe, createFsSourceProvider } from "./derive/calls.ts";
import { readBootDump, findRoute } from "./boot/dump.ts";
import { buildFlow, renderFlow } from "./query/flow.ts";
import { runScipTypescript, documentAllowed } from "./static/scip/runner.ts";

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
  scip index          Run scip-typescript over a repo's declared file set (P0-T3)
  boot dump           Boot a service and read its routes + hook chains (P0-T8)
  flow                Ordered chain + call tree for one endpoint (P0-T9)
  help                Show this message

OPTIONS
  --db <path>         Database path            (default: ${DEFAULT_DB})
  --config <path>     Config path              (default: ${DEFAULT_CONFIG})
  --index <path>      scip dump: path to a .scip file
  --repo <name>       boot dump / scip index / flow: repo from config/repos.json
  --method <verb>     flow: HTTP method
  --path <url>        flow: route url as the framework reports it
  --depth <n>         flow: call tree depth cap    (default: 12)
  --out <path>        boot dump: where to write the JSON artifact
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
  repo: string;
  method: string;
  path: string;
  depth: number;
  out: string;
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
        repo: { type: "string" },
        method: { type: "string" },
        path: { type: "string" },
        depth: { type: "string" },
        out: { type: "string" },
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
    repo: values.repo ?? "",
    method: values.method ?? "",
    path: values.path ?? "",
    depth: values.depth ? Number(values.depth) : 12,
    out: values.out ?? "",
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
      if (sub === "dump") return cmdScipDump(options);
      if (sub === "index") return cmdScipIndex(options);
      process.stderr.write(`unknown subcommand: scip ${sub}\n\n${USAGE}`);
      return 2;

    case "boot":
      if (sub !== "dump") {
        process.stderr.write(`unknown subcommand: boot ${sub}\n\n${USAGE}`);
        return 2;
      }
      return cmdBootDump(options);

    case "flow":
      return cmdFlow(options);

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

/**
 * Boot a service and read back its routes and ordered hook chains (P0-T8).
 *
 * The adapter runs as a CHILD PROCESS on purpose. It requires and boots a
 * foreign application: that app can throw, hang, open handles or call
 * process.exit, and none of that should be able to take the CLI with it.
 */
/**
 * Resolve one repo from config, or explain precisely why not.
 *
 * Shared by every repo-scoped command so the failure text is identical
 * wherever it comes from.
 */
function resolveRepo(options: Options): RepoConfig | number {
  if (!options.repo) {
    process.stderr.write("this command requires --repo <name from config/repos.json>\n");
    return 2;
  }
  let config;
  try {
    config = loadConfig(options.config, { checkPaths: options.checkPaths });
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const repo = repoByName(config, options.repo);
  if (!repo) {
    process.stderr.write(`no repo named "${options.repo}" in ${options.config}\n`);
    return 1;
  }
  return repo;
}

function defaultIndexPath(repo: RepoConfig): string {
  return join(".codeintel", "scip", `${repo.name}.scip`);
}

/**
 * Run the SCIP indexer over exactly the repo's declared file set (P0-T3).
 *
 * The generated tsconfig is the whole point: without it `40-kri-router` indexes
 * its dead `src/` scaffold and none of the live `server.js`, which yields a
 * confident graph of a system that does not run (docs/measurements.md M7).
 */
function cmdScipIndex(options: Options): number {
  const repo = resolveRepo(options);
  if (typeof repo === "number") return repo;
  if (repo.lang === "py") {
    process.stderr.write(`scip index: ${repo.name} is Python; scip-python is P1-T3.\n`);
    return 2;
  }

  const out = options.out || defaultIndexPath(repo);
  const result = runScipTypescript(repo, out, { maxOldSpaceMb: 8192 });

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  process.stdout.write(
    `repo       : ${repo.name}\n` +
    `root       : ${repo.rootPath}\n` +
    `include    : ${repo.include.join(", ") || "(everything)"}\n` +
    `exclude    : ${repo.exclude.join(", ") || "(nothing)"}\n` +
    `tsconfig   : generated, then removed\n` +
    `output     : ${result.outputPath}\n` +
    `duration   : ${result.durationMs} ms\n`,
  );
  if (!result.ok) {
    process.stderr.write(`\nscip index FAILED (status ${result.status})\n${result.stderr}\n`);
    return 1;
  }
  process.stdout.write(`status     : ok\n`);
  return 0;
}

/**
 * endpoint_flow for one route (P0-T9) — the Phase 0 exit criterion.
 *
 * Reads both channels: the boot dump for the ordered chain, the SCIP index for
 * the call tree beneath it. Neither alone answers the question.
 */
function cmdFlow(options: Options): number {
  const repo = resolveRepo(options);
  if (typeof repo === "number") return repo;
  if (!options.method || !options.path) {
    process.stderr.write("flow requires --method <verb> and --path <url>\n");
    return 2;
  }

  const bootPath = resolve(join(".codeintel", "boot", `${repo.name}.json`));
  const indexPath = resolve(options.index || defaultIndexPath(repo));
  for (const [what, p, how] of [
    ["boot dump", bootPath, `node src/cli.ts boot dump --repo ${repo.name}`],
    ["scip index", indexPath, `node src/cli.ts scip index --repo ${repo.name}`],
  ] as const) {
    if (!existsSync(p)) {
      process.stderr.write(`flow: no ${what} at ${p}\n  build it with: ${how}\n`);
      return 1;
    }
  }

  const dump = readBootDump(bootPath);
  const route = findRoute(dump, options.method, options.path);
  if (!route) {
    process.stderr.write(
      `flow: ${dump.service} has no route ${options.method.toUpperCase()} ${options.path}\n` +
      `  known routes:\n` +
      dump.routes.map((r) => `    ${r.method} ${r.url}`).join("\n") + "\n",
    );
    return 1;
  }

  const index = new ScipProtobufReader().read(indexPath);
  const { calls, unresolved, stats } = deriveCalls(index, {
    allowDocument: (rel) => documentAllowed(repo, rel),
  });
  const flow = buildFlow(dump, route, dedupe(calls), index, {
    maxDepth: options.depth,
    localPackages: new Set([repo.name, repo.serviceName]),
    unresolved,
    // Needed to bound anonymous hooks, which have no SCIP definition of their
    // own and would otherwise root their call tree at the whole module.
    sources: createFsSourceProvider(index.projectRoot || repo.rootPath),
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(flow, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderFlow(flow));
  if (stats.skippedDocuments.length > 0) {
    process.stdout.write(
      `  ${stats.skippedDocuments.length} document(s) in the index are outside ` +
      `the declared file set and were ignored:\n` +
      stats.skippedDocuments.map((d) => `    ${d}`).join("\n") + "\n",
    );
  }
  return 0;
}

function cmdBootDump(options: Options): number {
  if (!options.repo) {
    process.stderr.write("boot dump requires --repo <name from config/repos.json>\n");
    return 2;
  }

  let repo;
  try {
    repo = repoByName(loadConfig(options.config, { checkPaths: options.checkPaths }), options.repo);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  if (!repo) {
    process.stderr.write(`no repo named "${options.repo}" in ${options.config}\n`);
    return 1;
  }
  if (repo.framework !== "fastify") {
    // FastAPI is P1-T4. Say which adapter is missing rather than emitting an
    // empty dump that reads as "this service has no routes".
    process.stderr.write(
      `boot dump: no adapter for framework "${repo.framework}" (repo ${repo.name}). ` +
      `Fastify only in Phase 0.\n`,
    );
    return 2;
  }
  if (!repo.entrypoint) {
    process.stderr.write(`boot dump: repo ${repo.name} declares no entrypoint\n`);
    return 2;
  }

  const out = options.out || join(".codeintel", "boot", `${repo.name}.json`);
  const adapter = resolve(import.meta.dirname, "../adapters/fastify/boot-dump.cjs");
  const result = spawnSync(process.execPath, [
    adapter,
    "--entry", join(repo.rootPath, repo.entrypoint),
    "--cwd", repo.rootPath,
    "--service", repo.serviceName,
    "--out", resolve(out),
  ], { encoding: "utf8", timeout: 120_000 });

  if (result.error) {
    process.stderr.write(`boot dump: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "boot dump: adapter failed\n");
    return result.status ?? 1;
  }

  const dump = readBootDump(resolve(out));
  if (options.json) {
    process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `service    : ${dump.service}
` +
    `entrypoint : ${dump.entrypoint}
` +
    `fastify    : ${dump.tool.fastify}
` +
    `artifact   : ${resolve(out)}

` +
    `routes     : ${dump.stats.routes}
` +
    `chain rows : ${dump.stats.chainEntries}
` +
    `  anonymous: ${dump.stats.anonymousChainEntries} ` +
    `(located by file:line, not by name)
` +
    `  unlocated: ${dump.stats.unlocatedChainEntries}` +
    `${dump.stats.unlocatedChainEntries > 0 ? "   <-- GAP" : ""}
\n`,
  );

  for (const w of dump.warnings) process.stdout.write(`warning: ${w}\n`);
  if (dump.warnings.length) process.stdout.write("\n");

  for (const route of dump.routes) {
    process.stdout.write(`${route.method} ${route.url}\n`);
    for (const c of route.chain) {
      const label = c.name ?? "(anonymous)";
      const from = c.inheritedFrom ? `  inherited from ${c.inheritedFrom}` : "";
      const fw = c.origin === "framework" ? "  [fastify]" : "";
      process.stdout.write(
        `  ${String(c.position).padStart(2)}. ${c.phase.padEnd(11)}` +
        `${label.padEnd(24)}${c.key}${fw}${from}\n`,
      );
    }
    process.stdout.write("\n");
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
