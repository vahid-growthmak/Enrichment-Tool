import { createHmac, timingSafeEqual } from "node:crypto";
/**
 * Inbound provider webhooks. The waterfall itself polls, so webhooks are an
 * audit trail and a fast path, never a hard dependency. Every event is stored
 * raw and idempotently in provider_events.
 */
export async function webhookRoutes(root, ctx) {
    // Encapsulated plugin: the raw-body parser must not leak into the JSON API routes.
    await root.register(async (app) => {
        app.removeAllContentTypeParsers();
        app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
        app.post("/webhooks/fullenrich", { config: { public: true } }, async (req, reply) => {
            if (ctx.cfg.WEBHOOK_SECRET) {
                const token = req.query.token ?? "";
                if (token !== ctx.cfg.WEBHOOK_SECRET)
                    return reply.code(401).send({ error: "invalid token" });
            }
            const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
            const sig = req.headers["x-signature-sha1"];
            if (ctx.cfg.FULLENRICH_API_KEY && typeof sig === "string" && sig) {
                const expected = createHmac("sha1", ctx.cfg.FULLENRICH_API_KEY).update(raw).digest("hex");
                const ok = expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig.toLowerCase()));
                if (!ok)
                    return reply.code(401).send({ error: "bad signature" });
            }
            let payload;
            try {
                payload = JSON.parse(raw.toString("utf8"));
            }
            catch {
                return reply.code(400).send({ error: "invalid json" });
            }
            const id = typeof payload.id === "string" ? payload.id : null;
            const status = typeof payload.status === "string" ? payload.status : "";
            await ctx.db
                .insertInto("provider_events")
                .values({
                provider: "fullenrich",
                external_request_id: id,
                event_key: id ? `${id}:${status}:${raw.length}` : null,
                headers: JSON.stringify({ "x-signature-sha1": sig ?? null, "user-agent": req.headers["user-agent"] ?? null }),
                payload: JSON.stringify(payload),
            })
                .onConflict((oc) => oc.columns(["provider", "event_key"]).doNothing())
                .execute();
            if (id) {
                // Let the pending poll job pick it up on its next tick (it is at most one poll interval away).
                await ctx.db.updateTable("enrichment_attempts").set({ next_poll_at: new Date() }).where("provider", "=", "fullenrich").where("external_request_id", "=", id).where("status", "=", "polling").execute();
            }
            return reply.code(200).send({ received: true });
        });
    });
}
//# sourceMappingURL=webhooks.js.map