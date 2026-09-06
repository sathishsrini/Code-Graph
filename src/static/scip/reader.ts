// ============================================================================
// SCIP index reader  —  task P0-T4  (requirement R14)
// ============================================================================
// Maps the SCIP protobuf schema onto the schema-agnostic wire decoder.
//
// R14: everything downstream depends on the ScipIndexReader INTERFACE, never on
// this implementation. scip-typescript and scip-python are small projects; if
// one stalls, an LSP callHierarchy reader can be dropped in behind the same
// interface (slower, comparable accuracy) without touching the derivation or
// query layers.
//
// Schema: https://github.com/sourcegraph/scip/blob/main/scip.proto
// ============================================================================

import { readFileSync } from "node:fs";
import {
  decodeMessage, getString, getStrings, getUint, getBool,
  getMessage, getMessages, getPackedInts,
  type Fields,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// SymbolRole is a BITMASK — an occurrence can carry several roles at once.
// ---------------------------------------------------------------------------
export const ROLE_DEFINITION = 0x1;
export const ROLE_IMPORT = 0x2;
export const ROLE_WRITE_ACCESS = 0x4;
export const ROLE_READ_ACCESS = 0x8;
export const ROLE_GENERATED = 0x10;
export const ROLE_TEST = 0x20;
export const ROLE_FORWARD_DEFINITION = 0x40;

export function hasRole(symbolRoles: number, role: number): boolean {
  return (symbolRoles & role) !== 0;
}

export function roleNames(symbolRoles: number): string[] {
  const out: string[] = [];
  if (hasRole(symbolRoles, ROLE_DEFINITION)) out.push("Definition");
  if (hasRole(symbolRoles, ROLE_IMPORT)) out.push("Import");
  if (hasRole(symbolRoles, ROLE_WRITE_ACCESS)) out.push("WriteAccess");
  if (hasRole(symbolRoles, ROLE_READ_ACCESS)) out.push("ReadAccess");
  if (hasRole(symbolRoles, ROLE_GENERATED)) out.push("Generated");
  if (hasRole(symbolRoles, ROLE_TEST)) out.push("Test");
  if (hasRole(symbolRoles, ROLE_FORWARD_DEFINITION)) out.push("ForwardDefinition");
  return out;
}

/**
 * SyntaxKind labels, best effort.
 *
 * Deliberately NOT used for filtering yet. The numbering is taken from
 * scip.proto but has shifted between versions, and mis-filtering would silently
 * drop real call edges. P0-T4 dumps the observed distribution; P0-T6 chooses
 * filters from that evidence. The raw number is always preserved.
 */
export const SYNTAX_KIND_LABELS: Record<number, string> = {
  0: "UnspecifiedSyntaxKind", 1: "Comment", 2: "PunctuationDelimiter",
  3: "PunctuationBracket", 4: "Keyword", 6: "IdentifierOperator",
  7: "Identifier", 8: "IdentifierBuiltin", 9: "IdentifierNull",
  10: "IdentifierConstant", 11: "IdentifierMutableGlobal",
  12: "IdentifierParameter", 13: "IdentifierLocal", 14: "IdentifierShadowed",
  15: "IdentifierNamespace", 16: "IdentifierFunction",
  17: "IdentifierFunctionDefinition", 18: "IdentifierMacro",
  19: "IdentifierMacroDefinition", 20: "IdentifierType",
  21: "IdentifierBuiltinType", 22: "IdentifierAttribute",
  28: "StringLiteral", 33: "NumericLiteral", 34: "BooleanLiteral",
};

export function syntaxKindLabel(kind: number): string {
  return SYNTAX_KIND_LABELS[kind] ?? `SyntaxKind(${kind})`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Zero-based, end-exclusive. SCIP encodes single-line ranges in 3 ints. */
export interface ScipRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  displayName: string;
  kind: number;
  documentation: string[];
  enclosingSymbol: string;
  relationships: ScipRelationship[];
}

export interface ScipOccurrence {
  symbol: string;
  range: ScipRange;
  symbolRoles: number;
  syntaxKind: number;
  /** Present on definition occurrences: the full body span, not just the name. */
  enclosingRange: ScipRange | null;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipIndex {
  projectRoot: string;
  toolName: string;
  toolVersion: string;
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInformation[];
}

/**
 * R14 — the swap point. Downstream code depends on this, never on the SCIP
 * implementation below.
 */
export interface ScipIndexReader {
  readonly name: string;
  read(path: string): ScipIndex;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeRange(ints: number[]): ScipRange {
  // 3 ints  → [startLine, startChar, endChar]           (single line)
  // 4 ints  → [startLine, startChar, endLine, endChar]
  if (ints.length === 3) {
    return {
      startLine: ints[0]!, startChar: ints[1]!,
      endLine: ints[0]!, endChar: ints[2]!,
    };
  }
  if (ints.length >= 4) {
    return {
      startLine: ints[0]!, startChar: ints[1]!,
      endLine: ints[2]!, endChar: ints[3]!,
    };
  }
  return { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };
}

function decodeRelationship(f: Fields): ScipRelationship {
  return {
    symbol: getString(f, 1),
    isReference: getBool(f, 2),
    isImplementation: getBool(f, 3),
    isTypeDefinition: getBool(f, 4),
    isDefinition: getBool(f, 5),
  };
}

function decodeSymbolInformation(f: Fields): ScipSymbolInformation {
  return {
    symbol: getString(f, 1),
    documentation: getStrings(f, 3),
    relationships: getMessages(f, 4).map(decodeRelationship),
    kind: getUint(f, 5),
    displayName: getString(f, 6),
    enclosingSymbol: getString(f, 8),
  };
}

function decodeOccurrence(f: Fields): ScipOccurrence {
  const enclosing = getPackedInts(f, 7);
  return {
    range: decodeRange(getPackedInts(f, 1)),
    symbol: getString(f, 2),
    symbolRoles: getUint(f, 3),
    syntaxKind: getUint(f, 5),
    enclosingRange: enclosing.length >= 3 ? decodeRange(enclosing) : null,
  };
}

function decodeDocument(f: Fields): ScipDocument {
  return {
    relativePath: getString(f, 1).replace(/\\/g, "/"),
    occurrences: getMessages(f, 2).map(decodeOccurrence),
    symbols: getMessages(f, 3).map(decodeSymbolInformation),
    language: getString(f, 4),
  };
}

export class ScipProtobufReader implements ScipIndexReader {
  readonly name = "scip-protobuf";

  read(path: string): ScipIndex {
    const buf = readFileSync(path);
    return this.parse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }

  parse(bytes: Uint8Array): ScipIndex {
    const index = decodeMessage(bytes);

    const metadata = getMessage(index, 1);
    const toolInfo = metadata ? getMessage(metadata, 2) : undefined;

    return {
      projectRoot: metadata ? getString(metadata, 3) : "",
      toolName: toolInfo ? getString(toolInfo, 1) : "",
      toolVersion: toolInfo ? getString(toolInfo, 2) : "",
      documents: getMessages(index, 2).map(decodeDocument),
      externalSymbols: getMessages(index, 3).map(decodeSymbolInformation),
    };
  }
}

// ---------------------------------------------------------------------------
// Summary — feeds the `scip dump` CLI command (P0-T4 acceptance)
// ---------------------------------------------------------------------------

export interface ScipSummary {
  projectRoot: string;
  tool: string;
  documents: number;
  symbols: number;
  occurrences: number;
  definitions: number;
  references: number;
  externalSymbols: number;
  occurrencesWithEnclosingRange: number;
  symbolsWithEnclosingSymbol: number;
  symbolsWithDisplayName: number;
  symbolsWithDocumentation: number;
  symbolsWithRelationships: number;
  /** Definition occurrences whose enclosingRange spans more than one line. */
  multiLineEnclosingRanges: number;
  syntaxKinds: Array<{ kind: number; label: string; n: number }>;
  roles: Array<{ role: string; n: number }>;
  languages: Array<{ language: string; n: number }>;
}

export function summarize(index: ScipIndex): ScipSummary {
  let symbols = 0;
  let occurrences = 0;
  let definitions = 0;
  let withEnclosing = 0;
  let multiLineEnclosing = 0;
  let withEnclosingSymbol = 0;
  let withDisplayName = 0;
  let withDocumentation = 0;
  let withRelationships = 0;
  const syntaxKinds = new Map<number, number>();
  const roles = new Map<string, number>();
  const languages = new Map<string, number>();

  for (const doc of index.documents) {
    symbols += doc.symbols.length;
    languages.set(doc.language, (languages.get(doc.language) ?? 0) + 1);

    for (const info of doc.symbols) {
      if (info.enclosingSymbol !== "") withEnclosingSymbol += 1;
      if (info.displayName !== "") withDisplayName += 1;
      if (info.documentation.length > 0) withDocumentation += 1;
      if (info.relationships.length > 0) withRelationships += 1;
    }

    for (const occ of doc.occurrences) {
      occurrences += 1;
      if (hasRole(occ.symbolRoles, ROLE_DEFINITION)) definitions += 1;
      if (occ.enclosingRange) {
        withEnclosing += 1;
        if (occ.enclosingRange.endLine > occ.enclosingRange.startLine) {
          multiLineEnclosing += 1;
        }
      }
      syntaxKinds.set(occ.syntaxKind, (syntaxKinds.get(occ.syntaxKind) ?? 0) + 1);
      for (const r of roleNames(occ.symbolRoles)) {
        roles.set(r, (roles.get(r) ?? 0) + 1);
      }
    }
  }

  return {
    projectRoot: index.projectRoot,
    tool: `${index.toolName}@${index.toolVersion}`,
    documents: index.documents.length,
    symbols,
    occurrences,
    definitions,
    references: occurrences - definitions,
    externalSymbols: index.externalSymbols.length,
    occurrencesWithEnclosingRange: withEnclosing,
    symbolsWithEnclosingSymbol: withEnclosingSymbol,
    symbolsWithDisplayName: withDisplayName,
    symbolsWithDocumentation: withDocumentation,
    symbolsWithRelationships: withRelationships,
    multiLineEnclosingRanges: multiLineEnclosing,
    syntaxKinds: [...syntaxKinds.entries()]
      .map(([kind, n]) => ({ kind, label: syntaxKindLabel(kind), n }))
      .sort((a, b) => b.n - a.n),
    roles: [...roles.entries()]
      .map(([role, n]) => ({ role, n }))
      .sort((a, b) => b.n - a.n),
    languages: [...languages.entries()]
      .map(([language, n]) => ({ language, n }))
      .sort((a, b) => b.n - a.n),
  };
}
