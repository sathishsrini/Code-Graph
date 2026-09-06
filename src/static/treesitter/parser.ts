// ============================================================================
// tree-sitter grammars  —  task P1-T6  (requirement R19)
// ============================================================================
// SCIP answers "what is this symbol and where is it referenced". It does not
// model `throw`, string literals, template interpolation or property access
// patterns, so the four extractors R19 asks for need a syntax tree.
//
// **WASM, not the native binding.** `tree-sitter` compiles C at install time,
// which is precisely the dependency the stack chose `node:sqlite` to avoid
// (plan §5: "no native compilation — avoids better-sqlite3 build pain on
// Windows"). `web-tree-sitter` is the same parser as WebAssembly, and
// `tree-sitter-wasms` ships prebuilt grammars, so the whole toolchain stays
// `npm install` with no compiler on the machine. Recorded as delta D11.
//
// Grammars load lazily and stay loaded: a service is indexed one language at a
// time, and paying ~30ms per grammar per file would dominate the pass.
// ============================================================================

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { Node, Tree } from "web-tree-sitter";

export type GrammarName = "javascript" | "typescript" | "tsx" | "python";

const require = createRequire(import.meta.url);

/** Resolve the wasm directory through node resolution, not a relative guess. */
function wasmDir(): string {
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

/** File extension -> grammar. Unknown extensions return null and are skipped. */
export function grammarFor(path: string): GrammarName | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".jsx")) return "tsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  return null;
}

let initialised: Promise<void> | null = null;
const languages = new Map<GrammarName, Language>();

async function ensureInit(): Promise<void> {
  initialised ??= Parser.init();
  await initialised;
}

export async function loadGrammar(name: GrammarName): Promise<Language> {
  await ensureInit();
  const cached = languages.get(name);
  if (cached) return cached;
  const language = await Language.load(join(wasmDir(), `tree-sitter-${name}.wasm`));
  languages.set(name, language);
  return language;
}

export interface ParsedFile {
  path: string;
  grammar: GrammarName;
  tree: Tree;
  source: string;
  /** Split once and shared: several extractors need line text. */
  lines: string[];
}

/**
 * Parse one file.
 *
 * Returns null for an unsupported extension rather than throwing — a repo
 * containing a `.md` or a `.sql` is not an error, and a pass that aborts on
 * the first one indexes nothing.
 */
export async function parseFile(path: string, source: string): Promise<ParsedFile | null> {
  const grammar = grammarFor(path);
  if (!grammar) return null;
  const language = await loadGrammar(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return null;
  return { path, grammar, tree, source, lines: source.split(/\r?\n/) };
}

// ---------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------

/**
 * Depth-first walk over named nodes.
 *
 * `visit` returning false prunes that subtree. Used to stop descending into a
 * nested function when attributing something to its enclosing one.
 */
export function walk(root: Node, visit: (node: Node) => boolean | void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visit(node) === false) continue;
    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** 1-based line, matching `edges.line` and everything a human reads. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function colOf(node: Node): number {
  return node.startPosition.column;
}

/** Nearest ancestor of one of `types`, or null. */
export function ancestorOfType(node: Node, types: readonly string[]): Node | null {
  let current: Node | null = node.parent;
  while (current) {
    if (types.includes(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** The text of a string literal with its quotes removed. Template parts stay raw. */
export function literalText(node: Node): string {
  const raw = node.text;
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      return raw.slice(1, -1);
    }
    // Python prefixed strings: f"...", b'...', r"""..."""
    const m = /^[a-zA-Z]{0,3}("""|'''|"|')([\s\S]*)\1$/.exec(raw);
    if (m) return m[2]!;
  }
  return raw;
}
