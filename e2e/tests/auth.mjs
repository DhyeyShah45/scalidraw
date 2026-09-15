import { check, newPage, signIn, PASSWORD } from "../harness.mjs";

export const name = "sign-in";

export const run = async ({ browser, base }) => {
  const page = await newPage(browser);

  await page.goto(base, { waitUntil: "networkidle2" });
  check(
    !!(await page.$("#workspace-password")),
    "login screen shown when signed out",
  );

  // The editor must not mount for a signed-out user, or it starts autosaving
  // into a queue the login screen has no way to surface.
  check(
    !(await page.$(".excalidraw")),
    "editor is not mounted behind the login screen",
  );

  await page.type("#workspace-password", "wrong-password");
  await page.click(".workspace-login__submit");
  await page.waitForSelector(".workspace-login__error", { timeout: 20000 });
  // Regression: FilledButton renders type="button", so relying on form submit
  // left this button inert and only the Enter key worked.
  check(true, "the sign-in button actually submits");

  await page.evaluate(
    () => (document.querySelector("#workspace-password").value = ""),
  );
  await signIn(page, base);
  check(
    /^\/d\/[A-Za-z0-9_-]+$/.test(new URL(page.url()).pathname),
    "signing in lands on a document route",
    page.url(),
  );

  // Enter should work too, for anyone who never touches the button.
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await page.goto(base, { waitUntil: "networkidle2" });
  await page.waitForSelector("#workspace-password");
  await page.type("#workspace-password", PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  check(true, "pressing Enter in the password field signs in");

  await page.close();
};
