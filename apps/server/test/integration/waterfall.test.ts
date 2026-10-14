import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, TERMINAL, waitFor, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.truncate();
  await h.resetMock();
});

async function enrich(url: string, extra: Record<string, unknown> = {}) {
  const res = await h.app.inject({ method: "POST", url: "/api/v1/enrich/single", payload: { linkedinUrl: url, ...extra } });
  return { status: res.statusCode, body: JSON.parse(res.body) as { result: string; cached: boolean; profile: { id: string } } };
}

/** Wait for a waterfall run that started after `after` to reach a terminal state. */
async function waitTerminal(profileId: string, after: Date = new Date(0)) {
  return waitFor(async () => {
    const p = await h.db.selectFrom("profiles").selectAll().where("id", "=", profileId).executeTakeFirstOrThrow();
    const started = p.last_attempt_at ? new Date(p.last_attempt_at).getTime() >= after.getTime() - 5 : false;
    return TERMINAL.has(p.enrichment_status) && !p.lock_token && started ? p : null;
  }, { label: `profile ${profileId} terminal`, timeoutMs: 120_000 });
}

describe("waterfall: single enrichment", () => {
  it("Apollo finds the mobile → stop, FullEnrich never called (and the raw JSON is kept)", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/slow-alpha?utm=1");
    expect(body.result).toBe("queued");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_found");
    expect(p.mobile_source).toBe("apollo");
    expect(p.mobile_number).toMatch(/^\+\d{8,15}$/);
    expect(p.mobile_country_code).toMatch(/^\+\d+$/);
    expect(p.mobile_country_iso).toMatch(/^[A-Z]{2}$/);
    expect(p.first_name).toBeTruthy();
    expect(p.company_name).toBeTruthy();
    expect(p.work_email).toContain("@");
    const calls = await h.mockCalls();
    expect(calls["apollo.match"]).toBe(1);
    expect(calls["fullenrich.submit"]).toBeUndefined();
    const attempts = await h.db.selectFrom("enrichment_attempts").selectAll().where("profile_id", "=", p.id).execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.response_payload).toBeTruthy();
    expect(attempts[0]!.result_payload).toBeTruthy();
    expect(attempts[0]!.credits_used).toBe(8);
    const phones = await h.db.selectFrom("profile_phones").selectAll().where("profile_id", "=", p.id).execute();
    expect(phones.filter((x) => x.is_mobile)).toHaveLength(1);
    expect(phones.filter((x) => x.line_type === "landline")).toHaveLength(1);
  });

  it("Apollo has no mobile → FullEnrich finds it (partial Apollo data is kept)", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/fe-bravo");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_found");
    expect(p.mobile_source).toBe("fullenrich");
    expect(p.apollo_person_id).toBeTruthy();
    expect(p.fullenrich_profile_id).toBeTruthy();
    const calls = await h.mockCalls();
    expect(calls["apollo.match"]).toBe(1);
    expect(calls["fullenrich.submit"]).toBe(1);
    const attempts = await h.db.selectFrom("enrichment_attempts").select(["provider", "outcome"]).where("profile_id", "=", p.id).orderBy("submitted_at").execute();
    expect(attempts).toEqual([
      { provider: "apollo", outcome: "mobile_missing" },
      { provider: "fullenrich", outcome: "mobile_found" },
    ]);
  });

  it("neither provider has a mobile → mobile_missing, partial data saved", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/nomobile-charlie");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_missing");
    expect(p.mobile_number).toBeNull();
    expect(p.first_name).toBeTruthy();
    expect(p.last_enriched_at).toBeTruthy();
  });

  it("the second request for a known mobile is served from the DB with zero provider calls", async () => {
    const first = await enrich("https://www.linkedin.com/in/slow-delta");
    await waitTerminal(first.body.profile.id);
    await h.resetMock();
    const second = await enrich("http://LinkedIn.com/in/Slow-Delta/?trk=x");
    expect(second.body.result).toBe("mobile_found");
    expect(second.body.cached).toBe(true);
    expect(second.body.profile.id).toBe(first.body.profile.id);
    expect(await h.mockCalls()).toEqual({});
  });

  it("a 'mobile missing' result is not re-bought inside the cooldown, but is after it / when forced", async () => {
    const first = await enrich("https://www.linkedin.com/in/nomobile-echo");
    await waitTerminal(first.body.profile.id);
    await h.resetMock();
    const again = await enrich("https://www.linkedin.com/in/nomobile-echo");
    expect(again.body.result).toBe("mobile_missing");
    expect(again.body.cached).toBe(true);
    expect(await h.mockCalls()).toEqual({});

    // cooldown elapsed
    await h.db.updateTable("profiles").set({ last_enriched_at: new Date(Date.now() - 31 * 86_400_000) }).where("id", "=", first.body.profile.id).execute();
    const t1 = new Date();
    const later = await enrich("https://www.linkedin.com/in/nomobile-echo");
    expect(later.body.result).toBe("queued");
    await waitTerminal(first.body.profile.id, t1);
    expect((await h.mockCalls())["apollo.match"]).toBe(1);

    // forced
    await h.resetMock();
    const t2 = new Date();
    const forced = await h.app.inject({ method: "POST", url: `/api/v1/profiles/${first.body.profile.id}/re-enrich` });
    expect(JSON.parse(forced.body).result).toBe("queued");
    await waitTerminal(first.body.profile.id, t2);
    expect((await h.mockCalls())["apollo.match"]).toBe(1);
  });

  it("rejects invalid URLs and company pages with a clear message", async () => {
    const r = await enrich("https://www.linkedin.com/company/acme");
    expect(r.status).toBe(400);
    expect((r.body as unknown as { message: string }).message).toMatch(/company page/);
    const r2 = await enrich("");
    expect(r2.status).toBe(400);
    const r3 = await h.app.inject({ method: "POST", url: "/api/v1/enrich/single", payload: {} });
    expect(r3.statusCode).toBe(400);
  });

  it("Apollo 500 → retried, then FullEnrich takes over", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/apollo500-foxtrot");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_found");
    expect(p.mobile_source).toBe("fullenrich");
    const attempts = await h.db.selectFrom("enrichment_attempts").select(["provider", "status", "error_code"]).where("profile_id", "=", p.id).orderBy("submitted_at").execute();
    expect(attempts.filter((a) => a.provider === "apollo" && a.error_code === "server_error").length).toBeGreaterThanOrEqual(2);
    expect(attempts.at(-1)).toMatchObject({ provider: "fullenrich", status: "completed" });
  }, 150_000);

  it("Apollo 429 is retried and succeeds", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/apollo429-golf");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_found");
    expect(p.mobile_source).toBe("apollo");
  });

  it("both providers down → 'failed' (retryable), never cached as missing", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/bothdown-hotel");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("failed");
    expect(p.last_error).toMatch(/apollo: server_error; fullenrich: server_error/);
    expect(p.last_enriched_at).toBeNull();
    const again = await enrich("https://www.linkedin.com/in/bothdown-hotel");
    expect(again.body.result).toBe("queued"); // not served from cache
  }, 200_000);

  it("Apollo answers 'no mobile' but FullEnrich runs out of credits → failed with both notes", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/fecredits-india");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("failed");
    expect(p.last_error).toBe("apollo: no mobile; fullenrich: credits_insufficient");
  });

  it("a number without a country code is rejected, so the waterfall continues", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/nocode-juliet");
    const p = await waitTerminal(body.profile.id);
    expect(p.mobile_source).toBe("fullenrich");
    expect(p.mobile_number?.startsWith("+")).toBe(true);
    const phones = await h.db.selectFrom("profile_phones").selectAll().where("profile_id", "=", p.id).execute();
    expect(phones.every((x) => x.number_e164.startsWith("+"))).toBe(true);
  });

  it("an INACTIVE mobile is stored but never used as the golden number", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/inactive-kilo");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_missing");
    const phones = await h.db.selectFrom("profile_phones").selectAll().where("profile_id", "=", p.id).where("line_type", "=", "mobile").execute();
    expect(phones).toHaveLength(1);
    expect(phones[0]!.is_mobile).toBe(false);
  });

  it("Apollo result never arrives → times out → FullEnrich", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/apollotimeout-lima");
    const p = await waitTerminal(body.profile.id);
    expect(p.mobile_source).toBe("fullenrich");
    const a = await h.db.selectFrom("enrichment_attempts").selectAll().where("profile_id", "=", p.id).where("provider", "=", "apollo").executeTakeFirstOrThrow();
    expect(a.status).toBe("timed_out");
    expect(a.poll_count).toBeGreaterThan(5);
  }, 150_000);

  it("Apollo: person not found → FullEnrich → nothing → mobile_missing", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/nomatch-mike");
    const p = await waitTerminal(body.profile.id);
    expect(p.enrichment_status).toBe("mobile_missing");
    const a = await h.db.selectFrom("enrichment_attempts").select(["provider", "outcome"]).where("profile_id", "=", p.id).orderBy("submitted_at").execute();
    expect(a).toEqual([
      { provider: "apollo", outcome: "no_match" },
      { provider: "fullenrich", outcome: "mobile_missing" },
    ]);
  });

  it("user-supplied name/company are stored and passed to providers", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/nomatch-november", { firstName: " Ada ", lastName: "Lovelace", company: "Analytical Engines" });
    const p = await waitTerminal(body.profile.id);
    expect(p.first_name).toBe("Ada");
    expect(p.company_name).toBe("Analytical Engines");
    const fe = await h.db.selectFrom("enrichment_attempts").selectAll().where("profile_id", "=", p.id).where("provider", "=", "fullenrich").executeTakeFirstOrThrow();
    expect(fe.request_payload).toMatchObject({ firstName: "Ada", lastName: "Lovelace", company: "Analytical Engines" });
  });

  it("concurrent requests for the same profile only call the provider once", async () => {
    const url = "https://www.linkedin.com/in/slow-oscar";
    // Two jobs for the same profile at once: the second must wait, not double-spend.
    const [a, b] = await Promise.all([enrich(url), enrich(`${url}/`)]);
    expect(a.body.profile.id).toBe(b.body.profile.id);
    await waitTerminal(a.body.profile.id);
    await new Promise((r) => setTimeout(r, 1500));
    const calls = await h.mockCalls();
    expect(calls["apollo.match"]).toBe(1);
  });

  it("a stale lock from a crashed worker is reclaimed", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/slow-papa");
    await waitTerminal(body.profile.id);
    await h.db
      .updateTable("profiles")
      .set({ lock_token: "00000000-0000-0000-0000-000000000000", locked_at: new Date(Date.now() - 3 * 3600_000), enrichment_status: "in_progress", mobile_number: null })
      .where("id", "=", body.profile.id)
      .execute();
    const t1 = new Date();
    const r = await enrich("https://www.linkedin.com/in/slow-papa");
    expect(r.body.result).toBe("queued");
    const p = await waitTerminal(body.profile.id, t1);
    expect(p.enrichment_status).toBe("mobile_found");
  });

  it("GET /profiles/:id returns phones, emails and attempts; list supports search", async () => {
    const { body } = await enrich("https://www.linkedin.com/in/fe-quebec");
    const p = await waitTerminal(body.profile.id);
    const detail = JSON.parse((await h.app.inject({ method: "GET", url: `/api/v1/profiles/${p.id}` })).body);
    expect(detail.profile.mobile.number).toBe(p.mobile_number);
    expect(detail.phones.length).toBeGreaterThan(1);
    expect(detail.attempts).toHaveLength(2);
    expect(detail.cache.kind).toBe("hit_mobile");
    const list = JSON.parse((await h.app.inject({ method: "GET", url: `/api/v1/profiles?q=${encodeURIComponent(p.mobile_number!)}` })).body);
    expect(list.total).toBe(1);
    const stats = JSON.parse((await h.app.inject({ method: "GET", url: "/api/v1/stats" })).body);
    expect(stats.profiles.withMobile).toBe(1);
    expect(stats.providers.fullEnrichCredits).toBe(10);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/profiles/not-a-uuid" })).statusCode).toBe(404);
  });
});
