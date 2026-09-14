import zlib from "node:zlib";

/**
 * Scenes are stored gzipped (D8 keeps whole snapshots, so the compression
 * matters — Excalidraw JSON is extremely repetitive and typically shrinks 8-15x).
 */
export const packJSON = (value: unknown): Buffer =>
  zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8"));

export const unpackJSON = <T>(blob: Buffer | Uint8Array): T =>
  JSON.parse(zlib.gunzipSync(blob).toString("utf8")) as T;
