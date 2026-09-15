/**
 * End-to-end checks against a real Chrome and a real server.
 *
 *   corepack yarn build:app && corepack yarn build:server
 *   corepack yarn test:e2e
 *
 * These cover what unit tests structurally cannot: that the UI is wired up and
 * clickable. Two shipped bugs were invisible to 2000 passing unit tests and
 * obvious on the first real page load — a sign-in button that never submitted,
 * and a password field styled with variables that do not exist outside the
 * editor, so it rendered invisible.
 */
import { failureCount, startStack } from "./harness.mjs";

import * as auth from "./tests/auth.mjs";
import * as documents from "./tests/documents.mjs";
import * as sync from "./tests/sync.mjs";

const ALL = { auth, documents, sync };

const only = process.argv[2];
const suites = Object.entries(ALL)
  .filter(
    ([key, suite]) => !only || key.includes(only) || suite.name.includes(only),
  )
  .map(([, suite]) => suite);

if (suites.length === 0) {
  // A filter that matches nothing must not report success — that is exactly
  // the kind of false green a test runner should never produce.
  console.error(
    `No suite matches "${only}". Available: ${Object.keys(ALL).join(", ")}`,
  );
  process.exit(1);
}

const stack = await startStack();
console.log(`serving ${stack.base}\n`);

let threw = false;

for (const suite of suites) {
  console.log(`— ${suite.name} —`);
  // A fresh browser context per suite: cookies, localStorage and IndexedDB are
  // all per-context, and a leaked session made one suite's sign-in silently
  // depend on another's.
  const context = await stack.browser.createBrowserContext();
  try {
    await suite.run({ ...stack, browser: context });
  } catch (error) {
    threw = true;
    console.log(`  ERROR ${suite.name}: ${error.message}`);
  } finally {
    await context.close().catch(() => {});
  }
  console.log("");
}

await stack.stop();

const failed = failureCount();
if (failed === 0 && !threw) {
  console.log("all checks passed");
} else {
  console.log(
    `${failed} check(s) failed${threw ? ", and at least one suite threw" : ""}`,
  );
  process.exitCode = 1;
}
