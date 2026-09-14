import { ConfigError, loadConfig } from "./config";
import { databasePath, openDatabase } from "./db";
import { buildApp } from "./app";

const main = async () => {
  const config = loadConfig();
  const db = openDatabase(databasePath(config.dataDir));
  const app = await buildApp({ db, config, logger: true });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
};

main().catch((error) => {
  if (error instanceof ConfigError) {
    // eslint-disable-next-line no-console
    console.error(`Configuration error: ${error.message}`);
    process.exit(78); // EX_CONFIG
  }
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
