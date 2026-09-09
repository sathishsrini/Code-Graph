// Minimal in-memory cosine store over rows persisted in `search_vectors`.
//
// Deliberately the shape of an ANNS provider, not a reimplementation of one.
// bm25 exists already (search); the *vector* side is what R67 needs, and the
// fullness of that is one provider's responsibility: `search.buildSearchIndex`
// accepts an `EmbeddingProvider`, converts every seed row to an embedding, and
// stores the packed bytes. Here they are loaded back and compared with cosine.
//
// The vector is never written by this module and never interpreted as an
// embedding anywhere else — packed Float32Array bytes with a schema marker is
// all it is. Vector search is a *candidate generator*: it contributes a ranked
// set to `applyRRF`, and the merged rank is still only a candidate list.

export interface EmbeddingProvider {
  /** Stable name used as the RRF `source`, e.g. `vector:m3`. */
  readonly name: string;
  /** Dimensionality. Kept so a store built with a different model is not silently searched. */
  readonly dimension: number;
  /** Embed a single text string. Must return exactly `dimension` entries. */
  embed(text: string): Float32Array;
}

export interface VectorHit {
  id: string;
  score: number; // cosine, [-1, 1], higher = closer. Never compared to a lexical score.
}

export class VectorIndex {
  readonly vectors = new Map<string, Float32Array>();

  get size(): number {
    return this.vectors.size;
  }

  ids(): IterableIterator<string> {
    return this.vectors.keys();
  }

  upsert(id: string, vector: Float32Array): void {
    if (vector.length === 0) throw new Error(`VectorIndex: empty vector for "${id}"`);
    this.vectors.set(id, vector);
  }

  /** Search by cosine similarity. Ties break on id for determinism. */
  search(query: Float32Array, topK: number): VectorHit[] {
    const hits: VectorHit[] = [];
    for (const [id, vector] of this.vectors) {
      hits.push({ id, score: cosineSimilarity(query, vector) });
    }
    return hits
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, topK));
  }
}

export function toBlob(vector: Float32Array): Buffer {
  const body = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  return Buffer.concat([Buffer.from(packMagic(vector.length)), body]);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  const magicLen = SIZE_MAGIC.length + 4;
  const buf = Buffer.from(blob);
  if (buf.length < magicLen) throw new Error("VectorIndex: truncated vector blob");
  const magic = buf.subarray(0, SIZE_MAGIC.length).toString("latin1");
  if (magic !== SIZE_MAGIC) throw new Error("VectorIndex: unknown vector blob magic");
  const n = buf.readUInt32LE(SIZE_MAGIC.length);
  const expect = 4 * n;
  const actual = buf.length - magicLen;
  if (actual !== expect) throw new Error(`VectorIndex: blob length mismatch (${actual} != ${expect})`);
  return new Float32Array(buf.buffer.slice(buf.byteOffset + magicLen, buf.byteOffset + magicLen + expect));
}

// ---------------------------------------------------------------------------

const SIZE_MAGIC = "f32";

function packMagic(n: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(n, 0);
  return Buffer.concat([Buffer.from(SIZE_MAGIC, "latin1"), header]);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`VectorIndex: dimension mismatch (${a.length} != ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}