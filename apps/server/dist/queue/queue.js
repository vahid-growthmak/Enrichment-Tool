import { Queue } from "bullmq";
import { Redis } from "ioredis";
export const ENRICH_QUEUE = "enrichment";
export function createRedis(url) {
    return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}
export function createQueue(connection) {
    return new Queue(ENRICH_QUEUE, {
        connection,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: { age: 3600, count: 5000 },
            removeOnFail: { age: 24 * 3600, count: 5000 },
        },
    });
}
export async function enqueueEnrich(queue, data, opts = {}) {
    const jobOpts = { delay: opts.delayMs ?? 0, priority: opts.priority ?? 10 };
    return queue.add("enrich", { type: "enrich", data }, jobOpts);
}
export async function enqueueEnrichMany(queue, items) {
    const chunk = 500;
    for (let i = 0; i < items.length; i += chunk) {
        await queue.addBulk(items.slice(i, i + chunk).map((data) => ({ name: "enrich", data: { type: "enrich", data }, opts: { priority: 20 } })));
    }
}
export async function enqueueBatchDispatch(queue, batchId) {
    return queue.add("dispatch_batch", { type: "dispatch_batch", batchId }, { jobId: `dispatch-${batchId}`, priority: 1 });
}
//# sourceMappingURL=queue.js.map