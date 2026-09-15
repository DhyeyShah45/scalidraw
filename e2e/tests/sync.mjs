import {
  check,
  drawRect,
  newPage,
  openFreshDocument,
  sceneOf,
  settle,
  signIn,
} from "../harness.mjs";

export const name = "offline queue and conflicts";

export const run = async ({ browser, base }) => {
  const page = await newPage(browser);
  await signIn(page, base);
  const id = await openFreshDocument(page, base, "offline test");

  await drawRect(page, 300, 260);
  await settle();
  const before = (await sceneOf(page, id)).document.version;

  // --- offline -------------------------------------------------------------
  await page.setOfflineMode(true);
  await drawRect(page, 520, 260);
  await settle();

  const pill = await page.$(".workspace-sync");
  check(!!pill, "a sync indicator appears while offline");
  const pillText = pill ? await page.evaluate((n) => n.textContent, pill) : "";
  check(
    /not uploaded/i.test(pillText),
    "it says work is not uploaded",
    pillText,
  );

  await page.setOfflineMode(false);
  // The store retries on the `online` event; give it a moment.
  await settle(3000);

  const after = await sceneOf(page, id);
  check(
    after.document.version > before,
    "the queued drawing uploads on reconnect",
    `v${before} -> v${after.document.version}`,
  );
  check(after.elements.length === 2, "both shapes made it to the server");

  // --- offline across a reload --------------------------------------------
  await page.setOfflineMode(true);
  await drawRect(page, 760, 260);
  await settle();
  await page.setOfflineMode(false);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  await settle(3000);
  const afterReload = await sceneOf(page, id);
  check(
    afterReload.elements.length === 3,
    "a drawing queued offline survives a reload and still uploads",
    `${afterReload.elements.length} elements`,
  );

  await page.close();

  // --- two tabs on the same canvas (phase 4) -------------------------------
  const one = await newPage(browser);
  const two = await newPage(browser);
  await signIn(one, base);
  const shared = await openFreshDocument(one, base, "two tab test");
  await two.goto(`${base}/d/${shared}`, { waitUntil: "networkidle2" });
  await two.waitForSelector(".excalidraw", { timeout: 60000 });
  await settle(1500);

  await drawRect(one, 340, 420);
  await settle(2500);
  await drawRect(two, 640, 420);
  await settle(3000);

  const prompt = await two.$(".workspace-conflict");
  const promptOne = await one.$(".workspace-conflict");
  check(
    !!prompt || !!promptOne,
    "two tabs on one canvas raise the conflict prompt rather than clobbering",
  );

  const target = prompt ? two : one;
  if (prompt || promptOne) {
    await target.click(".workspace-conflict__actions button");
    await settle(2500);
    check(
      !(await target.$(".workspace-conflict")),
      "choosing a resolution dismisses the prompt",
    );
  }

  await one.close();
  await two.close();
};
