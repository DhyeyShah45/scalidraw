import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Chrome for Testing, downloaded by puppeteer rather than installed system
 * wide. `npx puppeteer browsers install chrome` puts it here.
 */
export const findChrome = () => {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (!fs.existsSync(cache)) {
    throw new Error(
      "No Chrome found. Run: npx puppeteer browsers install chrome\n" +
        "(or set CHROME_PATH to an existing Chromium binary)",
    );
  }
  for (const build of fs.readdirSync(cache).sort().reverse()) {
    const binary = path.join(cache, build, "chrome-linux64", "chrome");
    if (fs.existsSync(binary)) {
      return binary;
    }
    const mac = path.join(
      cache,
      build,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    if (fs.existsSync(mac)) {
      return mac;
    }
  }
  throw new Error(`No Chrome binary under ${cache}`);
};

export const PASSWORD = "e2e-test-password-1234";

/**
 * Boots a real server against a throwaway database and a real Chrome against
 * the production build. Everything is torn down by `stop()`.
 */
export const startStack = async ({ port = 3399 } = {}) => {
  const build = path.join(ROOT, "excalidraw-app", "build", "index.html");
  if (!fs.existsSync(build)) {
    throw new Error("No frontend build. Run: corepack yarn build:app");
  }
  const entry = path.join(ROOT, "server", "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("No server build. Run: corepack yarn build:server");
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scalidraw-e2e-"));
  const hash = execFileSync(
    process.execPath,
    [path.join(ROOT, "server", "dist", "hash-password.js")],
    // stdio[2] ignored: the tool prompts on stderr, which is noise here.
    {
      input: `${PASSWORD}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    },
  )
    .trim()
    .replace(/^AUTH_PASSWORD_HASH=/, "");

  const server = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      AUTH_PASSWORD_HASH: hash,
      DATA_DIR: dataDir,
      PORT: String(port),
      COOKIE_SECURE: "false",
      STATIC_DIR: path.join(ROOT, "excalidraw-app", "build"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  /*
   * These pipes MUST be drained. Fastify logs a line per request, and an
   * undrained pipe fills its 64KB buffer and then blocks the server's next
   * write — the whole suite deadlocks partway through with no output.
   */
  const log = [];
  const collect = (chunk) => {
    log.push(chunk.toString());
    if (log.length > 500) {
      log.splice(0, log.length - 500);
    }
  };
  server.stdout.on("data", collect);
  server.stderr.on("data", collect);
  server.serverLog = () => log.join("");

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, server);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: process.env.E2E_HEADED ? false : "shell",
    // The default 180s is not generous enough when two tabs are both saving.
    protocolTimeout: 300_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1400, height: 900 },
  });

  return {
    base,
    browser,
    dataDir,
    stop: async () => {
      await browser.close().catch(() => {});
      server.kill("SIGTERM");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const waitForHealth = async (base, server) => {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) {
      throw new Error(
        `server exited early with code ${server.exitCode}\n${
          server.serverLog?.() ?? ""
        }`,
      );
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in 30s");
};

export const newPage = async (browser) => {
  const page = await browser.newPage();

  /*
   * Without this only one page at a time is considered focused, and a drag
   * dispatched to any other page is quietly ignored — so in a two-tab test
   * whichever tab draws second appears to do nothing. That looks exactly like
   * an application bug and is not one.
   */
  const client = await page.createCDPSession();
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // 401s before sign-in and the unload-permission notice are expected noise.
  page.realErrors = () =>
    errors.filter((e) => !/401|unload is not allowed/.test(e));
  return page;
};

export const signIn = async (page, base) => {
  await page.goto(base, { waitUntil: "networkidle2" });
  // Suites get their own browser context, but a suite may sign in more than
  // once; tolerate an already-live session rather than hanging on a login
  // screen that will never appear.
  if (await page.$(".excalidraw")) {
    await page.waitForFunction(() => location.pathname.startsWith("/d/"), {
      timeout: 30000,
    });
    return;
  }
  await page.waitForSelector("#workspace-password", { timeout: 30000 });
  await page.type("#workspace-password", PASSWORD);
  await page.click(".workspace-login__submit");
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  await page.waitForFunction(() => location.pathname.startsWith("/d/"), {
    timeout: 30000,
  });
};

export const drawRect = async (page, x, y, w = 120, h = 90) => {
  // Chrome throttles background tabs, and Excalidraw's canvas work is driven
  // by requestAnimationFrame — a drag dispatched to a backgrounded page can
  // simply never be processed. Multi-tab tests must foreground first.
  await page.bringToFront();
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w, y + h, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
};

/** Reads a document straight from the API, using the page's session cookie. */
export const sceneOf = (page, id) =>
  page.evaluate(
    async (docId) =>
      (
        await fetch(`/api/documents/${docId}/scene`, {
          credentials: "same-origin",
        })
      ).json(),
    id,
  );

export const openDocsTab = async (page) => {
  if (!(await page.$('button[title="Canvases"]'))) {
    await page.click('button[title="Library"]');
    await page.waitForSelector('button[title="Canvases"]', { timeout: 15000 });
  }
  await page.click('button[title="Canvases"]');
  await page.waitForSelector(".workspace-docs", { timeout: 15000 });
};

export const docId = (page) => new URL(page.url()).pathname.split("/")[2];

/**
 * Open a brand-new canvas and wait for the editor to settle on it.
 *
 * Browser contexts are isolated per suite but the server database is shared,
 * so signing in lands on whatever document another suite touched most
 * recently. Suites that count elements need to start from a known-empty one.
 */
export const openFreshDocument = async (page, base, name) => {
  const id = await page.evaluate(async (docName) => {
    const response = await fetch("/api/documents", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: docName }),
    });
    return (await response.json()).document.id;
  }, name);

  await page.goto(`${base}/d/${id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw", { timeout: 60000 });
  await settle(1500);
  return id;
};
export const settle = (ms = 1800) => new Promise((r) => setTimeout(r, ms));

// --- tiny assertion helpers, so a failing run exits non-zero -----------------

let failures = 0;
export const check = (condition, label, detail) => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
export const failureCount = () => failures;
