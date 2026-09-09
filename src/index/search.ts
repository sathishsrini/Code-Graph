// Build (and rebuild) the FTS5 search table + optional embeddings (P3-T3, R43/R67).
//
// One job and one rule: rows in `search` must mirror the live `nodes` snapshot,
// so the table is rebuilt wholesale every time, inside one transaction, with
// provenance in `search_meta`. An incremental FTS5 delete needs the exact
// original row text to remove, and getting subtle stale rows to outrank the
// live ones forever is exactly the class of failure this store refuses to make.
//
// The gap this index exists to cross: FTS5's tokenizer reads `checkUserAuth`
// as the single token `checkuserauth`, while a person describing the workflow
// says "check user auth". The columns are the whole text a person might mean —
// name, qualified, signature for a symbol; method+url and service for a route;
// path for a file — and the solver folds the phrase into a single token (and a
// prefix) so camelCase identifiers match both spellings. No spelling of a word
// is invented; the token stream is the tokenizer's own.

import type { FactStore } from "../store/db.ts";
import { containerOf, displayNameOf, packageOf } from "../static/scip/symbol.ts";
import type { EmbeddingProvider } from "../retrieval/vector-store.ts";
import { toBlob } from "../retrieval/vector-store.ts";

export interface SearchBuildOptions {
  /** When present, every seed row also becomes a vector row (R67). */
  embeddings?: EmbeddingProvider | null;
}

export interface SearchBuildReport {
  rows: number;
  vectors: number;
  provider: string | null;
  rebuiltAt: string;
}

interface SeedRow {
  nodeKey: string;
  kind: "symbol" | "route" | "file";
  name: string;
  qualified: string;
  signature: string;
  doc: string;
  path: string;
}

const DOC_CLIP = 4000;

function clipDoc(doc: string | null | undefined): string {
  if (!doc) return "";
  return doc.length > DOC_CLIP ? doc.slice(0, DOC_CLIP) : doc;
}

export function buildSearchIndex(
  store: FactStore,
  options: SearchBuildOptions = {},
): SearchBuildReport {
  const db = store.raw();

  const rows: SeedRow[] = [];
  {
    const symbols = db
      .prepare(
        `SELECT n.key AS node_key, s.display_name, s.signature, s.doc, f.path AS file
           FROM nodes n
           JOIN symbols s ON s.node_id = n.id
           LEFT JOIN files f ON f.id = s.file_id
          WHERE n.kind = 'symbol'`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of symbols) {
      const key = String(r.node_key);
      const file = r.file == null ? null : String(r.file);
      const name = String(r.display_name ?? displayNameOf(key));
      const qualified = file ?? containerOf(key) ?? packageOf(key);
      rows.push({
        nodeKey: String(r.node_key),
        kind: "symbol",
        name,
        qualified,
        signature: r.signature == null ? "" : String(r.signature),
        doc: clipDoc(r.doc as string | null),
        path: file ?? "",
      });
    }
  }
  {
    const routes = db
      .prepare(
        `SELECT n.key AS node_key, r.service_name, r.method, r.url
           FROM nodes n
           JOIN routes r ON r.node_id = n.id
          WHERE n.kind = 'route'`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of routes) {
      const method = String(r.method).toUpperCase();
      const url = String(r.url);
      const service = String(r.service_name);
      rows.push({
        nodeKey: String(r.node_key),
        kind: "route",
        name: `${method} ${url}`,
        qualified: service,
        signature: "",
        doc: "",
        path: "",
      });
    }
  }
  {
    const files = db
      .prepare(`SELECT n.key AS node_key FROM nodes n WHERE n.kind = 'file'`)
      .all() as Array<Record<string, unknown>>;
    for (const r of files) {
      const key = String(r.node_key);
      const slash = key.lastIndexOf("/");
      rows.push({
        nodeKey: key,
        kind: "file",
        name: slash >= 0 ? key.slice(slash + 1) : key,
        qualified: slash >= 0 ? key.slice(0, slash) : "",
        signature: "",
        doc: "",
        path: key,
      });
    }
  }

  const builtAt = new Date().toISOString();
  const provider = options.embeddings ?? null;
  const providerName = provider?.name ?? null;

  store.transaction(() => {
    db.prepare("DELETE FROM search").run();
    db.prepare("DELETE FROM search_vectors").run();

    const insert = db.prepare(
      `INSERT INTO search (node_key, kind, name, qualified, signature, doc, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(r.nodeKey, r.kind, r.name, r.qualified, r.signature, r.doc, r.path);
    }

    if (provider) {
      const vecInsert = db.prepare(
        `INSERT INTO search_vectors (node_key, kind, vector, built_at) VALUES (?, ?, ?, ?)`,
      );
      for (const r of rows) {
        const text = [r.name, r.qualified, r.signature, r.path].filter(Boolean).join(" ");
        const vector = provider.embed(text);
        if (vector.length !== provider.dimension) {
          throw new Error(
            `EmbeddingProvider "${provider.name}" returned ${vector.length} dims, expected ${provider.dimension}`,
          );
        }
        vecInsert.run(r.nodeKey, r.kind, toBlob(vector), builtAt);
      }
    }

    db.prepare(
      `INSERT INTO search_meta (id, built_at, rows, run_id) VALUES (1, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET built_at = excluded.built_at, rows = excluded.rows, run_id = NULL`,
    ).run(builtAt, rows.length);
  });

  return {
    rows: rows.length,
    vectors: provider ? rows.length : 0,
    provider: providerName,
    rebuiltAt: builtAt,
  };
}