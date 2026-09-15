import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import React from "react";

import {
  DOCUMENTS_TAB,
  DocumentsSidebarTab,
} from "../workspace/DocumentsSidebarTab";

import "./AppSidebar.scss";

/** Stacked sheets — the documents tab trigger. */
const documentsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path
      d="M7.5 3.75h6l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5V5.25a1.5 1.5 0 0 1 1.5-1.5Z"
      strokeLinejoin="round"
    />
    <path d="M13.5 3.75v4h4" strokeLinejoin="round" />
    <path
      d="M17.5 8.5h1.5a1.5 1.5 0 0 1 1.5 1.5v9.75a1.5 1.5 0 0 1-1.5 1.5H9.5A1.5 1.5 0 0 1 8 19.75V18.75"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Both stock tabs here were Excalidraw+ adverts — "comments" and
 * "presentation", each a static image and a sign-up button. The comments one
 * became the canvases list; the presentation one is simply gone.
 */
export const AppSidebar = () => {
  const { openSidebar } = useUIAppState();

  return (
    <DefaultSidebar>
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger
          tab={DOCUMENTS_TAB}
          title="Canvases"
          style={{ opacity: openSidebar?.tab === DOCUMENTS_TAB ? 1 : 0.4 }}
        >
          {documentsIcon}
        </Sidebar.TabTrigger>
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab={DOCUMENTS_TAB}>
        <DocumentsSidebarTab />
      </Sidebar.Tab>
    </DefaultSidebar>
  );
};
