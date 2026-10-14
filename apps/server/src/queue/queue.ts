import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { EnrichJobData } from "../enrichment/waterfall.js";

export const ENRICH_QUEUE = "enrichment";

export type QueueJob = { type: "enrich"; data: EnrichJobData } | { type: "dispatch_batch"; batchId: string };

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export function createQueue(connection: Redis) {
  return new Queue<QueueJob>(ENRICH_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 24 * 3600, count: 5000 },
    },
  });
}

export type EnrichQueue = ReturnType<typeof createQueue>;

export async function enqueueEnrich(queue: EnrichQueue, data: EnrichJobData, opts: { delayMs?: number; priority?: number } = {}) {
  const jobOpts: JobsOptions = { delay: opts.delayMs ?? 0, priority: opts.priority ?? 10 };
  return queue.add("enrich", { type: "enrich", data }, jobOpts);
}

export async function enqueueEnrichMany(queue: EnrichQueue, items: EnrichJobData[]) {
  const chunk = 500;
  for (let i = 0; i < items.length; i += chunk) {
    await queue.addBulk(items.slice(i, i + chunk).map((data) => ({ name: "enrich", data: { type: "enrich" as const, data }, opts: { priority: 20 } })));
  }
}

export async function enqueueBatchDispatch(queue: EnrichQueue, batchId: string) {
  return queue.add("dispatch_batch", { type: "dispatch_batch", batchId }, { jobId: `dispatch-${batchId}`, priority: 1 });
}
