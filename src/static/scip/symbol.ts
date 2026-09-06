// ============================================================================
// SCIP symbol grammar  —  task P0-T6
// ============================================================================
// Why this exists: docs/measurements.md M1 established that scip-typescript
// 0.4.0 emits displayName=0/407, enclosingSymbol=0/407 and syntaxKind=0 for
// every occurrence. The symbol string is therefore the ONLY source of a
// symbol's kind and name — and the only way to implement R16's type-position
// filter.
//
// Grammar (scip.proto):
//   <symbol>        ::= <scheme> ' ' <package> ' ' {<descriptor>}
//   <package>       ::= <manager> ' ' <name> ' ' <version>
//   <namespace>     ::= <name> '/'
//   <type>          ::= <name> '#'
//   <term>          ::= <name> '.'
//   <method>        ::= <name> '(' <disambiguator> ').'
//   <type-parameter>::= '[' <name> ']'
//   <parameter>     ::= '(' <name> ')'
//   <meta>          ::= <name> ':'
//   <local>         ::= 'local ' <id>
//
// Names containing punctuation are backtick-escaped; a literal backtick inside
// such a name is doubled.
// ============================================================================

export type DescriptorKind =
  | "namespace" | "type" | "term" | "method"
  | "typeParameter" | "parameter" | "meta" | "local" | "unknown";

export interface Descriptor {
  name: string;
  kind: DescriptorKind;
}

export interface ParsedSymbol {
  scheme: string;
  manager: string;
  packageName: string;
  version: string;
  descriptors: Descriptor[];
  /** True for `local 0` style symbols, which are function-scoped and unstable. */
  isLocal: boolean;
  raw: string;
}

/** Strip backtick escaping from a descriptor name. */
function unescapeName(name: string): string {
  if (name.startsWith("`") && name.endsWith("`") && name.length >= 2) {
    return name.slice(1, -1).replace(/``/g, "`");
  }
  return name;
}

/**
 * Read one name, honouring backtick escaping.
 * Returns the raw name text and the index just past it.
 */
function readName(s: string, start: number): { name: string; next: number } {
  if (s[start] !== "`") {
    // Unescaped: runs until a descriptor terminator.
    let i = start;
    while (i < s.length && !"/#.():[]".includes(s[i]!)) i += 1;
    return { name: s.slice(start, i), next: i };
  }

  // Backtick-escaped: a doubled backtick is a literal one.
  let i = start + 1;
  for (;;) {
    if (i >= s.length) return { name: s.slice(start), next: s.length };
    if (s[i] === "`") {
      if (s[i + 1] === "`") { i += 2; continue; }
      return { name: s.slice(start, i + 1), next: i + 1 };
    }
    i += 1;
  }
}

function parseDescriptors(s: string): Descriptor[] {
  const out: Descriptor[] = [];
  let i = 0;

  while (i < s.length) {
    // Bracketed forms come before a name.
    if (s[i] === "[") {
      const close = s.indexOf("]", i);
      if (close === -1) break;
      out.push({ name: unescapeName(s.slice(i + 1, close)), kind: "typeParameter" });
      i = close + 1;
      continue;
    }
    if (s[i] === "(") {
      const close = s.indexOf(")", i);
      if (close === -1) break;
      out.push({ name: unescapeName(s.slice(i + 1, close)), kind: "parameter" });
      i = close + 1;
      continue;
    }

    const { name, next } = readName(s, i);
    if (next === i) { i += 1; continue; } // no progress: skip a stray char

    const terminator = s[next];
    let kind: DescriptorKind = "unknown";
    let advance = next + 1;

    if (terminator === "/") {
      kind = "namespace";
    } else if (terminator === "#") {
      kind = "type";
    } else if (terminator === "(") {
      // method: name '(' disambiguator ').'
      const close = s.indexOf(")", next);
      if (close !== -1 && s[close + 1] === ".") {
        kind = "method";
        advance = close + 2;
      } else {
        kind = "unknown";
        advance = close === -1 ? s.length : close + 1;
      }
    } else if (terminator === ".") {
      kind = "term";
    } else if (terminator === ":") {
      kind = "meta";
    } else {
      kind = "unknown";
      advance = next;
      if (advance <= i) advance = i + 1;
    }

    if (name !== "" || kind !== "unknown") {
      out.push({ name: unescapeName(name), kind });
    }
    i = advance;
  }

  return out;
}

export function parseSymbol(symbol: string): ParsedSymbol {
  const empty: ParsedSymbol = {
    scheme: "", manager: "", packageName: "", version: "",
    descriptors: [], isLocal: false, raw: symbol,
  };

  if (symbol === "") return empty;

  if (symbol.startsWith("local ")) {
    return {
      ...empty,
      scheme: "local",
      isLocal: true,
      descriptors: [{ name: symbol.slice(6), kind: "local" }],
    };
  }

  // scheme, manager, package, version, then the descriptor run.
  const parts: string[] = [];
  let rest = symbol;
  for (let n = 0; n < 4; n += 1) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return { ...empty, scheme: symbol };
    parts.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }

  return {
    scheme: parts[0]!,
    manager: parts[1]!,
    packageName: parts[2]!,
    version: parts[3]!,
    descriptors: parseDescriptors(rest),
    isLocal: false,
    raw: symbol,
  };
}

/** The trailing descriptor — what the symbol actually *is*. */
export function lastDescriptor(symbol: string): Descriptor | undefined {
  const parsed = parseSymbol(symbol);
  return parsed.descriptors[parsed.descriptors.length - 1];
}

export function symbolKind(symbol: string): DescriptorKind {
  return lastDescriptor(symbol)?.kind ?? "unknown";
}

/**
 * Human-readable name. M1: displayName is 0/407, so it is derived here.
 * Falls back through the descriptor chain when the tail is anonymous.
 */
export function displayNameOf(symbol: string): string {
  const parsed = parseSymbol(symbol);
  for (let i = parsed.descriptors.length - 1; i >= 0; i -= 1) {
    const d = parsed.descriptors[i]!;
    if (d.name !== "") return d.name;
  }
  return symbol;
}

/**
 * Dotted path of the enclosing container, e.g. `lib/api.ts` for
 * `... lib/`api.ts`/request().`. Used for grouping and display.
 */
export function containerOf(symbol: string): string {
  const parsed = parseSymbol(symbol);
  return parsed.descriptors
    .slice(0, -1)
    .filter((d) => d.name !== "")
    .map((d) => d.name)
    .join("/");
}

// ---------------------------------------------------------------------------
// R16 filters — the replacement for the unavailable syntaxKind discriminator
// ---------------------------------------------------------------------------

/**
 * True when a reference to this symbol is a TYPE position, not a call.
 *
 * `Foo#` is a type; `Foo#bar().` is a method on it. Only the trailing
 * descriptor decides.
 */
export function isTypePosition(symbol: string): boolean {
  const kind = symbolKind(symbol);
  return kind === "type" || kind === "typeParameter";
}

/** Callable targets: methods, and terms (a const holding a function). */
export function isCallableTarget(symbol: string): boolean {
  const kind = symbolKind(symbol);
  return kind === "method" || kind === "term";
}

/** Modules/files and packages — containers, never call targets. */
export function isContainer(symbol: string): boolean {
  const kind = symbolKind(symbol);
  return kind === "namespace" || kind === "unknown";
}

/** Parameters and generic meta descriptors are never call targets. */
export function isParameterLike(symbol: string): boolean {
  const kind = symbolKind(symbol);
  return kind === "parameter" || kind === "meta";
}

/** Package identity, for telling a local definition from a dependency. */
export function packageOf(symbol: string): string {
  const p = parseSymbol(symbol);
  return p.packageName;
}
