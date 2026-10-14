import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { decideCache } from "../../enrichment/policy.js";
import { upsertProfile } from "../../enrichment/repository.js";
import { initialJob } from "../../enrichment/waterfall.js";
import { badRequest } from "../../lib/errors.js";
import { canonicalizeLinkedInUrl } from "../../lib/linkedin-url.js";
import { enqueueEnrich } from "../../queue/queue.js";
import { serializeProfile } from "../serializers.js";

const bodySchema = z.object({
  linkedinUrl: z.string().min(1, "linkedinUrl is required").max(2048),
  firstName: z.string().max(200).optional().nullable(),
  lastName: z.string().max(200).optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  force: z.boolean().optional().default(false),
});

export async function enrichRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * Single enrichment. Returns immediately from the cache when possible;
   * otherwise queues the waterfall and returns the profile to poll.
   */
  app.post("/api/v1/enrich/single", async (req) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "invalid body", parsed.error.flatten());
    const body = parsed.data;

    const canon = canonicalizeLinkedInUrl(body.linkedinUrl);
    if (!canon.ok) throw badRequest(`Not a valid LinkedIn profile URL: ${canon.reason}`);

    const profile = await upsertProfile(ctx.db, canon.value, { firstName: body.firstName, lastName: body.lastName, company: body.company });

    if (profile.enrichment_status === "in_progress" && profile.lock_token && !isStale(profile.locked_at, ctx.cfg.LOCK_STALE_MINUTES)) {
      return { result: "in_progress", cached: false, profile: serializeProfile(profile) };
    }

    const decision = decideCache(profile, ctx.cfg, body.force);
    if (decision.kind === "hit_mobile") return { result: "mobile_found", cached: true, profile: serializeProfile(profile) };
    if (decision.kind === "hit_missing") {
      return { result: "mobile_missing", cached: true, retryAfter: decision.retryAfter, profile: serializeProfile(profile) };
    }

    await enqueueEnrich(ctx.queue, initialJob(profile.id, { force: body.force }), { priority: 1 });
    ctx.log.info({ profileId: profile.id, url: canon.value.url, reason: decision.reason, user: req.user.email }, "single enrichment queued");
    return { result: "queued", cached: false, reason: decision.reason, profile: serializeProfile({ ...profile, enrichment_status: "in_progress" }) };
  });

  /** Validate + canonicalize a URL without doing anything (used by the UI as you type). */
  app.post("/api/v1/enrich/validate", async (req) => {
    const parsed = z.object({ linkedinUrl: z.string().max(2048) }).safeParse(req.body);
    if (!parsed.success) throw badRequest("linkedinUrl is required");
    const canon = canonicalizeLinkedInUrl(parsed.data.linkedinUrl);
    if (!canon.ok) return { valid: false, reason: canon.reason };
    const existing = await ctx.db.selectFrom("profiles").selectAll().where("linkedin_url", "=", canon.value.url).executeTakeFirst();
    return { valid: true, canonicalUrl: canon.value.url, kind: canon.value.kind, existing: existing ? serializeProfile(existing) : null };
  });
}

function isStale(lockedAt: Date | string | null, staleMinutes: number): boolean {
  if (!lockedAt) return true;
  return Date.now() - new Date(lockedAt).getTime() > staleMinutes * 60_000;
}
