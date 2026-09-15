import { eyeIcon, loginIcon } from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { useWorkspace } from "../workspace/WorkspaceProvider";

import { saveDebugState } from "./DebugCanvas";

/**
 * Self-hosted build: the Excalidraw+ upsell links, the socials and the
 * sign-up item are all gone. They advertise a hosted product this instance is
 * a replacement for, and every one of them navigates away from your canvas.
 */
export const AppMainMenu: React.FC<{
  theme: Theme | "system";
  refresh: () => void;
}> = React.memo((props) => {
  const { signOut } = useWorkspace();

  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
      <MainMenu.Separator />
      {/*
        Sign out flushes before clearing the session — never end a session
        over unsent work, since the login screen cannot show a queue.
      */}
      <MainMenu.Item icon={loginIcon} onSelect={() => void signOut()}>
        Sign out
      </MainMenu.Item>
    </MainMenu>
  );
});
