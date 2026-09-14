import { packJSON, unpackJSON } from "../lib/gzip";
import { newDocumentId } from "../lib/ids";

import type { Config } from "../config";

import type { DB } from "./index";

export type SceneData = {
  elements: readonly unknown[];
  /** Per-document appState subset only — see D13. */
  appState: Record<string, unknown>;
};

export type DocumentMeta = {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasThumbnail: boolean;
};

type DocumentRow = {
  id: string;
  name: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  thumbnail_updated_at: number | null;
};

const EMPTY_SCENE: SceneData = { elements: [], appState: {} };

const toMeta = (row: DocumentRow): DocumentMeta => ({
  id: row.id,
  name: row.name,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  hasThumbnail: row.thumbnail_updated_at !== null,
});

export const listDocuments = (db: DB): DocumentMeta[] =>
  (
    db
      .prepare(
        `SELECT id, name, version, created_at, updated_at, deleted_at, thumbnail_updated_at
           FROM documents
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC`,
      )
      .all() as DocumentRow[]
  ).map(toMeta);

export const getDocument = (db: DB, id: string): DocumentMeta | null => {
  const row = db
    .prepare(
      `SELECT id, name, version, created_at, updated_at, deleted_at, thumbnail_updated_at
         FROM documents
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as DocumentRow | undefined;
  return row ? toMeta(row) : null;
};

export const createDocument = (
  db: DB,
  opts: { name: string; scene?: SceneData; now?: number },
): DocumentMeta => {
  const now = opts.now ?? Date.now();
  const id = newDocumentId();
  const scene = opts.scene ?? EMPTY_SCENE;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO documents (id, name, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(id, opts.name, now, now);
    db.prepare(
      `INSERT INTO scenes (document_id, blob, updated_at) VALUES (?, ?, ?)`,
    ).run(id, packJSON(scene), now);
  })();

  return getDocument(db, id)!;
};

export const getScene = (
  db: DB,
  id: string,
): { meta: DocumentMeta; scene: SceneData } | null => {
  const meta = getDocument(db, id);
  if (!meta) {
    return null;
  }
  const row = db
    .prepare(`SELECT blob FROM scenes WHERE document_id = ?`)
    .get(id) as { blob: Buffer } | undefined;

  return { meta, scene: row ? unpackJSON<SceneData>(row.blob) : EMPTY_SCENE };
};

export type WriteSceneResult =
  | { ok: true; version: number; updatedAt: number }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "conflict"; currentVersion: number };

/**
 * The autosave write path. `baseVersion` is the version the client last saw;
 * a mismatch means another device wrote in between and the client gets a 409
 * to resolve (D9) rather than silently clobbering.
 *
 * `fileIds` are the image ids the scene references. Links are only ever ADDED:
 * a file stays associated with its document even once the canvas stops
 * referencing it, so restoring an older snapshot (D5) still finds its images.
 * Files are reclaimed when a document is purged, never on the autosave path —
 * that is the fix for landmine 1.
 */
export const writeScene = (
  db: DB,
  config: Config,
  opts: {
    id: string;
    baseVersion: number;
    scene: SceneData;
    fileIds?: readonly string[];
    now?: number;
  },
): WriteSceneResult => {
  const now = opts.now ?? Date.now();
  const blob = packJSON(opts.scene);

  return db.transaction((): WriteSceneResult => {
    const row = db
      .prepare(
        `SELECT version FROM documents WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(opts.id) as { version: number } | undefined;

    if (!row) {
      return { ok: false, reason: "not-found" };
    }
    if (row.version !== opts.baseVersion) {
      return { ok: false, reason: "conflict", currentVersion: row.version };
    }

    const version = row.version + 1;

    db.prepare(
      `UPDATE documents SET version = ?, updated_at = ? WHERE id = ?`,
    ).run(version, now, opts.id);
    db.prepare(
      `INSERT INTO scenes (document_id, blob, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (document_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
    ).run(opts.id, blob, now);

    if (opts.fileIds?.length) {
      const link = db.prepare(
        `INSERT OR IGNORE INTO document_files (document_id, file_id) VALUES (?, ?)`,
      );
      const known = db.prepare(`SELECT 1 FROM files WHERE id = ?`);
      for (const fileId of opts.fileIds) {
        // Scenes are saved before their images finish uploading, so a
        // not-yet-uploaded id is normal — the upload endpoint links it itself.
        if (known.get(fileId)) {
          link.run(opts.id, fileId);
        }
      }
    }

    maybeSnapshot(db, config, opts.id, blob, version, now);

    return { ok: true, version, updatedAt: now };
  })();
};

const maybeSnapshot = (
  db: DB,
  config: Config,
  documentId: string,
  blob: Buffer,
  version: number,
  now: number,
) => {
  const last = db
    .prepare(
      `SELECT created_at FROM snapshots WHERE document_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(documentId) as { created_at: number } | undefined;

  if (last && now - last.created_at < config.snapshotIntervalMs) {
    return;
  }

  db.prepare(
    `INSERT INTO snapshots (document_id, blob, version, created_at) VALUES (?, ?, ?, ?)`,
  ).run(documentId, blob, version, now);

  db.prepare(
    `DELETE FROM snapshots
      WHERE document_id = ?
        AND id NOT IN (
          SELECT id FROM snapshots WHERE document_id = ? ORDER BY created_at DESC LIMIT ?
        )`,
  ).run(documentId, documentId, config.snapshotsPerDocument);
};

export const renameDocument = (
  db: DB,
  id: string,
  name: string,
  now = Date.now(),
) =>
  db
    .prepare(
      `UPDATE documents SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(name, now, id).changes > 0;

/** Soft delete (D6). Recoverable by clearing deleted_at. */
export const deleteDocument = (db: DB, id: string, now = Date.now()) =>
  db
    .prepare(
      `UPDATE documents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(now, id).changes > 0;

export const duplicateDocument = (
  db: DB,
  id: string,
  name: string,
  now = Date.now(),
): DocumentMeta | null => {
  const source = getScene(db, id);
  if (!source) {
    return null;
  }

  const copy = createDocument(db, { name, scene: source.scene, now });

  db.prepare(
    `INSERT OR IGNORE INTO document_files (document_id, file_id)
     SELECT ?, file_id FROM document_files WHERE document_id = ?`,
  ).run(copy.id, id);

  return copy;
};

export const setThumbnail = (
  db: DB,
  id: string,
  png: Buffer,
  now = Date.now(),
) =>
  db
    .prepare(
      `UPDATE documents SET thumbnail = ?, thumbnail_updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(png, now, id).changes > 0;

export const getThumbnail = (db: DB, id: string) => {
  const row = db
    .prepare(
      `SELECT thumbnail, thumbnail_updated_at FROM documents
        WHERE id = ? AND deleted_at IS NULL AND thumbnail IS NOT NULL`,
    )
    .get(id) as { thumbnail: Buffer; thumbnail_updated_at: number } | undefined;

  return row
    ? { png: row.thumbnail, updatedAt: row.thumbnail_updated_at }
    : null;
};

/**
 * Hard removal. Not reachable from the UI in v1 (D6) — kept because it is the
 * only place images are reclaimed, and because the backup/restore story needs
 * a real purge to be testable.
 */
export const purgeDocument = (db: DB, id: string) =>
  db.transaction(() => {
    const removed = db
      .prepare(`DELETE FROM documents WHERE id = ?`)
      .run(id).changes;
    const orphans = collectOrphanFiles(db);
    return { removed: removed > 0, filesReclaimed: orphans };
  })();

/** Deletes file blobs no surviving document links to. */
export const collectOrphanFiles = (db: DB) =>
  db
    .prepare(
      `DELETE FROM files
        WHERE id NOT IN (SELECT file_id FROM document_files)`,
    )
    .run().changes;
