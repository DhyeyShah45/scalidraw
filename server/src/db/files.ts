import type { DB } from "./index";

export type StoredFile = {
  id: string;
  mimeType: string;
  /** Rebuilt on read — bytes are stored raw, not as base64 (D12). */
  dataURL: string;
  created: number;
};

const DATA_URL_RE =
  /^data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,(.*)$/s;

export const parseDataURL = (dataURL: string) => {
  const match = DATA_URL_RE.exec(dataURL);
  if (!match || !match[1] || match[2] === undefined) {
    return null;
  }
  return { mimeType: match[1], bytes: Buffer.from(match[2], "base64") };
};

export const putFile = (
  db: DB,
  opts: {
    id: string;
    documentId: string;
    mimeType: string;
    bytes: Buffer;
    created?: number;
    now?: number;
  },
) => {
  const now = opts.now ?? Date.now();

  db.transaction(() => {
    // File ids are content-derived, so a re-upload is the same bytes; keep the
    // original row and just make sure this document is linked to it.
    db.prepare(
      `INSERT OR IGNORE INTO files (id, mime_type, bytes, size, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.mimeType,
      opts.bytes,
      opts.bytes.byteLength,
      opts.created ?? now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO document_files (document_id, file_id) VALUES (?, ?)`,
    ).run(opts.documentId, opts.id);
  })();
};

export const getFiles = (db: DB, ids: readonly string[]): StoredFile[] => {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, mime_type, bytes, created_at FROM files WHERE id IN (${placeholders})`,
    )
    .all(...ids) as {
    id: string;
    mime_type: string;
    bytes: Buffer;
    created_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    mimeType: row.mime_type,
    dataURL: `data:${row.mime_type};base64,${row.bytes.toString("base64")}`,
    created: row.created_at,
  }));
};

export const fileExists = (db: DB, id: string) =>
  db.prepare(`SELECT 1 FROM files WHERE id = ?`).get(id) !== undefined;
