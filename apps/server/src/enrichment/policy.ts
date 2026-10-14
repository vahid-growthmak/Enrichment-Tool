import type { Config } from "../config.js";
import type { Profile } from "../db/types.js";

export type CacheDecision =
  | { kind: "hit_mobile" }
  | { kind: "hit_missing"; retryAfter: Date }
  | { kind: "miss"; reason: "never_enriched" | "stale" | "cooldown_elapsed" | "forced" | "previous_failure" | "no_result" };

/**
 * Decide whether a profile can be answered from the database without
 * touching any provider. This is the single source of truth for cost control
 * and is used both by the API (fast path) and by the worker (safety net).
 */
export function decideCache(profile: Profile, cfg: Pick<Config, "MOBILE_MISSING_COOLDOWN_DAYS" | "STALE_AFTER_DAYS">, force = false, now = new Date()): CacheDecision {
  if (force) return { kind: "miss", reason: "forced" };

  if (profile.mobile_number) {
    if (cfg.STALE_AFTER_DAYS > 0 && profile.mobile_found_at) {
      const age = now.getTime() - new Date(profile.mobile_found_at).getTime();
      if (age > cfg.STALE_AFTER_DAYS * 86_400_000) return { kind: "miss", reason: "stale" };
    }
    return { kind: "hit_mobile" };
  }

  if (profile.enrichment_status === "mobile_missing" && profile.last_enriched_at) {
    if (cfg.MOBILE_MISSING_COOLDOWN_DAYS === 0) {
      // 0 means "never automatically retry a profile with no mobile"
      return { kind: "hit_missing", retryAfter: new Date(8640000000000000) };
    }
    const retryAfter = new Date(new Date(profile.last_enriched_at).getTime() + cfg.MOBILE_MISSING_COOLDOWN_DAYS * 86_400_000);
    if (now < retryAfter) return { kind: "hit_missing", retryAfter };
    return { kind: "miss", reason: "cooldown_elapsed" };
  }

  if (profile.enrichment_status === "failed") return { kind: "miss", reason: "previous_failure" };
  if (profile.last_enriched_at) return { kind: "miss", reason: "no_result" };
  return { kind: "miss", reason: "never_enriched" };
}
