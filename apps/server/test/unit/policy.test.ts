import { describe, expect, it } from "vitest";
import type { Profile } from "../../src/db/types.js";
import { decideCache } from "../../src/enrichment/policy.js";

const base = (over: Partial<Profile> = {}): Profile =>
  ({
    id: "p",
    linkedin_url: "https://www.linkedin.com/in/x",
    linkedin_slug: "x",
    linkedin_kind: "profile",
    mobile_number: null,
    mobile_found_at: null,
    enrichment_status: "pending",
    last_enriched_at: null,
    ...over,
  }) as Profile;

const cfg = { MOBILE_MISSING_COOLDOWN_DAYS: 30, STALE_AFTER_DAYS: 0 };
const days = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("decideCache", () => {
  it("returns the mobile from cache forever when staleness is disabled", () => {
    expect(decideCache(base({ mobile_number: "+919876543210", mobile_found_at: days(900), enrichment_status: "mobile_found" }), cfg).kind).toBe("hit_mobile");
  });
  it("re-enriches stale mobiles when STALE_AFTER_DAYS is set", () => {
    const p = base({ mobile_number: "+919876543210", mobile_found_at: days(200), enrichment_status: "mobile_found" });
    expect(decideCache(p, { ...cfg, STALE_AFTER_DAYS: 180 })).toEqual({ kind: "miss", reason: "stale" });
    expect(decideCache(p, { ...cfg, STALE_AFTER_DAYS: 365 }).kind).toBe("hit_mobile");
  });
  it("does not re-buy a 'no mobile' result inside the cooldown", () => {
    const p = base({ enrichment_status: "mobile_missing", last_enriched_at: days(5) });
    const d = decideCache(p, cfg);
    expect(d.kind).toBe("hit_missing");
    expect(decideCache(base({ enrichment_status: "mobile_missing", last_enriched_at: days(31) }), cfg)).toEqual({ kind: "miss", reason: "cooldown_elapsed" });
  });
  it("cooldown 0 means never retry automatically", () => {
    expect(decideCache(base({ enrichment_status: "mobile_missing", last_enriched_at: days(5000) }), { ...cfg, MOBILE_MISSING_COOLDOWN_DAYS: 0 }).kind).toBe("hit_missing");
  });
  it("force bypasses everything", () => {
    expect(decideCache(base({ mobile_number: "+1", enrichment_status: "mobile_found" }), cfg, true)).toEqual({ kind: "miss", reason: "forced" });
  });
  it("failed and never-enriched profiles always go to the providers", () => {
    expect(decideCache(base({ enrichment_status: "failed", last_enriched_at: days(1) }), cfg)).toEqual({ kind: "miss", reason: "previous_failure" });
    expect(decideCache(base(), cfg)).toEqual({ kind: "miss", reason: "never_enriched" });
  });
});
