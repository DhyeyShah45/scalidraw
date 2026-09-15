import { check, newPage, settle, signIn } from "../harness.mjs";

export const name = "signing out";

export const run = async ({ browser, base }) => {
  const page = await newPage(browser);
  await signIn(page, base);
  check(!!(await page.$(".excalidraw")), "signed in and the editor is up");

  await page.click(".dropdown-menu-button");
  await page.waitForSelector(".dropdown-menu", { timeout: 10000 });

  const signOut = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".dropdown-menu-item")].find((n) =>
      n.textContent?.includes("Sign out"),
    ),
  );
  check(!!signOut.asElement(), "there is a Sign out item in the menu");

  await signOut.asElement().click();
  await page.waitForSelector("#workspace-password", { timeout: 20000 });
  check(true, "signing out returns to the login screen");

  // A cosmetic sign-out that leaves the session alive would be worse than
  // none at all, so check the server actually rejects the old cookie.
  const status = await page.evaluate(
    async () =>
      (
        await fetch("/api/auth/session", { credentials: "same-origin" })
      ).status,
  );
  check(status === 401, "the server session is really gone", `got ${status}`);

  // And signing back in works.
  await signIn(page, base);
  check(
    /^\/d\//.test(new URL(page.url()).pathname),
    "signing back in returns to a canvas",
  );

  await page.close();
};

export const noUpsells = {
  name: "no links out to the hosted product",
  run: async ({ browser, base }) => {
    const page = await newPage(browser);
    await signIn(page, base);

    const offenders = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href") ?? "")
        .filter((href) =>
          /excalidraw\.com|plus\.excalidraw|github\.com|discord|x\.com|youtube/i.test(
            href,
          ),
        );
      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .map((b) => b.textContent?.trim() ?? "")
        .filter((text) => /excalidraw\+|sign ?up|share/i.test(text));
      return { links, buttons };
    });

    check(
      offenders.links.length === 0,
      "no outbound links to excalidraw.com or socials",
      JSON.stringify(offenders.links),
    );
    check(
      offenders.buttons.length === 0,
      "no Excalidraw+ / Sign up / Share buttons",
      JSON.stringify(offenders.buttons),
    );

    await page.close();
  },
};
