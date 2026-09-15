import {
  check,
  newPage,
  openDocsTab,
  openFreshDocument,
  settle,
  signIn,
} from "../harness.mjs";

export const name = "renaming a canvas";

export const run = async ({ browser, base }) => {
  const page = await newPage(browser);
  await signIn(page, base);
  const id = await openFreshDocument(page, base, "Before rename");

  const meta = async () =>
    page.evaluate(
      async (docId) =>
        (
          await fetch(`/api/documents/${docId}`, { credentials: "same-origin" })
        ).json(),
      id,
    );

  await openDocsTab(page);
  const row = await page.$(
    ".workspace-docs__row.is-open .workspace-docs__name",
  );
  check(!!row, "the open canvas is highlighted in the sidebar");

  await row.click({ clickCount: 2 });
  await page.waitForSelector(".workspace-docs__rename", { timeout: 10000 });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.type(".workspace-docs__rename", "Sprint planning");
  await page.keyboard.press("Enter");
  await settle(2500);

  check(
    (await meta()).document.name === "Sprint planning",
    "double-clicking the name renames the canvas",
    (await meta()).document.name,
  );
  check(
    (
      await page.$$eval(".workspace-docs__name", (n) =>
        n.map((x) => x.textContent),
      )
    ).includes("Sprint planning"),
    "the sidebar shows the new name",
  );

  // Escape must abandon the edit rather than commit a half-typed name.
  const row2 = await page.$(
    ".workspace-docs__row.is-open .workspace-docs__name",
  );
  await row2.click({ clickCount: 2 });
  await page.waitForSelector(".workspace-docs__rename", { timeout: 10000 });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.type(".workspace-docs__rename", "half-typed name");
  await page.keyboard.press("Escape");
  await settle(2000);

  check(
    (await meta()).document.name === "Sprint planning",
    "Escape cancels the rename instead of saving it",
    (await meta()).document.name,
  );

  // The id is stable across renames — it is what the URL points at.
  check(
    new URL(page.url()).pathname === `/d/${id}`,
    "renaming does not change the URL",
    page.url(),
  );

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  await settle(1500);
  check(
    (await meta()).document.name === "Sprint planning",
    "the new name survives a reload",
  );

  await page.close();
};
