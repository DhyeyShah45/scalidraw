import type { KVStore } from "./kv";
import type { DocumentId, SceneRecord } from "./types";

/**
 * The write-through cache (D10) and the sync queue in one store.
 *
 * A pending write is just a record with `dirty: true`, which is what makes the
 * queue self-collapsing: fifty edits to one document between two flushes leave
 * one row to push, not fifty. It also means the queue survives a browser
 * restart for free, which D11 requires — a queued drawing is never dropped on
 * a timer.
 */
export class SceneCache {
  constructor(private readonly kv: KVStore) {}

  private key = (id: DocumentId) => `scene:${id}`;

  get(id: DocumentId) {
    return this.kv.get<SceneRecord>(this.key(id));
  }

  async put(record: SceneRecord) {
    await this.kv.set(this.key(record.id), record);
    return record;
  }

  async update(
    id: DocumentId,
    patch: Partial<Omit<SceneRecord, "id">>,
  ): Promise<SceneRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) {
      return undefined;
    }
    return this.put({ ...existing, ...patch });
  }

  /**
   * Apply the result of a push, but only if no edit landed while it was in
   * flight. Without the revision guard the update stamps `dirty: false` onto
   * content the server has never seen, silently losing that edit.
   */
  async settle(
    id: DocumentId,
    expectedRevision: number,
    patch: Partial<Omit<SceneRecord, "id">>,
  ) {
    const existing = await this.get(id);
    if (!existing) {
      return undefined;
    }
    if (existing.revision !== expectedRevision) {
      // Keep it dirty; only adopt the new server version to re-base onto.
      return this.put({
        ...existing,
        version: patch.version ?? existing.version,
      });
    }
    return this.put({ ...existing, ...patch });
  }

  delete(id: DocumentId) {
    return this.kv.delete(this.key(id));
  }

  /** Pushes stop being retried after this many consecutive failures. */
  static readonly MAX_FAILURES = 5;

  async pending(): Promise<SceneRecord[]> {
    const all = await this.kv.entries<SceneRecord>();
    return all
      .filter(([key, record]) => key.startsWith("scene:") && record?.dirty)
      .map(([, record]) => record)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async pendingCount() {
    return (await this.pending()).length;
  }

  /**
   * Pending writes the queue can actually push. A conflicted record is still
   * dirty, but it is blocked on the user choosing reload-or-overwrite, so it
   * must not be counted as "waiting for the network".
   */
  async syncable() {
    return (await this.pending()).filter(
      (record) =>
        record.conflictedWithVersion === undefined &&
        (record.failures ?? 0) < SceneCache.MAX_FAILURES,
    );
  }
}
