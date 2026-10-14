import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import pino from "pino";
import { buildApp } from "../../src/api/app.js";
import { loadConfig, resetConfig, type Config } from "../../src/config.js";
import { createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { buildMockProviders } from "../../src/mock/providers-server.js";
import { createQueue, createRedis, type EnrichQueue } from "../../src/queue/queue.js";
import { createWorker } from "../../src/queue/worker.js";

export interface Harness {
  cfg: Config;
  db: Db;
  app: FastifyInstance;
  mock: FastifyInstance;
  queue: EnrichQueue;
  worker: Worker;
  mockCalls(): Promise<Record<string, number>>;
  resetMock(): Promise<void>;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

function loadEnvTest() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.test");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

export async function createHarness(over: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> {
  loadEnvTest();
  resetConfig();
  const cfg = loadConfig({ ...process.env, ...over });
  await runMigrations(cfg.DATABASE_URL);
  const { db, pool } = createDb({ connectionString: cfg.DATABASE_URL, max: 10 });
  const redis = createRedis(cfg.REDIS_URL);
  const queue = createQueue(redis);
  await queue.obliterate({ force: true }).catch(() => {});
  await redis.flushdb();
  const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });
  const mock = buildMockProviders({ latencyMs: 0 });
  await mock.listen({ port: Number(new URL(cfg.APOLLO_BASE_URL).port), host: "127.0.0.1" });
  const app = await buildApp({ cfg, db, redis, queue, log });
  await app.ready();
  const worker = createWorker({ cfg, db, redis: createRedis(cfg.REDIS_URL), queue, log });

  const truncate = async () => {
    // Make sure no job from a previous test is still touching rows we are about to delete.
    await queue.drain(true);
    await waitFor(async () => ((await queue.getActiveCount()) === 0 ? true : null), { label: "queue idle", timeoutMs: 30_000, intervalMs: 100 });
    await queue.drain(true);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("batch_items").execute();
      await trx.deleteFrom("batches").execute();
      await trx.deleteFrom("provider_events").execute();
      await trx.deleteFrom("enrichment_attempts").execute();
      await trx.deleteFrom("profile_phones").execute();
      await trx.deleteFrom("profile_emails").execute();
      await trx.deleteFrom("profiles").execute();
    });
  };

  return {
    cfg,
    db,
    app,
    mock,
    queue,
    worker,
    mockCalls: async () => (JSON.parse((await mock.inject({ method: "GET", url: "/__mock/calls" })).body) as { calls: Record<string, number> }).calls,
    resetMock: async () => void (await mock.inject({ method: "POST", url: "/__mock/reset" })),
    truncate,
    close: async () => {
      await worker.close();
      await queue.close();
      await app.close();
      await mock.close();
      await redis.quit();
      await pool.end();
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${opts.label ?? "condition"}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 200));
  }
}

export const TERMINAL = new Set(["mobile_found", "mobile_missing", "failed"]);
