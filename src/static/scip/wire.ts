// ============================================================================
// Minimal protobuf wire-format decoder  —  task P0-T4
// ============================================================================
// SCIP indexes are protobuf. Rather than take a dependency, this decodes the
// wire format directly — it is small, fully specified, and keeps the project's
// zero-native-dependency property.
//
// This decoder is schema-agnostic: it turns bytes into a field-number → values
// map. The SCIP schema is applied one layer up, in reader.ts, so a schema
// change never requires touching this file.
//
// Reference: https://protobuf.dev/programming-guides/encoding/
// ============================================================================

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

export type WireValue =
  | { kind: "varint"; value: bigint }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "fixed32"; value: number }
  | { kind: "fixed64"; value: bigint };

/** field number → every value seen for it (protobuf allows repeats). */
export type Fields = Map<number, WireValue[]>;

export class WireError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = "WireError";
  }
}

class Reader {
  private buf: Uint8Array;
  private pos: number;
  private end: number;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get offset(): number {
    return this.pos;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    const start = this.pos;

    for (;;) {
      if (this.pos >= this.end) throw new WireError("truncated varint", start);
      const byte = this.buf[this.pos]!;
      this.pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      // 10 bytes is the maximum for a 64-bit varint.
      if (shift > 63n) throw new WireError("varint exceeds 64 bits", start);
    }
    return result;
  }

  bytes(): Uint8Array {
    const start = this.pos;
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.end) {
      throw new WireError(`length-delimited field overruns buffer (len ${len})`, start);
    }
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new WireError("truncated fixed32", this.pos);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, true);
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new WireError("truncated fixed64", this.pos);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  skipUnknown(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT: this.varint(); return;
      case WIRE_FIXED64: this.fixed64(); return;
      case WIRE_BYTES: this.bytes(); return;
      case WIRE_FIXED32: this.fixed32(); return;
      default:
        throw new WireError(`unsupported wire type ${wireType}`, this.pos);
    }
  }
}

/** Decode one protobuf message into a field map. */
export function decodeMessage(buf: Uint8Array): Fields {
  const reader = new Reader(buf);
  const fields: Fields = new Map();

  while (!reader.done) {
    const key = Number(reader.varint());
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (fieldNumber === 0) throw new WireError("field number 0 is invalid", reader.offset);

    let value: WireValue;
    switch (wireType) {
      case WIRE_VARINT: value = { kind: "varint", value: reader.varint() }; break;
      case WIRE_BYTES: value = { kind: "bytes", value: reader.bytes() }; break;
      case WIRE_FIXED32: value = { kind: "fixed32", value: reader.fixed32() }; break;
      case WIRE_FIXED64: value = { kind: "fixed64", value: reader.fixed64() }; break;
      default:
        reader.skipUnknown(wireType);
        continue;
    }

    const existing = fields.get(fieldNumber);
    if (existing) existing.push(value);
    else fields.set(fieldNumber, [value]);
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

const UTF8 = new TextDecoder("utf-8", { fatal: false });

export function getBytes(fields: Fields, n: number): Uint8Array[] {
  const vs = fields.get(n);
  if (!vs) return [];
  const out: Uint8Array[] = [];
  for (const v of vs) if (v.kind === "bytes") out.push(v.value);
  return out;
}

export function getString(fields: Fields, n: number): string {
  const all = getBytes(fields, n);
  const first = all[0];
  return first === undefined ? "" : UTF8.decode(first);
}

export function getStrings(fields: Fields, n: number): string[] {
  return getBytes(fields, n).map((b) => UTF8.decode(b));
}

export function getUint(fields: Fields, n: number): number {
  const vs = fields.get(n);
  if (!vs) return 0;
  for (const v of vs) if (v.kind === "varint") return Number(v.value);
  return 0;
}

export function getBool(fields: Fields, n: number): boolean {
  return getUint(fields, n) !== 0;
}

/** Sub-messages of a length-delimited field. */
export function getMessages(fields: Fields, n: number): Fields[] {
  return getBytes(fields, n).map(decodeMessage);
}

export function getMessage(fields: Fields, n: number): Fields | undefined {
  const all = getBytes(fields, n);
  const first = all[0];
  return first === undefined ? undefined : decodeMessage(first);
}

/**
 * A `repeated int32`, accepting both encodings.
 *
 * proto3 packs repeated scalars into a single length-delimited field, but the
 * unpacked form (one varint per tag) is still legal and some writers emit it.
 * SCIP ranges arrive packed in practice; handling both costs nothing and avoids
 * a silent empty-range bug if that ever changes.
 */
export function getPackedInts(fields: Fields, n: number): number[] {
  const vs = fields.get(n);
  if (!vs) return [];

  const out: number[] = [];
  for (const v of vs) {
    if (v.kind === "varint") {
      out.push(Number(v.value));
    } else if (v.kind === "bytes") {
      const reader = new Reader(v.value);
      while (!reader.done) out.push(Number(reader.varint()));
    }
  }
  return out;
}
