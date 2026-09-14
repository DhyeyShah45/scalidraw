import type { DocumentId } from "../data/workspace";

/** Matches the id shape the server generates (base64url of 12 bytes). */
const DOCUMENT_PATH = /^\/d\/([A-Za-z0-9_-]{1,64})\/?$/;

export const documentPath = (id: DocumentId) => `/d/${id}`;

export const parseDocumentId = (
  pathname: string = window.location.pathname,
): DocumentId | null => DOCUMENT_PATH.exec(pathname)?.[1] ?? null;

/**
 * The origin plus the current document, for the places that reset the URL.
 *
 * Several call sites do `replaceState(..., window.location.origin)` to scrub a
 * consumed `#json=`/`#room=` fragment. That also discards the path, which
 * would silently drop you out of the document you have open — so they call
 * this instead of hardcoding the bare origin.
 */
export const originWithCurrentDocument = () => {
  const id = parseDocumentId();
  return id
    ? `${window.location.origin}${documentPath(id)}`
    : window.location.origin;
};

export const navigateToDocument = (id: DocumentId) => {
  if (parseDocumentId() === id) {
    return;
  }
  window.history.pushState({ documentId: id }, "", documentPath(id));
};

export const replaceWithDocument = (id: DocumentId) => {
  window.history.replaceState({ documentId: id }, "", documentPath(id));
};

/**
 * Back/forward between documents.
 *
 * The app has never had a popstate listener — only `hashchange` — because
 * every URL it produced was origin + fragment. Path routes need this or the
 * browser Back button changes the address bar and nothing else.
 */
export const onDocumentRouteChange = (
  handler: (id: DocumentId | null) => void,
) => {
  const listener = () => handler(parseDocumentId());
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
