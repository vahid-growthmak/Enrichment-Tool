import { sql } from "kysely";
import { z } from "zod";
import { decideCache } from "../../enrichment/policy.js";
import { initialJob } from "../../enrichment/waterfall.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { enqueueEnrich } from "../../queue/queue.js";
import { serializeAttempt, serializeEmail, serializePhone, serializeProfile } from "../serializers.js";
const listQuery = z.object({
    q: z.string().max(200).optional(),
    status: z.enum(["pending", "in_progress", "mobile_found", "mobile_missing", "failed"]).optional(),
    source: z.enum(["apollo", "fullenrich"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    sort: z.enum(["updated_at", "created_at", "full_name", "company_name"]).default("updated_at"),
    dir: z.enum(["asc", "desc"]).default("desc"),
});
export async function profileRoutes(app, ctx) {
    app.get("/api/v1/profiles", async (req) => {
        const q = listQuery.safeParse(req.query);
        if (!q.success)
            throw badRequest("invalid query", q.error.flatten());
        const { page, limit } = q.data;
        let base = ctx.db.selectFrom("profiles");
        if (q.data.status)
            base = base.where("enrichment_status", "=", q.data.status);
        if (q.data.source)
            base = base.where("mobile_source", "=", q.data.source);
        if (q.data.q) {
            const term = `%${q.data.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
            base = base.where((eb) => eb.or([
                eb("linkedin_url", "ilike", term),
                eb("full_name", "ilike", term),
                eb("company_name", "ilike", term),
                eb("work_email", "ilike", term),
                eb("mobile_number", "ilike", term),
                eb("job_title", "ilike", term),
            ]));
        }
        const countRow = await base.select(sql `count(*)`.as("count")).executeTakeFirst();
        const rows = await base
            .selectAll()
            .orderBy(q.data.sort, q.data.dir)
            .orderBy("id")
            .offset((page - 1) * limit)
            .limit(limit)
            .execute();
        return { items: rows.map(serializeProfile), page, limit, total: Number(countRow?.count ?? 0) };
    });
    app.get("/api/v1/profiles/:id", async (req) => {
        const { id } = req.params;
        if (!isUuid(id))
            throw notFound();
        const profile = await ctx.db.selectFrom("profiles").selectAll().where("id", "=", id).executeTakeFirst();
        if (!profile)
            throw notFound("Profile not found");
        const [phones, emails, attempts] = await Promise.all([
            ctx.db.selectFrom("profile_phones").selectAll().where("profile_id", "=", id).orderBy("is_mobile", "desc").orderBy("id").execute(),
            ctx.db.selectFrom("profile_emails").selectAll().where("profile_id", "=", id).orderBy("id").execute(),
            ctx.db.selectFrom("enrichment_attempts").selectAll().where("profile_id", "=", id).orderBy("submitted_at", "desc").limit(50).execute(),
        ]);
        return {
            profile: serializeProfile(profile),
            phones: phones.map(serializePhone),
            emails: emails.map(serializeEmail),
            attempts: attempts.map(serializeAttempt),
            cache: decideCache(profile, ctx.cfg),
        };
    });
    /** Force the waterfall to run again, ignoring cache and cooldown. */
    app.post("/api/v1/profiles/:id/re-enrich", async (req) => {
        const { id } = req.params;
        if (!isUuid(id))
            throw notFound();
        const profile = await ctx.db.selectFrom("profiles").selectAll().where("id", "=", id).executeTakeFirst();
        if (!profile)
            throw notFound("Profile not found");
        if (profile.enrichment_status === "in_progress" && profile.lock_token) {
            return { result: "in_progress", profile: serializeProfile(profile) };
        }
        await enqueueEnrich(ctx.queue, initialJob(profile.id, { force: true }), { priority: 1 });
        ctx.log.info({ profileId: id, user: req.user.email }, "forced re-enrichment queued");
        return { result: "queued", profile: serializeProfile({ ...profile, enrichment_status: "in_progress" }) };
    });
    app.get("/api/v1/stats", async () => {
        const [profiles] = await ctx.db
            .selectFrom("profiles")
            .select([
            sql `count(*)`.as("total"),
            sql `count(*) filter (where mobile_number is not null)`.as("with_mobile"),
            sql `count(*) filter (where enrichment_status = 'mobile_missing')`.as("mobile_missing"),
            sql `count(*) filter (where enrichment_status = 'in_progress')`.as("in_progress"),
            sql `count(*) filter (where enrichment_status = 'failed')`.as("failed"),
            sql `count(*) filter (where mobile_source = 'apollo')`.as("from_apollo"),
            sql `count(*) filter (where mobile_source = 'fullenrich')`.as("from_fullenrich"),
            sql `count(*) filter (where work_email is not null)`.as("with_email"),
            sql `count(*) filter (where mobile_found_at > now() - interval '7 days')`.as("mobiles_last_7d"),
        ])
            .execute();
        const [attempts] = await ctx.db
            .selectFrom("enrichment_attempts")
            .select([
            sql `count(*) filter (where provider = 'apollo')`.as("apollo_calls"),
            sql `count(*) filter (where provider = 'fullenrich')`.as("fullenrich_calls"),
            sql `coalesce(sum(credits_used) filter (where provider = 'apollo'), 0)`.as("apollo_credits"),
            sql `coalesce(sum(credits_used) filter (where provider = 'fullenrich'), 0)`.as("fullenrich_credits"),
            sql `count(*) filter (where submitted_at > now() - interval '24 hours')`.as("calls_last_24h"),
        ])
            .execute();
        const [batches] = await ctx.db
            .selectFrom("batches")
            .select([
            sql `count(*)`.as("total"),
            sql `count(*) filter (where status in ('queued','processing'))`.as("active"),
            sql `coalesce(sum(cached_count), 0)`.as("cached_rows"),
        ])
            .execute();
        const queueCounts = await ctx.queue.getJobCounts("waiting", "active", "delayed", "failed");
        return {
            profiles: {
                total: Number(profiles?.total ?? 0),
                withMobile: Number(profiles?.with_mobile ?? 0),
                mobileMissing: Number(profiles?.mobile_missing ?? 0),
                inProgress: Number(profiles?.in_progress ?? 0),
                failed: Number(profiles?.failed ?? 0),
                fromApollo: Number(profiles?.from_apollo ?? 0),
                fromFullEnrich: Number(profiles?.from_fullenrich ?? 0),
                withEmail: Number(profiles?.with_email ?? 0),
                mobilesLast7d: Number(profiles?.mobiles_last_7d ?? 0),
            },
            providers: {
                apolloCalls: Number(attempts?.apollo_calls ?? 0),
                fullEnrichCalls: Number(attempts?.fullenrich_calls ?? 0),
                apolloCredits: Number(attempts?.apollo_credits ?? 0),
                fullEnrichCredits: Number(attempts?.fullenrich_credits ?? 0),
                callsLast24h: Number(attempts?.calls_last_24h ?? 0),
                apolloEnabled: ctx.cfg.apolloEnabled,
                fullEnrichEnabled: ctx.cfg.fullEnrichEnabled,
            },
            batches: { total: Number(batches?.total ?? 0), active: Number(batches?.active ?? 0), cachedRows: Number(batches?.cached_rows ?? 0) },
            queue: queueCounts,
        };
    });
}
export function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
//# sourceMappingURL=profiles.js.map