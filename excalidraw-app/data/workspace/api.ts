import type { DocumentId, DocumentMeta, FileUpload } from "./types";

export class WorkspaceApiError extends Error {}

/** No usable session — the login gate should take over. */
export class AuthRequiredError extends WorkspaceApiError {
  constructor(message = "Not signed in") {
    super(message);
  }
}

/**
 * The request never reached the app (D24).
 *
 * Cloudflare Access answers an expired session with a 302 to its own login
 * page, not a 401. Followed blindly that returns an HTML page with a 200, and
 * an autosave would record it as a successful write. `redirect: "manual"` turns
 * that bounce into an opaque response we can recognise instead.
 */
export class AccessChallengeError extends AuthRequiredError {
  constructor() {
    super("Session expired at the edge — reload to sign in again");
  }
}

/** Another device wrote first (D9). The pending write is kept, not discarded. */
export class ConflictError extends WorkspaceApiError {
  constructor(public readonly serverVersion: number) {
    super(`Document changed elsewhere (now at version ${serverVersion})`);
  }
}

/** Could not reach the server at all — queue the write and retry. */
export class NetworkError extends WorkspaceApiError {}

export class NotFoundError extends WorkspaceApiError {}

const JSON_HEADERS = { "content-type": "application/json" };

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body passthrough for binary uploads (thumbnails). */
  raw?: BodyInit;
  signal?: AbortSignal;
};

const parseJSON = async (response: Response) => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // A JSON API answering with HTML means something in front of us
    // intercepted the request — an Access login page being the likely one.
    throw new AccessChallengeError();
  }
  return response.json();
};

export const request = async <T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  let response: Response;

  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      // Never follow: a redirect from an API route is an edge challenge, and
      // following it would hand us a login page dressed as a 200.
      redirect: "manual",
      headers: options.raw
        ? options.headers
        : { ...JSON_HEADERS, ...options.headers },
      body:
        options.raw ??
        (options.body ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // fetch only rejects for transport-level failures. A cross-origin Access
    // redirect can also land here depending on the browser, which is why the
    // caller treats both as "keep the write queued".
    throw new NetworkError(
      error instanceof Error ? error.message : "Network request failed",
    );
  }

  if (response.type === "opaqueredirect" || response.status === 0) {
    throw new AccessChallengeError();
  }

  if (response.status === 401) {
    throw new AuthRequiredError();
  }
  if (response.status === 404) {
    throw new NotFoundError(`Not found: ${path}`);
  }
  if (response.status === 409) {
    const body = await parseJSON(response).catch(() => ({}));
    throw new ConflictError(Number(body?.currentVersion ?? 0));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new WorkspaceApiError(
      `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await parseJSON(response)) as T;
};

export type ScenePayload = {
  document: DocumentMeta;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
};

export const workspaceApi = {
  login: (password: string) =>
    request<{ authenticated: true; expiresAt: number }>("/api/auth/login", {
      method: "POST",
      body: { password },
    }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  session: () => request<{ authenticated: true }>("/api/auth/session"),

  listDocuments: () =>
    request<{ documents: DocumentMeta[] }>("/api/documents").then(
      (payload) => payload.documents,
    ),

  createDocument: (name?: string) =>
    request<{ document: DocumentMeta }>("/api/documents", {
      method: "POST",
      body: name ? { name } : {},
    }).then((payload) => payload.document),

  renameDocument: (id: DocumentId, name: string) =>
    request<{ document: DocumentMeta }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: { name },
    }).then((payload) => payload.document),

  deleteDocument: (id: DocumentId) =>
    request<void>(`/api/documents/${id}`, { method: "DELETE" }),

  duplicateDocument: (id: DocumentId, name?: string) =>
    request<{ document: DocumentMeta }>(`/api/documents/${id}/duplicate`, {
      method: "POST",
      body: name ? { name } : {},
    }).then((payload) => payload.document),

  getScene: (id: DocumentId) =>
    request<ScenePayload>(`/api/documents/${id}/scene`),

  putScene: (
    id: DocumentId,
    baseVersion: number,
    payload: {
      elements: readonly unknown[];
      appState: Record<string, unknown>;
      fileIds: string[];
    },
  ) =>
    request<{ version: number; updatedAt: number }>(
      `/api/documents/${id}/scene`,
      {
        method: "PUT",
        headers: { "if-match": String(baseVersion) },
        body: payload,
      },
    ),

  putThumbnail: (id: DocumentId, png: Blob) =>
    request<void>(`/api/documents/${id}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      raw: png,
    }),

  uploadFiles: (id: DocumentId, files: FileUpload[]) =>
    request<{ saved: string[]; rejected: { id: string; reason: string }[] }>(
      `/api/documents/${id}/files`,
      { method: "POST", body: { files } },
    ),

  fetchFiles: (ids: string[]) =>
    request<{
      files: {
        id: string;
        mimeType: string;
        dataURL: string;
        created: number;
      }[];
      missing: string[];
    }>("/api/files/batch", { method: "POST", body: { ids } }),

  getLibrary: () => request<{ libraryItems: unknown[] }>("/api/library"),

  putLibrary: (libraryItems: readonly unknown[]) =>
    request<void>("/api/library", { method: "PUT", body: { libraryItems } }),
};

export type WorkspaceApi = typeof workspaceApi;
