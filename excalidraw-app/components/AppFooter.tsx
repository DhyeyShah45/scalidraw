import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { SyncStatus } from "../workspace/SyncStatus";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";

export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {/*
            Lives in the footer island rather than loose in the editor
            container: rendered in normal flow it inserted and removed a block
            element on every single save, reflowing the whole layout and making
            the canvas visibly flicker while drawing.
          */}
          <SyncStatus />
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
        </div>
      </Footer>
    );
  },
);
