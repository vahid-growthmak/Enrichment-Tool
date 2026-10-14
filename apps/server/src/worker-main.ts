import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { createQueue, createRedis } from "./queue/queue.js";
import { createWorker } from "./queue/worker.js";

async function main() {
  const cfg = loadConfig();
  await runMigrations(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, log: (m) => logger.info(m) });
  const { db, pool } = createDb({ connectionString: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, max: cfg.DATABASE_POOL_MAX });
  const redis = createRedis(cfg.REDIS_URL);
  const queue = createQueue(redis);
  const worker = createWorker({ cfg, db, redis, queue, log: logger });
  logger.info(
    { concurrency: cfg.WORKER_CONCURRENCY, apollo: cfg.apolloEnabled, fullenrich: cfg.fullEnrichEnabled, apolloBase: cfg.APOLLO_BASE_URL, fullenrichBase: cfg.FULLENRICH_BASE_URL },
    "worker started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    await worker.close();
    await queue.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
