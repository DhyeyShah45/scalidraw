import {
  check,
  docId,
  drawRect,
  newPage,
  openDocsTab,
  sceneOf,
  settle,
  signIn,
} from "../harness.mjs";

export const name = "documents, switching and undo isolation";

export const run = async ({ browser, base }) => {
  const page = await newPage(browser);
  await signIn(page, base);
  const docA = docId(page);

  await drawRect(page, 420, 300);
  await settle();
  const a = await sceneOf(page, docA);
  check(a.elements.length === 1, "drawing autosaves to the server");
  const idA = a.elements[0]?.id;

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  await settle(1000);
  check((await sceneOf(page, docA)).elements.length === 1, "survives a reload");
  check(docId(page) === docA, "a hard refresh stays on the same document");

  await openDocsTab(page);
  check(
    (await page.$$(".workspace-docs__row")).length >= 1,
    "the canvas is listed in the sidebar",
  );

  await page.click(".workspace-docs__new");
  await page.waitForFunction((p) => !location.pathname.endsWith(p), {}, docA);
  await settle(1200);
  const docB = docId(page);
  check(docB !== docA, "creating a canvas navigates to it");
  check(
    (await sceneOf(page, docB)).elements.length === 0,
    "a new canvas starts empty",
  );

  await drawRect(page, 700, 420, 140, 100);
  await settle();
  const b0 = await sceneOf(page, docB);
  check(b0.elements.length === 1, "drawing in the second canvas saves to it");
  check(b0.elements[0]?.id !== idA, "the two canvases hold different elements");

  /*
   * The reason switching remounts the editor (D15). History entries are
   * inverse deltas, not snapshots, so with in-place element swapping an undo
   * in B would delete B's elements and resurrect A's. This is the check that
   * decision exists to satisfy.
   */
  for (let i = 0; i < 8; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Control");
  }
  await settle();

  const bIds = (await sceneOf(page, docB)).elements
    .filter((e) => !e.isDeleted)
    .map((e) => e.id);
  check(
    !bIds.includes(idA),
    "undo in B does not resurrect A's element",
    JSON.stringify(bIds),
  );

  const aIds = (await sceneOf(page, docA)).elements
    .filter((e) => !e.isDeleted)
    .map((e) => e.id);
  check(
    aIds.includes(idA),
    "undo in B does not delete A's element",
    JSON.stringify(aIds),
  );

  await openDocsTab(page);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".workspace-docs__row")];
    rows
      .find((r) => !r.classList.contains("is-open"))
      ?.querySelector(".workspace-docs__main")
      ?.click();
  });
  await page.waitForFunction((p) => !location.pathname.endsWith(p), {}, docB);
  await settle(1200);
  check(docId(page) === docA, "switching back returns to the first canvas");

  await page.goBack({ waitUntil: "domcontentloaded" });
  await settle(1200);
  check(docId(page) === docB, "browser Back moves between canvases");

  check(
    page.realErrors().length === 0,
    "no console errors",
    JSON.stringify(page.realErrors().slice(0, 3)),
  );
  await page.close();
};
