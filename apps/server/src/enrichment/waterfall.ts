import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { EnrichmentAttempt, Profile, Provider } from "../db/types.js";
import { ProviderError } from "../lib/errors.js";
import type { Logger } from "../logger.js";
import type { RedisRateLimiter } from "../lib/rate-limiter.js";
import type { EnrichmentProvider, ProviderData } from "../providers/types.js";
import { decideCache } from "./policy.js";
import { applyProviderData, claimProfile, completeBatchItem, createAttempt, finalizeProfile, updateAttempt } from "./repository.js";

/**
 * Job payload. The waterfall is a small state machine; every step is one
 * short-lived queue job, and the next step is scheduled as a new (possibly
 * delayed) job. This keeps provider polling cheap and worker-crash safe.
 */
export interface EnrichJobData {
  profileId: string;
  batchItemId?: string | null;
  force?: boolean;
  stage: "start" | "provider" | "poll" | "await";
  providerIndex: number;
  attemptId?: string | null;
  lockToken?: string | null;
  /** number of providers that errored out (vs. answered "no mobile") */
  providerErrors: number;
  /** number of providers that completed with an answer */
  providerAnswers: number;
  submitRetries: number;
  awaitSince?: number | null;
  /** one line per layer, e.g. "apollo: no mobile", "fullenrich: credits_insufficient" */
  layerNotes?: string[];
}

export type StepResult = { next: "done"; outcome: string } | { next: "continue"; data: EnrichJobData; delayMs: number };

export interface EngineDeps {
  db: Db;
  cfg: Config;
  providers: EnrichmentProvider[];
  limiters: Record<Provider, RedisRateLimiter>;
  log: Logger;
}

const AWAIT_POLL_MS = 10_000;
const MAX_AWAIT_MS = 2 * 60 * 60 * 1000;

export function initialJob(profileId: string, opts: { batchItemId?: string | null; force?: boolean } = {}): EnrichJobData {
  return {
    profileId,
    batchItemId: opts.batchItemId ?? null,
    force: opts.force ?? false,
    stage: "start",
    providerIndex: 0,
    attemptId: null,
    lockToken: null,
    providerErrors: 0,
    providerAnswers: 0,
    submitRetries: 0,
    awaitSince: null,
    layerNotes: [],
  };
}

export class WaterfallEngine {
  constructor(private readonly d: EngineDeps) {}

  async step(data: EnrichJobData): Promise<StepResult> {
    switch (data.stage) {
      case "start":
        return this.start(data);
      case "provider":
        return this.runProvider(data);
      case "poll":
        return this.pollProvider(data);
      case "await":
        return this.awaitOther(data);
    }
  }

  // ---------------------------------------------------------------------------
  private async start(data: EnrichJobData): Promise<StepResult> {
    const { db, cfg, log } = this.d;
    const profile = await db.selectFrom("profiles").selectAll().where("id", "=", data.profileId).executeTakeFirst();
    if (!profile) {
      await this.markItem(data, "failed", null, "profile no longer exists");
      return { next: "done", outcome: "missing_profile" };
    }
    if (data.batchItemId && (await this.batchCancelled(data.batchItemId))) {
      await this.markItem(data, "cancelled", null, null);
      return { next: "done", outcome: "cancelled" };
    }
    if (data.batchItemId) {
      await db.updateTable("batch_items").set({ status: "processing", profile_id: profile.id }).where("id", "=", data.batchItemId).execute();
    }

    // Fast path: answer from the database (also protects against a job that
    // was queued before another one finished enriching the same profile).
    const decision = decideCache(profile, cfg, data.force);
    if (decision.kind === "hit_mobile") {
      await this.finish(data, null, { status: "mobile_found", source: "cache", enriched: false });
      return { next: "done", outcome: "cache_mobile" };
    }
    if (decision.kind === "hit_missing") {
      await this.finish(data, null, { status: "mobile_missing", source: "cache", enriched: false });
      return { next: "done", outcome: "cache_missing" };
    }

    const claim = await claimProfile(db, profile.id, cfg.LOCK_STALE_MINUTES);
    if (!claim) {
      log.info({ profileId: profile.id }, "profile locked by another worker; waiting for its result");
      return { next: "continue", data: { ...data, stage: "await", awaitSince: data.awaitSince ?? Date.now() }, delayMs: AWAIT_POLL_MS };
    }
    log.info({ profileId: profile.id, url: profile.linkedin_url, reason: decision.reason }, "waterfall start");
    return this.runProvider({ ...data, stage: "provider", providerIndex: 0, lockToken: claim.lockToken, submitRetries: 0 });
  }

  // ---------------------------------------------------------------------------
  private async runProvider(data: EnrichJobData): Promise<StepResult> {
    const { db, cfg, providers, limiters, log } = this.d;
    const provider = providers[data.providerIndex];
    if (!provider) return this.exhausted(data);

    if (!provider.enabled) {
      log.warn({ provider: provider.name }, "provider has no API key configured; skipping layer");
      return this.runProvider({ ...data, providerIndex: data.providerIndex + 1, submitRetries: 0 });
    }

    const gate = await limiters[provider.name].tryAcquire();
    if (!gate.ok) {
      log.debug({ provider: provider.name, retryInMs: gate.retryInMs }, "rate limit window full; deferring");
      return { next: "continue", data, delayMs: gate.retryInMs };
    }

    const profile = await db.selectFrom("profiles").selectAll().where("id", "=", data.profileId).executeTakeFirstOrThrow();
    const input = {
      linkedinUrl: profile.linkedin_url,
      firstName: profile.first_name,
      lastName: profile.last_name,
      company: profile.company_name,
      companyDomain: profile.company_domain,
      profileId: profile.id,
    };
    const attempt = await createAttempt(db, { profileId: profile.id, batchItemId: data.batchItemId, provider: provider.name, requestPayload: input });
    const started = Date.now();

    let result;
    try {
      result = await provider.submit(input);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : null;
      const retryable = pe ? pe.retryable : true; // unknown network errors are retryable
      const retryIdx = data.submitRetries;
      const message = (err as Error).message;
      log.warn({ provider: provider.name, profileId: profile.id, code: pe?.code, retryable, retryIdx, err: message }, "provider submit failed");
      await updateAttempt(db, attempt.id, {
        status: "failed",
        outcome: "error",
        errorCode: pe?.code ?? "network_error",
        errorMessage: message,
        responsePayload: pe?.opts.body ?? null,
        completed: true,
      });
      const delays = cfg.providerRetryDelaysMs;
      if (retryable && retryIdx < delays.length) {
        const delayMs = pe?.opts.retryAfterMs ?? delays[retryIdx]!;
        return { next: "continue", data: { ...data, submitRetries: retryIdx + 1 }, delayMs };
      }
      return this.runProvider(this.nextLayer(data, `${provider.name}: ${pe?.code ?? "network_error"}`, "error"));
    }

    if (result.kind === "no_match") {
      log.info({ provider: provider.name, profileId: profile.id, ms: Date.now() - started }, "provider: no match");
      await updateAttempt(db, attempt.id, { status: "completed", outcome: "no_match", responsePayload: result.raw, completed: true });
      return this.runProvider(this.nextLayer(data, `${provider.name}: no match`, "answer"));
    }

    const applied = await applyProviderData(db, profile.id, provider.name, result, { defaultRegion: cfg.DEFAULT_PHONE_REGION, existing: profile });
    if (applied.rejectedPhones.length) log.warn({ provider: provider.name, profileId: profile.id, rejected: applied.rejectedPhones }, "phones rejected (no country code / invalid)");

    if (result.kind === "completed") {
      await updateAttempt(db, attempt.id, {
        status: "completed",
        outcome: applied.mobile ? "mobile_found" : "mobile_missing",
        phonesFound: applied.phonesStored,
        emailsFound: applied.emailsStored,
        responsePayload: result.raw,
        creditsUsed: result.creditsUsed ?? null,
        completed: true,
      });
      return this.afterAnswer(data, provider.name, applied.mobile !== null);
    }

    // pending: the provider will deliver phones asynchronously
    const pollMs = this.pollIntervalMs(provider.name);
    await updateAttempt(db, attempt.id, {
      status: "polling",
      externalRequestId: result.externalRequestId,
      phonesFound: applied.phonesStored,
      emailsFound: applied.emailsStored,
      responsePayload: result.raw,
      nextPollAt: new Date(Date.now() + pollMs),
    });
    if (applied.mobile) {
      // Rare: the synchronous response already carried a mobile. Done.
      await updateAttempt(db, attempt.id, { status: "completed", outcome: "mobile_found", completed: true });
      return this.afterAnswer(data, provider.name, true);
    }
    log.info({ provider: provider.name, profileId: profile.id, requestId: result.externalRequestId, ms: Date.now() - started }, "provider: submitted, awaiting async result");
    return { next: "continue", data: { ...data, stage: "poll", attemptId: attempt.id }, delayMs: pollMs };
  }

  // ---------------------------------------------------------------------------
  private async pollProvider(data: EnrichJobData): Promise<StepResult> {
    const { db, cfg, providers, log } = this.d;
    const provider = providers[data.providerIndex];
    const attempt = data.attemptId ? await db.selectFrom("enrichment_attempts").selectAll().where("id", "=", data.attemptId).executeTakeFirst() : undefined;
    if (!provider || !attempt) return this.exhausted(data);
    if (attempt.status !== "polling" || !attempt.external_request_id) {
      // Already resolved by another path (e.g. webhook + poll race). Continue from the profile state.
      return this.resumeFromAttempt(data, attempt);
    }

    const timeoutMs = this.timeoutMs(provider.name);
    const age = Date.now() - new Date(attempt.submitted_at).getTime();

    let result;
    try {
      result = await provider.poll(attempt.external_request_id);
    } catch (err) {
      log.warn({ provider: provider.name, attemptId: attempt.id, err: (err as Error).message }, "poll request failed; will retry");
      result = { kind: "pending" as const, retryInMs: this.pollIntervalMs(provider.name) };
    }
    await updateAttempt(db, attempt.id, { incrementPoll: true });

    if (result.kind === "pending") {
      if (age > timeoutMs) {
        log.warn({ provider: provider.name, attemptId: attempt.id, ageMs: age }, "async result timed out; moving to next layer");
        await updateAttempt(db, attempt.id, { status: "timed_out", outcome: "timed_out", errorCode: "timeout", errorMessage: `no result after ${Math.round(age / 60000)} min`, completed: true });
        return this.runProvider(this.nextLayer(data, `${provider.name}: timed out`, "error"));
      }
      const delayMs = Math.min(result.retryInMs ?? this.pollIntervalMs(provider.name), timeoutMs - age + 1000);
      await updateAttempt(db, attempt.id, { nextPollAt: new Date(Date.now() + delayMs) });
      return { next: "continue", data, delayMs };
    }

    if (result.kind === "failed") {
      if (result.retryable && age < timeoutMs) {
        return { next: "continue", data, delayMs: 60_000 };
      }
      log.warn({ provider: provider.name, attemptId: attempt.id, code: result.code }, "async result failed");
      await updateAttempt(db, attempt.id, { status: "failed", outcome: "error", errorCode: result.code, errorMessage: result.message, resultPayload: result.raw ?? null, completed: true });
      return this.runProvider(this.nextLayer(data, `${provider.name}: ${result.code}`, "error"));
    }

    const applied = await applyProviderData(db, data.profileId, provider.name, result as ProviderData, { defaultRegion: cfg.DEFAULT_PHONE_REGION });
    if (applied.rejectedPhones.length) log.warn({ provider: provider.name, profileId: data.profileId, rejected: applied.rejectedPhones }, "phones rejected (no country code / invalid)");
    await updateAttempt(db, attempt.id, {
      status: "completed",
      outcome: applied.mobile ? "mobile_found" : "mobile_missing",
      phonesFound: attempt.phones_found + applied.phonesStored,
      emailsFound: attempt.emails_found + applied.emailsStored,
      resultPayload: result.raw,
      creditsUsed: result.creditsUsed ?? null,
      completed: true,
    });
    log.info({ provider: provider.name, profileId: data.profileId, mobile: applied.mobile?.e164 ?? null, polls: attempt.poll_count + 1 }, "async result received");
    return this.afterAnswer(data, provider.name, applied.mobile !== null);
  }

  private async resumeFromAttempt(data: EnrichJobData, attempt: EnrichmentAttempt): Promise<StepResult> {
    const provider = this.d.providers[data.providerIndex]!;
    if (attempt.outcome === "mobile_found") return this.afterAnswer(data, provider.name, true);
    if (attempt.outcome === "mobile_missing" || attempt.outcome === "no_match") return this.afterAnswer(data, provider.name, false);
    return this.runProvider(this.nextLayer(data, `${provider.name}: ${attempt.error_code ?? "error"}`, "error"));
  }

  private async afterAnswer(data: EnrichJobData, provider: Provider, mobileFound: boolean): Promise<StepResult> {
    if (mobileFound) {
      await this.finish(data, data.lockToken ?? null, { status: "mobile_found", source: provider, enriched: true });
      return { next: "done", outcome: `mobile_found:${provider}` };
    }
    return this.runProvider(this.nextLayer(data, `${provider}: no mobile`, "answer"));
  }

  private nextLayer(data: EnrichJobData, note: string, kind: "answer" | "error"): EnrichJobData {
    return {
      ...data,
      stage: "provider",
      attemptId: null,
      providerIndex: data.providerIndex + 1,
      submitRetries: 0,
      providerAnswers: data.providerAnswers + (kind === "answer" ? 1 : 0),
      providerErrors: data.providerErrors + (kind === "error" ? 1 : 0),
      layerNotes: [...(data.layerNotes ?? []), note],
    };
  }

  /** Every layer has been tried. */
  private async exhausted(data: EnrichJobData): Promise<StepResult> {
    const anyEnabled = this.d.providers.some((p) => p.enabled);
    if (!anyEnabled) {
      await this.finish(data, data.lockToken ?? null, { status: "failed", source: null, enriched: false, error: "no enrichment provider is configured (APOLLO_API_KEY / FULLENRICH_API_KEY)" });
      return { next: "done", outcome: "no_providers" };
    }
    const notes = (data.layerNotes ?? []).join("; ");
    if (data.providerErrors > 0) {
      // At least one layer could not answer (outage, credits, timeout). Do not cache
      // this as "no mobile" — keep it retryable so the missing layer gets its turn.
      await this.finish(data, data.lockToken ?? null, { status: "failed", source: null, enriched: false, error: notes || "provider error" });
      return { next: "done", outcome: data.providerAnswers === 0 ? "all_failed" : "partial_failure" };
    }
    await this.finish(data, data.lockToken ?? null, { status: "mobile_missing", source: this.lastAnsweringProvider(data), enriched: true });
    return { next: "done", outcome: "mobile_missing" };
  }

  private lastAnsweringProvider(data: EnrichJobData): Provider | null {
    const enabled = this.d.providers.filter((p) => p.enabled);
    return enabled.length ? enabled[enabled.length - 1]!.name : null;
  }

  // ---------------------------------------------------------------------------
  /** Another worker is enriching this profile; wait for its terminal state. */
  private async awaitOther(data: EnrichJobData): Promise<StepResult> {
    const { db, cfg } = this.d;
    const profile = await db.selectFrom("profiles").selectAll().where("id", "=", data.profileId).executeTakeFirst();
    if (!profile) {
      await this.markItem(data, "failed", null, "profile no longer exists");
      return { next: "done", outcome: "missing_profile" };
    }
    const terminal = profile.enrichment_status === "mobile_found" || profile.enrichment_status === "mobile_missing" || profile.enrichment_status === "failed";
    if (terminal && !profile.lock_token) {
      // Re-run start: the cache decision now reflects the other worker's result.
      return this.start({ ...data, stage: "start" });
    }
    const lockAge = profile.locked_at ? Date.now() - new Date(profile.locked_at).getTime() : 0;
    if (lockAge > cfg.LOCK_STALE_MINUTES * 60_000) return this.start({ ...data, stage: "start" });
    if (Date.now() - (data.awaitSince ?? Date.now()) > MAX_AWAIT_MS) {
      await this.markItem(data, "failed", null, "timed out waiting for a concurrent enrichment of the same profile");
      return { next: "done", outcome: "await_timeout" };
    }
    return { next: "continue", data, delayMs: AWAIT_POLL_MS };
  }

  // ---------------------------------------------------------------------------
  private async finish(
    data: EnrichJobData,
    lockToken: string | null,
    r: { status: "mobile_found" | "mobile_missing" | "failed"; source: "cache" | Provider | null; enriched: boolean; error?: string | null },
  ) {
    const { db, log } = this.d;
    if (r.source !== "cache") {
      await finalizeProfile(db, data.profileId, lockToken, {
        status: r.status,
        source: r.source,
        error: r.error ?? null,
        enriched: r.enriched,
      });
    }
    const itemStatus = r.status === "failed" ? "failed" : r.status;
    await this.markItem(data, itemStatus, r.source, r.error ?? null);
    log.info({ profileId: data.profileId, status: r.status, source: r.source }, "waterfall finished");
  }

  private async markItem(data: EnrichJobData, status: "mobile_found" | "mobile_missing" | "failed" | "cancelled", source: "cache" | Provider | null, error: string | null) {
    if (!data.batchItemId) return;
    await completeBatchItem(this.d.db, data.batchItemId, { status, source, error, profileId: data.profileId });
  }

  private async batchCancelled(batchItemId: string): Promise<boolean> {
    const row = await this.d.db
      .selectFrom("batch_items")
      .innerJoin("batches", "batches.id", "batch_items.batch_id")
      .select("batches.status")
      .where("batch_items.id", "=", batchItemId)
      .executeTakeFirst();
    return row?.status === "cancelled";
  }

  private pollIntervalMs(p: Provider) {
    return (p === "apollo" ? this.d.cfg.APOLLO_POLL_INTERVAL_SECONDS : this.d.cfg.FULLENRICH_POLL_INTERVAL_SECONDS) * 1000;
  }
  private timeoutMs(p: Provider) {
    return (p === "apollo" ? this.d.cfg.APOLLO_PHONE_TIMEOUT_MINUTES : this.d.cfg.FULLENRICH_TIMEOUT_MINUTES) * 60_000;
  }
}

export type { Profile };
