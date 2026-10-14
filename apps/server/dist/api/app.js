import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { createAuth } from "./auth.js";
import { batchRoutes } from "./routes/batches.js";
import { enrichRoutes } from "./routes/enrich.js";
import { profileRoutes } from "./routes/profiles.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { HttpError } from "../lib/errors.js";
export async function buildApp(ctx) {
    const app = Fastify({
        logger: false,
        bodyLimit: 2 * 1024 * 1024,
        trustProxy: true,
        requestIdHeader: "x-request-id",
    });
    await app.register(cors, {
        origin: ctx.cfg.CORS_ORIGIN.split(",").map((s) => s.trim()),
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
    });
    await app.register(multipart, { limits: { fileSize: ctx.cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });
    const authenticate = createAuth(ctx.cfg);
    app.addHook("onRequest", async (req, reply) => {
        if (req.routeOptions.config.public || req.method === "OPTIONS")
            return;
        await authenticate(req, reply);
    });
    app.addHook("onResponse", async (req, reply) => {
        if (req.url === "/health")
            return;
        ctx.log.debug({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
    });
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof HttpError) {
            return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details ?? undefined });
        }
        const e = err;
        if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413) {
            return reply.code(413).send({ error: "too_large", message: `File is larger than the ${ctx.cfg.MAX_UPLOAD_MB} MB limit.` });
        }
        if (e.statusCode && e.statusCode < 500) {
            return reply.code(e.statusCode).send({ error: e.code ?? "bad_request", message: e.message });
        }
        ctx.log.error({ err: e, url: req.url, method: req.method }, "unhandled error");
        return reply.code(500).send({ error: "internal", message: "Something went wrong on our side. Please try again." });
    });
    app.get("/health", { config: { public: true } }, async () => {
        const checks = {};
        try {
            await ctx.db.selectFrom("profiles").select("id").limit(1).execute();
            checks.database = "ok";
        }
        catch {
            checks.database = "error";
        }
        try {
            await ctx.redis.ping();
            checks.redis = "ok";
        }
        catch {
            checks.redis = "error";
        }
        const ok = Object.values(checks).every((v) => v === "ok");
        return {
            status: ok ? "ok" : "degraded",
            checks,
            providers: { apollo: ctx.cfg.apolloEnabled, fullenrich: ctx.cfg.fullEnrichEnabled },
            time: new Date().toISOString(),
        };
    });
    app.get("/api/v1/me", async (req) => ({ user: req.user, config: { providers: { apollo: ctx.cfg.apolloEnabled, fullenrich: ctx.cfg.fullEnrichEnabled }, cooldownDays: ctx.cfg.MOBILE_MISSING_COOLDOWN_DAYS, maxBatchRows: ctx.cfg.MAX_BATCH_ROWS, maxUploadMb: ctx.cfg.MAX_UPLOAD_MB } }));
    await enrichRoutes(app, ctx);
    await profileRoutes(app, ctx);
    await batchRoutes(app, ctx);
    await webhookRoutes(app, ctx);
    return app;
}
//# sourceMappingURL=app.js.map