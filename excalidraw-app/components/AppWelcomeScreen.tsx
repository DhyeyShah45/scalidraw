import { useI18n } from "@excalidraw/excalidraw/i18n";
import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React from "react";

import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Self-hosted build: no live-collaboration entry, no sign-up link, and copy
 * that tells the truth about where the work lives.
 *
 * The stock heading says drawings are kept in browser storage and urges saving
 * to a file. That is false here, and warning someone their work is at risk
 * when it is not is worse than saying nothing. Overridden in this component
 * rather than in the shared locale file, which upstream owns and which would
 * conflict on every pull.
 */
export const AppWelcomeScreen: React.FC = React.memo(() => {
  const { t } = useI18n();
  const { open: openDocument } = useWorkspace();

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          {openDocument ? (
            <>
              Saved to your workspace.
              <br />
              Every canvas syncs automatically.
            </>
          ) : (
            <>Your canvases, on your own server.</>
          )}
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
