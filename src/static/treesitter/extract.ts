// ============================================================================
// tree-sitter extractors  —  task P1-T6  (requirement R19)
// ============================================================================
// Four extractors, one walk:
//
//   THROWS         `throw new X()` / `raise X()`      -> edges THROWS
//   outbound HTTP  axios / fetch / httpx / requests   -> P1-T7's input
//   datastore      SQL literals                       -> edges READS / WRITES
//   config reads   process.env.X / os.getenv("X")     -> edges READS_CONFIG
//
// Every one of these is `inferred`, never `certain`, and the reasons differ
// per extractor rather than being a blanket disclaimer:
//
//   THROWS is *declared locally* and is never complete (doc §Q.2). TypeScript
//   has no checked exceptions, the transitive union explodes within two or
//   three levels, it ignores `catch`, and it misses everything a library
//   throws. On this corpus it is nearly empty — the live code throws nothing
//   and returns error envelopes instead. That is what P1-T17 exists for.
//
//   A SQL literal is what the source says, not what the database runs. A
//   query assembled from fragments, or issued by an ORM, is invisible here.
//
//   `process.env.X` proves the code *reads* X. It does not prove X is set,
//   and the value is never read, stored or hashed (R23) — a hashed secret is
//   still a secret with a confirmation oracle attached.
//
// The URL work is the part that earns its keep. On the corpus the outbound
// URL is one function-call indirection from the single `axios()` site, its
// path is a `req.url` pass-through, and its destination forks on whether
// `PROCUREMENT_BASE_URL` is set. So URL *expressions* are collected
// independently of call sites, and a ternary yields two candidates rather
// than one silently-chosen winner (OPEN-4).
// ============================================================================

import type { Node } from "web-tree-sitter";
import {
  ancestorOfType, colOf, lineOf, literalText, walk, type ParsedFile,
} from "./parser.ts";

// ---------------------------------------------------------------------------
// Finding shapes
// ---------------------------------------------------------------------------

export interface Located {
  line: number;
  col: number;
  endLine: number;
}

export interface ThrowFinding extends Located {
  /** Constructor name (`Error`, `ValidationError`), or null for `throw e`. */
  errorName: string | null;
  /** Verbatim source of the throw, trimmed. Never evaluated. */
  text: string;
}

export interface ConfigFinding extends Located {
  varName: string;
  /** `process.env` | `os.getenv` | `os.environ` — which idiom found it. */
  accessor: string;
}

export interface DatastoreFinding extends Located {
  engine: string;
  table: string;
  operation: "read" | "write";
  /** SELECT | INSERT | UPDATE | DELETE — the verb the table was found under. */
  verb: string;
  /** The literal, collapsed to one line. Truncated: this is a label, not a payload. */
  sql: string;
}

/**
 * A URL built in source, decomposed far enough for P1-T7 to match it against
 * a remote route template.
 */
export interface UrlExpr extends Located {
  raw: string;
  /**
   * Identifier of the leading interpolation — `ENGINE_BASE_URL` in
   * `` `${ENGINE_BASE_URL}${req.url}` ``. Null when the URL starts with a
   * literal (an absolute `http://…` or a bare path).
   */
  baseVar: string | null;
  /** Literal prefix following the base, up to the first dynamic segment. */
  literalPath: string;
  /** True when any segment is an expression. `req.url` makes the whole path unknown. */
  dynamic: boolean;
}

export interface HttpFinding extends Located {
  /** `axios` | `fetch` | `httpx` | `requests` | `got` | `request`. */
  client: string;
  /** Static method when the source states one, else null. */
  method: string | null;
  /** URL expressions found in the call's own arguments. Often empty — see below. */
  urls: UrlExpr[];
  /**
   * The call's sole identifier argument, when it takes one: `axios(axiosConfig)`.
   * The URL is then built elsewhere, and the linker must look for it there.
   */
  configVar: string | null;
}

/**
 * `const ENGINE_BASE_URL = process.env.ENGINE_BASE_URL || 'http://localhost:3002'`
 *
 * A module-level binding of a local name to an environment variable. This is
 * how a `UrlExpr.baseVar` becomes a destination, and both halves matter: the
 * env var names the deployment-time target, the default literal names the one
 * this code falls back to. On this corpus `PROCUREMENT_BASE_URL` defaults to
 * `''`, which is exactly why its branch is conditional rather than dead.
 *
 * NOT filtered to URL-shaped bindings here. `SERVICE_TOKEN` is a binding too,
 * and deciding which env vars are base URLs is a *declaration* — `repos.json`
 * carries `baseUrlEnvVars` — not something to infer from a default string.
 * Guessing would silently reclassify a token as a destination the moment
 * someone gave it a URL-ish default.
 */
export interface EnvBinding extends Located {
  name: string;
  envVar: string | null;
  defaultUrl: string | null;
  /** The default is a real URL. A hint for the linker, not a filter. */
  urlShaped: boolean;
}

/** A function body, for attributing findings and for P1-T17's CFG walk. */
export interface FunctionRange extends Located {
  name: string | null;
  /** `function` | `arrow` | `method` | `async` variants collapse into these. */
  form: "function" | "arrow" | "method";
  bodyStartLine: number;
}

export interface FileFindings {
  path: string;
  throws: ThrowFinding[];
  configs: ConfigFinding[];
  datastores: DatastoreFinding[];
  https: HttpFinding[];
  urls: UrlExpr[];
  envBindings: EnvBinding[];
  functions: FunctionRange[];
  /** Parse errors seen. A file that failed to parse yields findings, not silence. */
  parseErrors: number;
}

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

const HTTP_CLIENTS = new Set([
  "axios", "fetch", "got", "superagent", "ky", "httpx", "requests", "urllib3",
]);

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "request",
]);

/** Verb -> whether it changes state. `WRITES` is the half the anomaly query (R40) reads. */
const SQL_VERBS: Record<string, "read" | "write"> = {
  select: "read", with: "read",
  insert: "write", update: "write", delete: "write",
  upsert: "write", merge: "write", replace: "write",
};

const SQL_TABLE = new Map<string, RegExp>([
  ["select", /\bfrom\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
  ["with", /\bfrom\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
  ["insert", /\binto\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
  ["update", /\bupdate\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
  ["delete", /\bfrom\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
  ["replace", /\binto\s+([`"'\[]?[\w.]+[`"'\]]?)/i],
]);

const JS_FUNCTION_NODES = new Set([
  "function_declaration", "function_expression", "generator_function_declaration",
  "arrow_function", "method_definition",
]);

function located(node: Node): Located {
  return { line: lineOf(node), col: colOf(node), endLine: node.endPosition.row + 1 };
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stripQuotes(name: string): string {
  return name.replace(/^[`"'\[]+/, "").replace(/[`"'\]]+$/, "");
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Read a SQL literal far enough to name one table and one verb.
 *
 * Deliberately shallow. This is not a SQL parser and must never grow into
 * one: a multi-table join reports the first table, and that is stated rather
 * than papered over, because a wrong table name in a data-dependency query is
 * worse than a missing one — it invents a coupling that does not exist.
 */
export function readSql(text: string): { verb: string; table: string; operation: "read" | "write" } | null {
  const head = text.trimStart().slice(0, 4000);
  const m = /^([a-zA-Z]+)\b/.exec(head);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const operation = SQL_VERBS[verb];
  if (!operation) return null;

  const pattern = SQL_TABLE.get(verb);
  if (!pattern) return null;
  const t = pattern.exec(head);
  if (!t) return null;

  const table = stripQuotes(t[1]!).toLowerCase();
  if (table === "" || /^\d/.test(table)) return null;
  return { verb: verb.toUpperCase(), table, operation };
}

// ---------------------------------------------------------------------------
// URL expressions
// ---------------------------------------------------------------------------

/**
 * Decompose a JS template string or a plain string used as a URL.
 *
 * `` `${ENGINE_BASE_URL}${req.url}` ``  -> base ENGINE_BASE_URL, path "", dynamic
 * `` `${INTEGRATION_BASE_URL}/api/v1/mail/send` `` -> base + "/api/v1/mail/send"
 * `"http://localhost:3002/health"`      -> no base, literal path, not dynamic
 */
export function readUrlExpression(node: Node): UrlExpr | null {
  const pos = located(node);

  if (node.type === "string" || node.type === "string_literal") {
    const text = literalText(node);
    if (!looksLikeUrl(text)) return null;
    return { ...pos, raw: node.text, baseVar: null, literalPath: text, dynamic: false };
  }

  if (node.type !== "template_string") return null;

  let baseVar: string | null = null;
  let literalPath = "";
  let dynamic = false;
  let seenAnything = false;

  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i)!;
    if (child.type === "template_substitution") {
      const expr = child.namedChild(0);
      if (!seenAnything && expr && expr.type === "identifier") {
        // Leading interpolation is the base URL by convention and by the only
        // idiom the corpus uses. Anything else is a dynamic segment.
        baseVar = expr.text;
        seenAnything = true;
        continue;
      }
      dynamic = true;
      seenAnything = true;
      continue;
    }
    // string_fragment (and escape_sequence, which we take verbatim)
    if (!dynamic) literalPath += child.text;
    seenAnything = true;
  }

  if (baseVar === null) {
    if (!looksLikeUrl(literalPath)) return null;
  } else if (!isPathRemainder(literalPath)) {
    // A leading interpolation alone does not make a URL: `${event} - ${ref}`
    // is a log message. What follows a base URL is a path or nothing.
    return null;
  }
  return { ...pos, raw: node.text, baseVar, literalPath, dynamic };
}

function isPathRemainder(text: string): boolean {
  return text === "" || text.startsWith("/") || looksLikeUrl(text);
}

function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || text.startsWith("/");
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export function extract(file: ParsedFile): FileFindings {
  return file.grammar === "python" ? extractPython(file) : extractJs(file);
}

// -- JavaScript / TypeScript ------------------------------------------------

function extractJs(file: ParsedFile): FileFindings {
  const out = emptyFindings(file.path);

  walk(file.tree.rootNode, (node) => {
    if (node.type === "ERROR") out.parseErrors += 1;

    if (JS_FUNCTION_NODES.has(node.type)) out.functions.push(jsFunctionRange(node));

    switch (node.type) {
      case "throw_statement": {
        const thrown = node.namedChild(0);
        const ctor = thrown?.type === "new_expression"
          ? thrown.childForFieldName("constructor")
          : null;
        out.throws.push({
          ...located(node),
          errorName: ctor ? ctor.text : null,
          text: oneLine(node.text, 120),
        });
        break;
      }

      case "member_expression": {
        // process.env.X
        const object = node.childForFieldName("object");
        const property = node.childForFieldName("property");
        if (object?.text === "process.env" && property) {
          out.configs.push({ ...located(node), varName: property.text, accessor: "process.env" });
        }
        break;
      }

      case "subscript_expression": {
        // process.env['X']
        const object = node.childForFieldName("object");
        const index = node.childForFieldName("index");
        if (object?.text === "process.env" && index && index.type === "string") {
          out.configs.push({
            ...located(node), varName: literalText(index), accessor: "process.env",
          });
        }
        break;
      }

      case "variable_declarator": {
        const binding = jsEnvBinding(node);
        if (binding) out.envBindings.push(binding);
        break;
      }

      case "template_string":
      case "string": {
        const url = readUrlExpression(node);
        // A URL inside a `case`/comparison is still a URL; the linker decides
        // what to do with one that matches no call site.
        if (url) out.urls.push(url);
        const sql = readSql(literalText(node));
        if (sql) {
          out.datastores.push({
            ...located(node), engine: "postgres", ...sql, sql: oneLine(literalText(node)),
          });
        }
        break;
      }

      case "call_expression": {
        const http = jsHttpCall(node);
        if (http) out.https.push(http);
        break;
      }

      default:
        break;
    }
    return true;
  });

  return dedupeFindings(out);
}

function jsFunctionRange(node: Node): FunctionRange {
  const nameNode = node.childForFieldName("name");
  let name = nameNode?.text ?? null;
  if (!name) {
    // `const forward = async (...) => {}` and `{ handler: () => {} }` both put
    // the only usable name on the parent.
    const parent = node.parent;
    if (parent?.type === "variable_declarator") name = parent.childForFieldName("name")?.text ?? null;
    else if (parent?.type === "pair") name = parent.childForFieldName("key")?.text ?? null;
  }
  const body = node.childForFieldName("body");
  return {
    ...located(node),
    name,
    form: node.type === "arrow_function" ? "arrow"
      : node.type === "method_definition" ? "method" : "function",
    bodyStartLine: body ? lineOf(body) : lineOf(node),
  };
}

/** `const X = process.env.X || 'http://…'` — the base-URL binding P1-T7 needs. */
function jsEnvBinding(node: Node): EnvBinding | null {
  const nameNode = node.childForFieldName("name");
  const value = node.childForFieldName("value");
  if (!nameNode || !value || nameNode.type !== "identifier") return null;

  let envVar: string | null = null;
  let defaultUrl: string | null = null;

  const readSide = (side: Node | null): void => {
    if (!side) return;
    if (side.type === "member_expression" && side.childForFieldName("object")?.text === "process.env") {
      envVar = side.childForFieldName("property")?.text ?? null;
    } else if (side.type === "string") {
      const text = literalText(side);
      if (looksLikeUrl(text) || text === "") defaultUrl = text;
    }
  };

  if (value.type === "binary_expression" && value.childForFieldName("operator")?.text === "||") {
    readSide(value.childForFieldName("left"));
    readSide(value.childForFieldName("right"));
  } else {
    readSide(value);
  }

  // Without an env var this is not a binding of interest at all:
  // `const auth = req.headers.authorization || ''` would otherwise reach the
  // linker as a destination named `auth`.
  if (envVar === null) return null;
  return {
    ...located(node), name: nameNode.text, envVar, defaultUrl,
    urlShaped: defaultUrl !== null && defaultUrl !== "" && looksLikeUrl(defaultUrl),
  };
}

function jsHttpCall(node: Node): HttpFinding | null {
  const fn = node.childForFieldName("function");
  if (!fn) return null;

  let client: string | null = null;
  let method: string | null = null;

  if (fn.type === "identifier" && HTTP_CLIENTS.has(fn.text)) {
    client = fn.text;                       // axios(config), fetch(url)
  } else if (fn.type === "member_expression") {
    const object = fn.childForFieldName("object");
    const property = fn.childForFieldName("property");
    if (object && property && HTTP_CLIENTS.has(object.text) && HTTP_METHODS.has(property.text)) {
      client = object.text;                 // axios.get(url), requests.post(url)
      method = property.text.toUpperCase();
    }
  }
  if (!client) return null;

  const args = node.childForFieldName("arguments");
  const urls: UrlExpr[] = [];
  let configVar: string | null = null;

  if (args) {
    for (let i = 0; i < args.namedChildCount; i += 1) {
      const arg = args.namedChild(i)!;
      if (arg.type === "identifier" && i === 0) {
        // `axios(axiosConfig)`: the URL is built elsewhere. Recording the
        // identifier is the whole reason the corpus's single outbound call is
        // resolvable at all.
        configVar = arg.text;
        continue;
      }
      walk(arg, (inner) => {
        const url = readUrlExpression(inner);
        if (url) urls.push(url);
        if (inner.type === "pair") {
          const key = inner.childForFieldName("key");
          const value = inner.childForFieldName("value");
          if (key && stripQuotes(key.text) === "method" && value?.type === "string") {
            method = literalText(value).toUpperCase();
          }
        }
        return true;
      });
    }
  }

  return { ...located(node), client, method, urls, configVar };
}

// -- Python -----------------------------------------------------------------

function extractPython(file: ParsedFile): FileFindings {
  const out = emptyFindings(file.path);

  walk(file.tree.rootNode, (node) => {
    if (node.type === "ERROR") out.parseErrors += 1;

    if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      out.functions.push({
        ...located(node),
        name: node.childForFieldName("name")?.text ?? null,
        form: "function",
        bodyStartLine: body ? lineOf(body) : lineOf(node),
      });
    }

    switch (node.type) {
      case "raise_statement": {
        const raised = node.namedChild(0);
        const name = raised?.type === "call"
          ? raised.childForFieldName("function")?.text ?? null
          : raised?.type === "identifier" ? raised.text : null;
        out.throws.push({ ...located(node), errorName: name, text: oneLine(node.text, 120) });
        break;
      }

      case "call": {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (!fn) break;

        // os.getenv("X") and os.environ.get("X")
        if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute")?.text;
          const object = fn.childForFieldName("object")?.text;
          const first = args?.namedChild(0);
          if (
            first && first.type === "string" &&
            ((object === "os" && attr === "getenv") ||
             (object === "os.environ" && attr === "get"))
          ) {
            out.configs.push({
              ...located(node),
              varName: literalText(first),
              accessor: object === "os" ? "os.getenv" : "os.environ",
            });
          }
        }

        const http = pyHttpCall(node, fn, args);
        if (http) out.https.push(http);
        break;
      }

      case "subscript": {
        // os.environ["X"]
        const value = node.childForFieldName("value");
        const sub = node.childForFieldName("subscript");
        if (value?.text === "os.environ" && sub && sub.type === "string") {
          out.configs.push({
            ...located(node), varName: literalText(sub), accessor: "os.environ",
          });
        }
        break;
      }

      case "string": {
        const text = literalText(node);
        const sql = readSql(text);
        if (sql) {
          out.datastores.push({
            ...located(node), engine: "postgres", ...sql, sql: oneLine(text),
          });
        }
        if (looksLikeUrl(text)) {
          out.urls.push({
            ...located(node), raw: node.text, baseVar: null,
            literalPath: text, dynamic: text.includes("{"),
          });
        }
        break;
      }

      case "assignment": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier" && right) {
          const binding = pyEnvBinding(node, left, right);
          if (binding) out.envBindings.push(binding);
        }
        break;
      }

      default:
        break;
    }
    return true;
  });

  return dedupeFindings(out);
}

function pyEnvBinding(node: Node, left: Node, right: Node): EnvBinding | null {
  // BASE = os.getenv("BASE", "http://localhost:8000")
  if (right.type !== "call") return null;
  const fn = right.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const object = fn.childForFieldName("object")?.text;
  const attr = fn.childForFieldName("attribute")?.text;
  // The receiver is checked, not only the method name. Without it
  // `request.headers.get("authorization", "")` reads as an env binding, and
  // the linker acquires a destination called `auth`.
  const isEnvRead = (object === "os" && attr === "getenv") ||
                    (object === "os.environ" && attr === "get");
  if (!isEnvRead) return null;

  const args = right.childForFieldName("arguments");
  const first = args?.namedChild(0);
  const second = args?.namedChild(1);
  if (!first || first.type !== "string") return null;

  const fallback = second?.type === "string" ? literalText(second) : null;
  return {
    ...located(node), name: left.text, envVar: literalText(first),
    defaultUrl: fallback,
    urlShaped: fallback !== null && fallback !== "" && looksLikeUrl(fallback),
  };
}

function pyHttpCall(node: Node, fn: Node, args: Node | null): HttpFinding | null {
  let client: string | null = null;
  let method: string | null = null;

  if (fn.type === "identifier" && HTTP_CLIENTS.has(fn.text)) {
    client = fn.text;
  } else if (fn.type === "attribute") {
    const object = fn.childForFieldName("object")?.text ?? "";
    const attr = fn.childForFieldName("attribute")?.text ?? "";
    // httpx.post(...), requests.get(...), client.post(...) on an httpx client
    const root = object.split(".")[0] ?? "";
    if (HTTP_CLIENTS.has(root) && HTTP_METHODS.has(attr)) {
      client = root;
      method = attr.toUpperCase();
    }
  }
  if (!client) return null;

  const urls: UrlExpr[] = [];
  if (args) {
    walk(args, (inner) => {
      if (inner.type === "string") {
        const text = literalText(inner);
        if (looksLikeUrl(text)) {
          urls.push({
            ...located(inner), raw: inner.text, baseVar: null,
            literalPath: text, dynamic: text.includes("{"),
          });
        }
      }
      return true;
    });
  }

  return { ...located(node), client, method, urls, configVar: null };
}

// ---------------------------------------------------------------------------

function emptyFindings(path: string): FileFindings {
  return {
    path, throws: [], configs: [], datastores: [], https: [],
    urls: [], envBindings: [], functions: [], parseErrors: 0,
  };
}

/**
 * Collapse findings that repeat at one position.
 *
 * `process.env.DATABASE_HOST` inside a member expression is visited once as
 * the expression and once as the object of an outer one; both are the same
 * read. Deduping here rather than at insert keeps the count in the CLI's
 * summary honest.
 */
function dedupeFindings(f: FileFindings): FileFindings {
  const key = (x: Located, extra: string) => `${x.line}:${x.col}:${extra}`;
  const uniq = <T extends Located>(items: T[], extra: (t: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((i) => {
      const k = key(i, extra(i));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  f.configs = uniq(f.configs, (c) => c.varName);
  f.datastores = uniq(f.datastores, (d) => `${d.verb}:${d.table}`);
  f.throws = uniq(f.throws, (t) => t.errorName ?? "");
  f.https = uniq(f.https, (h) => h.client);
  f.urls = uniq(f.urls, (u) => u.raw);
  f.envBindings = uniq(f.envBindings, (b) => b.name);
  return f;
}

/**
 * The innermost function containing a position, from a file's ranges.
 *
 * Used to attribute a finding to a caller when SCIP has no definition covering
 * the line — which on untyped CommonJS is common, since 86 of 306 references
 * in `40-kri-router` resolve to unnamed locals (measurements M7).
 */
export function enclosingFunction(
  functions: FunctionRange[], line: number,
): FunctionRange | null {
  let best: FunctionRange | null = null;
  for (const f of functions) {
    if (line < f.line || line > f.endLine) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line) best = f;
  }
  return best;
}
