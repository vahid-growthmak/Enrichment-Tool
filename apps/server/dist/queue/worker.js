import { Worker } from "bullmq";
import { initialJob, WaterfallEngine } from "../enrichment/waterfall.js";
import { RedisRateLimiter } from "../lib/rate-limiter.js";
import { createProviders } from "../providers/index.js";
import { ENRICH_QUEUE, enqueueEnrich, enqueueEnrichMany } from "./queue.js";
export function createEngine(deps) {
    const providers = deps.providers ?? createProviders(deps.cfg);
    const limiters = {
        apollo: new RedisRateLimiter(deps.redis, "ratelimit:apollo", deps.cfg.APOLLO_RATE_PER_MINUTE),
        fullenrich: new RedisRateLimiter(deps.redis, "ratelimit:fullenrich", deps.cfg.FULLENRICH_RATE_PER_MINUTE),
    };
    return new WaterfallEngine({ db: deps.db, cfg: deps.cfg, providers, limiters, log: deps.log });
}
export function createWorker(deps) {
    const engine = createEngine(deps);
    const { db, queue, log } = deps;
    const processor = async (job) => {
        const payload = job.data;
        if (payload.type === "dispatch_batch")
            return dispatchBatch(payload.batchId);
        const result = await engine.step(payload.data);
        if (result.next === "continue") {
            await enqueueEnrich(queue, result.data, { delayMs: result.delayMs, priority: payload.data.batchItemId ? 20 : 10 });
            return { continued: result.data.stage, delayMs: result.delayMs };
        }
        return { outcome: result.outcome };
    };
    async function dispatchBatch(batchId) {
        const batch = await db.selectFrom("batches").selectAll().where("id", "=", batchId).executeTakeFirst();
        if (!batch || batch.status === "cancelled")
            return { skipped: true };
        const pageSize = 1000;
        let lastRow = 0;
        let queued = 0;
        for (;;) {
            const items = await db
                .selectFrom("batch_items")
                .select(["id", "profile_id", "row_number"])
                .where("batch_id", "=", batchId)
                .where("status", "=", "pending")
                .where("row_number", ">", lastRow)
                .orderBy("row_number")
                .limit(pageSize)
                .execute();
            if (items.length === 0)
                break;
            const jobs = [];
            for (const it of items) {
                if (!it.profile_id)
                    continue;
                jobs.push(initialJob(it.profile_id, { batchItemId: it.id }));
            }
            await enqueueEnrichMany(queue, jobs);
            queued += jobs.length;
            lastRow = items[items.length - 1].row_number;
        }
        await db.updateTable("batches").set({ status: "processing", started_at: new Date() }).where("id", "=", batchId).where("status", "=", "queued").execute();
        log.info({ batchId, queued }, "batch dispatched");
        return { queued };
    }
    const worker = new Worker(ENRICH_QUEUE, processor, {
        connection: deps.redis,
        concurrency: deps.cfg.WORKER_CONCURRENCY,
        lockDuration: 120_000,
        stalledInterval: 60_000,
    });
    worker.on("failed", (job, err) => {
        log.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message, stack: err.stack }, "job failed");
        // After the final attempt, make sure the batch row does not stay stuck.
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1) && job.data.type === "enrich" && job.data.data.batchItemId) {
            const d = job.data.data;
            db.updateTable("batch_items")
                .set({ status: "failed", error: `internal error: ${err.message}`.slice(0, 1000), completed_at: new Date() })
                .where("id", "=", d.batchItemId)
                .where("status", "in", ["pending", "processing"])
                .execute()
                .catch((e) => log.error({ err: e }, "could not mark batch item failed"));
            db.updateTable("profiles")
                .set({ enrichment_status: "failed", last_error: err.message.slice(0, 500), lock_token: null, locked_at: null })
                .where("id", "=", d.profileId)
                .where("enrichment_status", "=", "in_progress")
                .execute()
                .catch((e) => log.error({ err: e }, "could not release profile lock"));
        }
    });
    worker.on("error", (err) => log.error({ err: err.message }, "worker error"));
    return worker;
}
//# sourceMappingURL=worker.js.map