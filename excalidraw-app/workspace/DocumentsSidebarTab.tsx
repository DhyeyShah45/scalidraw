import { Sidebar } from "@excalidraw/excalidraw";
import {
  DuplicateIcon,
  PlusIcon,
  TrashIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import React, { useMemo, useRef, useState } from "react";

import { useWorkspace } from "./WorkspaceProvider";

import "./workspace.scss";

import type { DocumentId, DocumentMeta } from "../data/workspace";

export const DOCUMENTS_TAB = "documents";

const relativeTime = (timestamp: number) => {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(timestamp).toLocaleDateString();
};

export const DocumentsSidebarTab = () => {
  const {
    documents,
    open,
    openDocument,
    createDocument,
    renameDocument,
    deleteDocument,
    duplicateDocument,
  } = useWorkspace();

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<DocumentId | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentId | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? documents.filter((doc) => doc.name.toLowerCase().includes(needle))
      : documents;
  }, [documents, query]);

  return (
    <div className="workspace-docs">
      <div className="workspace-docs__toolbar">
        <div className="workspace-docs__search">
          <span className="workspace-docs__search-icon">{searchIcon}</span>
          <input
            type="search"
            placeholder="Search canvases"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="workspace-docs__new"
          title="New canvas"
          onClick={() => void createDocument()}
        >
          {PlusIcon}
        </button>
      </div>

      {filtered.length === 0 && (
        <p className="workspace-docs__empty">
          {documents.length === 0
            ? "No canvases yet."
            : `Nothing matches “${query}”.`}
        </p>
      )}

      <ul className="workspace-docs__list">
        {filtered.map((doc) => (
          <DocumentRow
            key={doc.id}
            document={doc}
            isOpen={doc.id === open?.meta.id}
            isRenaming={renaming === doc.id}
            isConfirmingDelete={pendingDelete === doc.id}
            onOpen={() => openDocument(doc.id)}
            onStartRename={() => setRenaming(doc.id)}
            onRename={async (name) => {
              setRenaming(null);
              if (name && name !== doc.name) {
                await renameDocument(doc.id, name);
              }
            }}
            onDuplicate={() => void duplicateDocument(doc.id)}
            onRequestDelete={() => setPendingDelete(doc.id)}
            onCancelDelete={() => setPendingDelete(null)}
            onConfirmDelete={async () => {
              setPendingDelete(null);
              await deleteDocument(doc.id);
            }}
          />
        ))}
      </ul>
    </div>
  );
};

const DocumentRow = ({
  document: doc,
  isOpen,
  isRenaming,
  isConfirmingDelete,
  onOpen,
  onStartRename,
  onRename,
  onDuplicate,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  document: DocumentMeta;
  isOpen: boolean;
  isRenaming: boolean;
  isConfirmingDelete: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  if (isConfirmingDelete) {
    return (
      <li className="workspace-docs__row workspace-docs__row--confirm">
        <span>Delete “{doc.name}”?</span>
        <div className="workspace-docs__confirm-actions">
          <button type="button" onClick={onConfirmDelete}>
            Delete
          </button>
          <button type="button" onClick={onCancelDelete}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={clsx("workspace-docs__row", { "is-open": isOpen })}>
      <button
        type="button"
        className="workspace-docs__main"
        onClick={onOpen}
        onDoubleClick={onStartRename}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            className="workspace-docs__rename"
            defaultValue={doc.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => onRename(event.target.value.trim())}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onRename(event.currentTarget.value.trim());
              }
              if (event.key === "Escape") {
                onRename(doc.name);
              }
            }}
          />
        ) : (
          <>
            <span className="workspace-docs__name">{doc.name}</span>
            <span className="workspace-docs__meta">
              {relativeTime(doc.updatedAt)}
            </span>
          </>
        )}
      </button>

      <div className="workspace-docs__actions">
        <button type="button" title="Duplicate" onClick={onDuplicate}>
          {DuplicateIcon}
        </button>
        <button type="button" title="Delete" onClick={onRequestDelete}>
          {TrashIcon}
        </button>
      </div>
    </li>
  );
};

export const DocumentsTab = () => (
  <Sidebar.Tab tab={DOCUMENTS_TAB}>
    <DocumentsSidebarTab />
  </Sidebar.Tab>
);
