import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { loadConfig } from "../src/config";

import { openDatabase } from "../src/db";

import type { Config } from "../src/config";
import type { FastifyInstance } from "fastify";
import type { DB } from "../src/db";

export const TEST_PASSWORD = "correct-horse-battery-staple";

// argon2 is deliberately slow; hashing once per process keeps the suite quick
// without weakening what is actually under test (the verify path).
let cachedHash: Promise<string> | null = null;
const testPasswordHash = () => {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
};

export type Harness = {
  app: FastifyInstance;
  db: DB;
  config: Config;
  /** Session cookie for an already-logged-in client. */
  auth: () => Promise<{ [key: string]: string }>;
  close: () => Promise<void>;
};

export const createHarness = async (
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<Harness> => {
  const config = loadConfig({
    AUTH_PASSWORD_HASH: await testPasswordHash(),
    COOKIE_SECURE: "false",
    DATA_DIR: "./.tmp-test",
    ...overrides,
  } as NodeJS.ProcessEnv);

  const db = openDatabase(":memory:");
  const app = await buildApp({ db, config });
  await app.ready();

  let cookies: { [key: string]: string } | null = null;

  return {
    app,
    db,
    config,
    auth: async () => {
      if (!cookies) {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: TEST_PASSWORD },
        });
        if (response.statusCode !== 200) {
          throw new Error(
            `login failed: ${response.statusCode} ${response.body}`,
          );
        }
        cookies = { scalidraw_session: response.cookies[0]!.value };
      }
      return cookies;
    },
    close: async () => {
      await app.close();
      db.close();
    },
  };
};

/** A 1x1 transparent PNG, as a dataURL. */
export const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const makeElement = (id: string) => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  version: 1,
});
