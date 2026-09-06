// ============================================================================
// CALLS derivation  —  task P0-T6  (requirements R15, R16, R17)
// ============================================================================
// SCIP emits OCCURRENCES, not call edges. An occurrence says "symbol X is
// referenced at file F, line L". To get "A CALLS B" you find the definition
// whose body encloses L — that is A — and the referenced symbol is B.
//
// Two things make this non-trivial, both established empirically in
// docs/measurements.md rather than assumed from scip.proto:
//
//   M1: syntaxKind is 0 for every occurrence, so the plan's intended
//       type-position filter (R16) is impossible as specified. Filtering runs
//       off the SCIP symbol grammar instead — see ../static/scip/symbol.ts.
//
//   M2: enclosingRange is populated on precisely the definitions that have
//       bodies. That is the interval tree's input, not enclosingSymbol (which
//       this indexer leaves empty).
//
// This derivation OVER-APPROXIMATES by design, which is why P0-T7 measures the
// false-positive rate on a manual sample of 50 before anything is built on it.
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScipIndex, ScipRange } from "../static/scip/reader.ts";
import { ROLE_DEFINITION, ROLE_IMPORT, hasRole } from "../static/scip/reader.ts";
import {
  isTypePosition, isContainer, packageOf, parseSymbol,
} from "../static/scip/symbol.ts";

// ---------------------------------------------------------------------------
// Call-site detection
// ---------------------------------------------------------------------------
// The descriptor filters alone measured an ~83% false-positive rate on
// 60-kri-next: JSX elements (<div>), JSX attributes (value, htmlFor), property
// reads (process.env) and type members all look exactly like calls in the
// occurrence stream.
//
// The decisive signal is not in the index at all — it is whether the
// identifier is FOLLOWED BY a call. The source is on disk, so read it.

export interface SourceProvider {
  text(relativePath: string): string | null;
}

/** Reads sources from disk, resolving the index's file:// projectRoot. */
export function createFsSourceProvider(projectRoot: string): SourceProvider {
  let root = projectRoot;
  if (root.startsWith("file://")) {
    try { root = fileURLToPath(root); } catch { /* keep the raw value */ }
  }

  const cache = new Map<string, string | null>();
  return {
    text(relativePath: string): string | null {
      const hit = cache.get(relativePath);
      if (hit !== undefined) return hit;

      const full = join(root, relativePath);
      let value: string | null = null;
      if (existsSync(full)) {
        try { value = readFileSync(full, "utf8"); } catch { value = null; }
      }
      cache.set(relativePath, value);
      return value;
    },
  };
}

/**
 * Is the identifier ending at `range` immediately followed by a call?
 *
 * Accepts `foo(`, `foo (`, `foo<T>(` and a call broken across lines. Rejects
 * `<div>`, `value=`, `process.env`, `obj.prop,` and every other non-call use.
 *
 * Returns null when the source is unavailable, so the caller can decide
 * whether to fall back rather than silently dropping edges.
 */
export function isCallSite(lines: string[], range: ScipRange): boolean | null {
  const startLine = range.endLine;
  if (startLine < 0 || startLine >= lines.length) return null;

  let line = startLine;
  let col = range.endChar;
  let depthAngle = 0;
  // A call may be split over a couple of lines; more than that is not a call.
  const lastLine = Math.min(lines.length - 1, startLine + 2);

  while (line <= lastLine) {
    const text = lines[line] ?? "";
    while (col < text.length) {
      const ch = text[col]!;

      if (ch === " " || ch === "\t" || ch === "\r") { col += 1; continue; }

      // Generic call: foo<Bar>(...). Track nesting so foo<A<B>>() works.
      if (depthAngle > 0) {
        if (ch === "<") depthAngle += 1;
        else if (ch === ">") depthAngle -= 1;
        // A statement terminator inside the guess means it was a comparison.
        else if (ch === ";" || ch === "{" || ch === "}") return false;
        col += 1;
        continue;
      }

      if (ch === "(") return true;
      if (ch === "<") { depthAngle = 1; col += 1; continue; }

      // Anything else ends the identifier without a call.
      return false;
    }
    line += 1;
    col = 0;
  }
  return false;
}

export type CallConfidence = "certain" | "inferred";

export interface DerivedCall {
  /** Enclosing definition — the caller. */
  srcSymbol: string;
  /** Referenced symbol — the callee. */
  dstSymbol: string;
  filePath: string;
  /** 1-based, for humans and for `edges.line`. */
  line: number;
  /**
   * 0-based column of the call site.
   *
   * Needed to tell a call made INSIDE an inline function from the call that
   * registers it: `fastify.addHook('onRequest', async () => {` puts both on
   * one line, and by line alone the hook appears to call `addHook` itself.
   */
  col: number;
  confidence: CallConfidence;
  /** True when the caller is a module rather than a function. */
  fromModuleScope: boolean;
}

/**
 * A call site whose target could not be named (R11).
 *
 * Stored, never dropped. A tool that hides what it could not analyse converts
 * an unknown into a false negative, which is strictly worse: the reader has no
 * way to tell "nothing here" from "we could not look".
 */
export interface UnresolvedCall {
  /** Enclosing definition — the caller, which IS known. */
  srcSymbol: string;
  filePath: string;
  line: number;
  col: number;
  /** Whatever SCIP did resolve — usually a package or module symbol. */
  target: string;
  reason: string;
}

export interface DeriveStats {
  documents: number;
  occurrences: number;
  definitions: number;
  references: number;
  bodies: number;
  emitted: number;
  certain: number;
  inferred: number;
  fromModuleScope: number;
  skipped: Record<string, number>;
  /** Documents excluded by `allowDocument` -- listed, not silently dropped. */
  skippedDocuments: string[];
}

export interface DeriveResult {
  calls: DerivedCall[];
  /** Call sites whose target could not be named. A feature, not a leak (R11). */
  unresolved: UnresolvedCall[];
  stats: DeriveStats;
}

/**
 * Is this symbol a package root or a file module, rather than a nested
 * namespace? Both forms end in `/`; only the shallow ones mean "we resolved
 * the container but not the member".
 */
function isModuleLike(symbol: string): boolean {
  const { descriptors } = parseSymbol(symbol);
  if (descriptors.length === 0) return true;
  return descriptors.every((d) => d.kind === "namespace");
}

interface Body {
  symbol: string;
  range: ScipRange;
  isModule: boolean;
}

/** Is position (line, char) inside `r`? Start-inclusive, end-exclusive. */
function contains(r: ScipRange, line: number, char: number): boolean {
  if (line < r.startLine || line > r.endLine) return false;
  if (line === r.startLine && char < r.startChar) return false;
  if (line === r.endLine && char > r.endChar) return false;
  return true;
}

/**
 * Innermost enclosing body.
 *
 * Ranges nest properly, so the innermost is the one with the LATEST start.
 * Ties (a body starting at the same position as its parent, which happens for
 * a single-declaration module) break toward the earlier end — the tighter span.
 */
function innermost(bodies: Body[], line: number, char: number): Body | undefined {
  let best: Body | undefined;
  for (const b of bodies) {
    if (!contains(b.range, line, char)) continue;
    if (best === undefined) { best = b; continue; }

    const later =
      b.range.startLine > best.range.startLine ||
      (b.range.startLine === best.range.startLine && b.range.startChar > best.range.startChar);
    if (later) { best = b; continue; }

    const sameStart =
      b.range.startLine === best.range.startLine &&
      b.range.startChar === best.range.startChar;
    const tighter =
      b.range.endLine < best.range.endLine ||
      (b.range.endLine === best.range.endLine && b.range.endChar < best.range.endChar);
    if (sameStart && tighter) best = b;
  }
  return best;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Derive CALLS edges from a SCIP index.
 *
 * @param localPackages packages considered "ours". A target resolving inside
 *   one is `certain` (the compiler resolved it to a definition we indexed);
 *   anything else is `inferred` (R17).
 */
export interface DeriveOptions {
  /** Packages considered "ours" for the certain/inferred split (R17). */
  localPackages?: Set<string>;
  /**
   * Source text, used for the call-site check. Defaults to reading from the
   * index's projectRoot. Pass `null` to disable the check entirely — which
   * raises the false-positive rate to ~83%, so only do that deliberately.
   */
  sources?: SourceProvider | null;
  /**
   * Second gate on which documents count, checked against the repo's declared
   * include/exclude (R13, OPEN-1).
   *
   * The indexer is pointed at a generated tsconfig covering exactly this set,
   * so in the normal case this changes nothing. It is here because the failure
   * it guards is silent: `40-kri-router/tsconfig.json` is `{}`, and an indexer
   * run without the generated config yields 52 confident edges describing
   * `src/**` -- a scaffold that never executes -- and none from the live
   * `server.js`. Documents rejected here are counted in
   * `stats.skippedDocuments`, never dropped quietly.
   */
  allowDocument?: (relativePath: string) => boolean;
}

export function deriveCalls(index: ScipIndex, options: DeriveOptions = {}): DeriveResult {
  const skipped: Record<string, number> = {};
  const unresolved: UnresolvedCall[] = [];
  const sources = options.sources === undefined
    ? createFsSourceProvider(index.projectRoot)
    : options.sources;

  // relativePath -> split lines, built lazily and cached.
  const lineCache = new Map<string, string[] | null>();
  function linesFor(relativePath: string): string[] | null {
    const hit = lineCache.get(relativePath);
    if (hit !== undefined) return hit;
    const text = sources ? sources.text(relativePath) : null;
    const value = text === null ? null : text.split(/\r?\n/);
    lineCache.set(relativePath, value);
    return value;
  }

  // Every symbol defined anywhere in this index. Used for the certain/inferred
  // split and to drop references to things we never saw defined.
  const definedHere = new Set<string>();
  const allow = options.allowDocument ?? (() => true);
  const documents = index.documents.filter((d) => allow(d.relativePath));
  const skippedDocuments = index.documents
    .filter((d) => !allow(d.relativePath))
    .map((d) => d.relativePath);

  for (const doc of documents) {
    for (const occ of doc.occurrences) {
      if (hasRole(occ.symbolRoles, ROLE_DEFINITION)) definedHere.add(occ.symbol);
    }
  }

  const packages = options.localPackages ?? new Set(
    [...definedHere].map(packageOf).filter((p) => p !== ""),
  );

  const calls: DerivedCall[] = [];
  let occurrences = 0;
  let definitions = 0;
  let bodyCount = 0;

  for (const doc of documents) {
    // M2: bodies are the definition occurrences carrying an enclosingRange.
    const bodies: Body[] = [];
    for (const occ of doc.occurrences) {
      if (!hasRole(occ.symbolRoles, ROLE_DEFINITION) || !occ.enclosingRange) continue;
      bodies.push({
        symbol: occ.symbol,
        range: occ.enclosingRange,
        isModule: parseSymbol(occ.symbol).descriptors.every((d) => d.kind === "namespace"),
      });
    }
    bodyCount += bodies.length;

    for (const occ of doc.occurrences) {
      occurrences += 1;

      if (hasRole(occ.symbolRoles, ROLE_DEFINITION)) {
        definitions += 1;
        continue;
      }

      // ---- R16 filters, in cheapest-first order ------------------------
      if (hasRole(occ.symbolRoles, ROLE_IMPORT)) {
        bump(skipped, "import"); continue;
      }
      if (occ.symbol === "" || occ.symbol.startsWith("local ")) {
        // Function-scoped locals have no stable identity across reindexing.
        bump(skipped, "local"); continue;
      }
      if (isTypePosition(occ.symbol)) {
        bump(skipped, "typePosition"); continue;
      }
      // NOTE: `meta` (name:) and `parameter` ((name)) descriptors are NOT
      // filtered here, though an earlier revision did so. scip-typescript emits
      // object-literal properties as meta — `api.get(...)` resolves to
      // `lib/`api.ts`/get0:` — so excluding meta silently dropped all 11
      // frontend->backend call sites, the most valuable edges in the corpus.
      // Function-valued parameters (callbacks) are real calls for the same
      // reason. The call-site check below is a much stronger discriminator and
      // makes a descriptor-kind proxy unnecessary.
      // The decisive filter: is this identifier actually followed by a call?
      // Without it the false-positive rate measured ~83% — JSX elements and
      // attributes, property reads and type members are indistinguishable from
      // calls in the occurrence stream alone.
      const lines = linesFor(doc.relativePath);
      if (lines !== null) {
        const called = isCallSite(lines, occ.range);
        if (called === false) { bump(skipped, "notACallSite"); continue; }
        if (called === null) bump(skipped, "callSiteUndetermined");
      } else {
        bump(skipped, "sourceUnavailable");
      }

      const caller = innermost(bodies, occ.range.startLine, occ.range.startChar);
      if (!caller) {
        bump(skipped, "noEnclosingBody"); continue;
      }
      if (caller.symbol === occ.symbol) {
        // The definition's own name occurrence, already excluded above; this
        // catches any residual self-reference at the same position.
        bump(skipped, "self"); continue;
      }

      // A namespace descriptor reached here means the source says `x(...)` but
      // SCIP could only resolve `x` to a whole package. In untyped CommonJS
      // that is the normal outcome for `const axios = require('axios')`, and
      // `axios(config)` is the outbound HTTP call — the single most valuable
      // edge in a router service.
      //
      // This check sits AFTER the call-site test on purpose. Running it before
      // (as the first revision did) drops the occurrence without ever asking
      // whether it was a call, so the edge disappears into a `container` tally
      // and the tree shows `forward` calling nothing at all.
      if (isContainer(occ.symbol)) {
        const parsed = parseSymbol(occ.symbol);
        if (parsed.descriptors.length === 0 || isModuleLike(occ.symbol)) {
          unresolved.push({
            srcSymbol: caller.symbol,
            filePath: doc.relativePath,
            line: occ.range.startLine + 1,
            col: occ.range.startChar,
            target: occ.symbol,
            reason: "callee resolved to a package or module, not to a function",
          });
          bump(skipped, "unresolvedTarget");
          continue;
        }
        bump(skipped, "container"); continue;
      }

      const confidence: CallConfidence =
        definedHere.has(occ.symbol) ? "certain"
        : packages.has(packageOf(occ.symbol)) ? "certain"
        : "inferred";

      calls.push({
        srcSymbol: caller.symbol,
        dstSymbol: occ.symbol,
        filePath: doc.relativePath,
        line: occ.range.startLine + 1,
        col: occ.range.startChar,
        confidence,
        fromModuleScope: caller.isModule,
      });
    }
  }

  return {
    calls,
    unresolved,
    stats: {
      documents: documents.length,
      skippedDocuments,
      occurrences,
      definitions,
      references: occurrences - definitions,
      bodies: bodyCount,
      emitted: calls.length,
      certain: calls.filter((c) => c.confidence === "certain").length,
      inferred: calls.filter((c) => c.confidence === "inferred").length,
      fromModuleScope: calls.filter((c) => c.fromModuleScope).length,
      skipped,
    },
  };
}

/** Collapse duplicate (src, dst, file, line) rows. */
export function dedupe(calls: DerivedCall[]): DerivedCall[] {
  const seen = new Set<string>();
  const out: DerivedCall[] = [];
  for (const c of calls) {
    const key = `${c.srcSymbol} ${c.dstSymbol} ${c.filePath} ${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
