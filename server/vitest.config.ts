import { defineConfig } from "vitest/config";

// The server is plain Node — it must not inherit the repo-root jsdom setup,
// which is why this workspace carries its own config and the root config
// excludes `server/**`.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // SQLite temp files + a shared port-less inject() surface; serial is plenty
    // fast here and avoids cross-test DB interference.
    fileParallelism: false,
  },
});
