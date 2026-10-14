import { buildApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { createQueue, createRedis } from "./queue/queue.js";
async function main() {
    const cfg = loadConfig();
    await runMigrations(cfg.DATABASE_URL, { ssl: cfg.DATABASE_SSL, log: (m) => logger.info(m) });
    const { db, pool } = createDb({ connectionString: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, max: cfg.DATABASE_POOL_MAX });
    const redis = createRedis(cfg.REDIS_URL);
    const queue = createQueue(redis);
    const app = await buildApp({ cfg, db, redis, queue, log: logger });
    await app.listen({ port: cfg.PORT, host: cfg.HOST });
    logger.info({ port: cfg.PORT, auth: cfg.AUTH_DISABLED ? "disabled" : "supabase", apollo: cfg.apolloEnabled, fullenrich: cfg.fullEnrichEnabled }, "api listening");
    const shutdown = async (signal) => {
        logger.info({ signal }, "api shutting down");
        await app.close();
        await queue.close();
        await redis.quit();
        await pool.end();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
main().catch((err) => {
    logger.fatal({ err }, "api failed to start");
    process.exit(1);
});
//# sourceMappingURL=main.js.map