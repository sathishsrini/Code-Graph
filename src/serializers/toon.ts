// ============================================================================
// TOON encoder  —  task P1-T15  (requirement R44)
// ============================================================================
// Tabular Object Oriented Notation: field names written once as a header, rows
// written as bare comma-separated values. For the shape a graph query returns
// — many objects, identical keys — it costs roughly half the tokens of JSON,
// which is the entire point of R44.
//
//   edges[3]{src,dst,type,confidence}:
//     proxyToEngine,checkUserAuth,CALLS,certain
//     proxyToEngine,forward,CALLS,certain
//     forward,npm:axios@1.7.2,CALLS_EXTERNAL,inferred
//
// Ported from `D:\facilitator\src\serializers\toon.ts` per plan §5, with the
// bug that section names fixed: the original's `serializeArray` emitted
// `N rows{…}` while its own parser only matched the `key[N]{…}` form, so a
// bare array never round-tripped. One form here, `key[N]{…}`, used everywhere.
//
// **Encoder only.** The plan's verdict was "port the encoder, rewrite the
// decoder", and on inspection the decoder has no consumer: this format exists
// to be *read by a model*, and nothing in the engine parses it back. Shipping a
// decoder with no caller would be a producer-less feature — the same rule that
// keeps `spans` out of the schema (R72).
// ============================================================================

/** A value TOON can put in a cell. Anything else is stringified. */
type Cell = string | number | boolean | null | undefined;

export interface ToonOptions {
  /** Spaces per nesting level. */
  indent?: number;
  /** Name for a top-level bare array. */
  rootName?: string;
}

/**
 * Encode a value as TOON.
 *
 * Arrays of uniform objects become tables; everything else falls back to
 * `key: value` lines. The fallback matters — a real payload is a few tables
 * inside an object with scalar fields, and a format that only handles the
 * table half would need JSON around it anyway.
 */
export function encodeToon(data: unknown, options: ToonOptions = {}): string {
  const indent = options.indent ?? 2;
  if (Array.isArray(data)) {
    return encodeArrayField(options.rootName ?? "items", data, 0, indent);
  }
  if (isPlainObject(data)) return encodeObject(data, 0, indent);
  return formatCell(data as Cell);
}

function encodeObject(obj: Record<string, unknown>, depth: number, indent: number): string {
  const pad = " ".repeat(depth * indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(encodeArrayField(key, value, depth, indent));
    } else if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`);
      lines.push(encodeObject(value, depth + 1, indent));
    } else {
      lines.push(`${pad}${key}: ${formatCell(value as Cell)}`);
    }
  }
  return lines.join("\n");
}

/**
 * A named array.
 *
 * Uniform objects become a table with one header. A ragged array — objects
 * with differing keys — falls back to per-item blocks rather than inventing
 * empty cells, because a blank in a table reads as "this field is empty" when
 * the truth is "this item has no such field".
 */
function encodeArrayField(
  key: string, arr: unknown[], depth: number, indent: number,
): string {
  const pad = " ".repeat(depth * indent);
  const rowPad = " ".repeat((depth + 1) * indent);

  if (arr.length === 0) return `${pad}${key}[0]:`;

  if (arr.every((v) => !isPlainObject(v) && !Array.isArray(v))) {
    return `${pad}${key}[${arr.length}]: ${arr.map((v) => formatCell(v as Cell)).join(",")}`;
  }

  const objects = arr.filter(isPlainObject);
  if (objects.length === arr.length) {
    const keys = Object.keys(objects[0]!);
    const uniform = objects.every((o) => {
      const k = Object.keys(o);
      return k.length === keys.length && k.every((n, i) => n === keys[i]);
    });

    if (uniform && keys.every((k) => objects.every((o) => !isNested(o[k])))) {
      const header = `${pad}${key}[${arr.length}]{${keys.join(",")}}:`;
      const rows = objects.map(
        (o) => `${rowPad}${keys.map((k) => formatCell(o[k] as Cell)).join(",")}`,
      );
      return [header, ...rows].join("\n");
    }
  }

  const blocks = arr.map((item, i) => {
    if (isPlainObject(item)) {
      return `${rowPad}- ${encodeObject(item, depth + 1, indent).trimStart()}`;
    }
    if (Array.isArray(item)) return encodeArrayField(String(i), item, depth + 1, indent);
    return `${rowPad}- ${formatCell(item as Cell)}`;
  });
  return [`${pad}${key}[${arr.length}]:`, ...blocks].join("\n");
}

function isNested(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One cell.
 *
 * A value containing a comma, a quote or a newline is quoted and escaped —
 * without this a SQL fragment in a `detail` column silently becomes three
 * columns, and every row after it in the table is misaligned.
 */
function formatCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, "\\n")}"`;
}

/**
 * Token estimate for a budget, not for billing.
 *
 * ~4 characters per token is the usual English/code approximation. It is used
 * to decide when to STOP adding tiers, so being consistently a little wrong is
 * fine and being expensive would not be — a real tokenizer here would add a
 * dependency to answer a question whose answer only has to be monotonic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
