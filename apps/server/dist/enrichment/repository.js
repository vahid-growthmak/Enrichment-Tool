import { sql } from "kysely";
import { normalizePhone } from "../lib/phone.js";
/** Insert the profile if it does not exist; fill identity fields from user input when empty. */
export async function upsertProfile(db, canon, inputs = {}) {
    const first = clean(inputs.firstName);
    const last = clean(inputs.lastName);
    const company = clean(inputs.company);
    const inserted = await db
        .insertInto("profiles")
        .values({
        linkedin_url: canon.url,
        linkedin_slug: canon.slug,
        linkedin_kind: canon.kind,
        first_name: first,
        last_name: last,
        full_name: first && last ? `${first} ${last}` : null,
        company_name: company,
        enrichment_status: "pending",
    })
        .onConflict((oc) => oc.column("linkedin_url").doNothing())
        .returningAll()
        .executeTakeFirst();
    if (inserted)
        return inserted;
    const existing = await db.selectFrom("profiles").selectAll().where("linkedin_url", "=", canon.url).executeTakeFirstOrThrow();
    if ((first && !existing.first_name) || (last && !existing.last_name) || (company && !existing.company_name)) {
        return db
            .updateTable("profiles")
            .set({
            first_name: existing.first_name ?? first,
            last_name: existing.last_name ?? last,
            company_name: existing.company_name ?? company,
        })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
    }
    return existing;
}
/**
 * Take the in-flight lock. Returns the locked profile, or null when another
 * worker holds a fresh lock. Stale locks (crashed workers) are reclaimed.
 */
export async function claimProfile(db, profileId, lockStaleMinutes) {
    const token = crypto.randomUUID();
    const row = await db
        .updateTable("profiles")
        .set({ lock_token: token, locked_at: sql `now()`, enrichment_status: "in_progress", last_attempt_at: sql `now()` })
        .where("id", "=", profileId)
        .where((eb) => eb.or([eb("lock_token", "is", null), eb("locked_at", "<", sql `now() - make_interval(mins => ${lockStaleMinutes})`)]))
        .returningAll()
        .executeTakeFirst();
    return row ? { profile: row, lockToken: token } : null;
}
export async function finalizeProfile(db, profileId, lockToken, input) {
    let q = db
        .updateTable("profiles")
        .set({
        enrichment_status: input.status,
        enrichment_source: input.source,
        last_error: input.error ?? null,
        lock_token: null,
        locked_at: null,
        ...(input.enriched ? { last_enriched_at: sql `now()`, attempt_count: sql `attempt_count + 1` } : {}),
    })
        .where("id", "=", profileId);
    if (lockToken)
        q = q.where("lock_token", "=", lockToken);
    return q.returningAll().executeTakeFirst();
}
/**
 * Persist everything a provider returned: identity/company fields on the
 * profile, every phone and email in the side tables, and — if one qualifies —
 * the golden mobile number.
 */
export async function applyProviderData(db, profileId, provider, data, opts = {}) {
    const existing = opts.existing ?? (await db.selectFrom("profiles").selectAll().where("id", "=", profileId).executeTakeFirstOrThrow());
    const p = data.person;
    const regionHint = p?.countryIso ?? existing.country_iso ?? null;
    const rejected = [];
    const normalized = [];
    const seen = new Set();
    for (const ph of data.phones) {
        const n = normalizePhone(ph.raw, { providerType: ph.providerType, regionHint: ph.regionIso ?? regionHint, defaultRegion: opts.defaultRegion ?? null });
        if (!n) {
            rejected.push({ raw: ph.raw, reason: "could not determine a valid number with country code" });
            continue;
        }
        if (seen.has(n.e164))
            continue;
        seen.add(n.e164);
        normalized.push({ phone: n, src: ph });
    }
    const mobile = normalized.find((x) => x.phone.isMobile && !x.src.inactive)?.phone ?? null;
    await db.transaction().execute(async (trx) => {
        const patch = {};
        if (p) {
            const fields = [
                ["first_name", p.firstName],
                ["last_name", p.lastName],
                ["full_name", p.fullName ?? (p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null)],
                ["headline", p.headline],
                ["job_title", p.jobTitle],
                ["seniority", p.seniority],
                ["photo_url", p.photoUrl],
                ["company_name", p.companyName],
                ["company_domain", p.companyDomain],
                ["company_website", p.companyWebsite],
                ["company_linkedin_url", p.companyLinkedinUrl],
                ["company_industry", p.companyIndustry],
                ["company_size", p.companySize],
                ["city", p.city],
                ["state", p.state],
                ["country", p.country],
                ["country_iso", p.countryIso],
            ];
            for (const [k, v] of fields)
                if (v !== null && v !== undefined && v !== "")
                    patch[k] = v;
            if (provider === "apollo" && p.externalId)
                patch.apollo_person_id = p.externalId;
            if (provider === "fullenrich" && p.externalId)
                patch.fullenrich_profile_id = p.externalId;
        }
        const work = data.emails.find((e) => e.kind === "work");
        const personal = data.emails.find((e) => e.kind === "personal");
        if (work) {
            patch.work_email = work.email;
            patch.work_email_status = work.status ?? null;
        }
        if (personal)
            patch.personal_email = personal.email;
        if (mobile) {
            patch.mobile_number = mobile.e164;
            patch.mobile_country_code = mobile.countryCallingCode;
            patch.mobile_country_iso = mobile.countryIso;
            patch.mobile_line_type = mobile.lineType;
            patch.mobile_source = provider;
            patch.mobile_found_at = sql `now()`;
        }
        if (Object.keys(patch).length) {
            await trx.updateTable("profiles").set(patch).where("id", "=", profileId).execute();
        }
        if (normalized.length) {
            await trx
                .insertInto("profile_phones")
                .values(normalized.map(({ phone, src }) => ({
                profile_id: profileId,
                number_e164: phone.e164,
                country_code: phone.countryCallingCode,
                country_iso: phone.countryIso,
                line_type: phone.lineType,
                is_mobile: phone.isMobile && !src.inactive,
                provider,
                provider_type: src.providerType,
                provider_status: src.providerStatus ?? null,
                raw: JSON.stringify(src.record),
            })))
                .onConflict((oc) => oc.columns(["profile_id", "number_e164"]).doNothing())
                .execute();
        }
        if (data.emails.length) {
            const uniq = new Map();
            for (const e of data.emails)
                if (!uniq.has(e.email.toLowerCase()))
                    uniq.set(e.email.toLowerCase(), e);
            await trx
                .insertInto("profile_emails")
                .values([...uniq.values()].map((e) => ({
                profile_id: profileId,
                email: e.email,
                kind: e.kind,
                status: e.status ?? null,
                provider,
                raw: JSON.stringify(e.record),
            })))
                .onConflict((oc) => oc.columns(["profile_id", "email"]).doNothing())
                .execute();
        }
    });
    return { mobile, phonesStored: normalized.length, emailsStored: data.emails.length, rejectedPhones: rejected };
}
export async function createAttempt(db, input) {
    return db
        .insertInto("enrichment_attempts")
        .values({
        profile_id: input.profileId,
        batch_item_id: input.batchItemId ?? null,
        provider: input.provider,
        status: "submitted",
        request_payload: JSON.stringify(input.requestPayload ?? null),
    })
        .returningAll()
        .executeTakeFirstOrThrow();
}
export async function updateAttempt(db, attemptId, patch) {
    await db
        .updateTable("enrichment_attempts")
        .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
        ...(patch.externalRequestId !== undefined ? { external_request_id: patch.externalRequestId } : {}),
        ...(patch.phonesFound !== undefined ? { phones_found: patch.phonesFound } : {}),
        ...(patch.emailsFound !== undefined ? { emails_found: patch.emailsFound } : {}),
        ...(patch.creditsUsed !== undefined ? { credits_used: patch.creditsUsed } : {}),
        ...(patch.errorCode !== undefined ? { error_code: patch.errorCode } : {}),
        ...(patch.errorMessage !== undefined ? { error_message: truncate(patch.errorMessage, 2000) } : {}),
        ...(patch.responsePayload !== undefined ? { response_payload: JSON.stringify(patch.responsePayload ?? null) } : {}),
        ...(patch.resultPayload !== undefined ? { result_payload: JSON.stringify(patch.resultPayload ?? null) } : {}),
        ...(patch.nextPollAt !== undefined ? { next_poll_at: patch.nextPollAt } : {}),
        ...(patch.incrementPoll ? { poll_count: sql `poll_count + 1` } : {}),
        ...(patch.completed ? { completed_at: sql `now()` } : {}),
    })
        .where("id", "=", attemptId)
        .execute();
}
export async function completeBatchItem(db, itemId, patch) {
    await db
        .updateTable("batch_items")
        .set({
        status: patch.status,
        result_source: patch.source ?? null,
        error: patch.error != null ? truncate(patch.error, 1000) : null,
        ...(patch.profileId !== undefined ? { profile_id: patch.profileId } : {}),
        completed_at: ["pending", "processing"].includes(patch.status) ? null : sql `now()`,
    })
        .where("id", "=", itemId)
        .execute();
}
export function clean(v) {
    if (v == null)
        return null;
    const s = String(v).trim();
    return s ? s.slice(0, 200) : null;
}
export function truncate(s, n) {
    if (s == null)
        return null;
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
//# sourceMappingURL=repository.js.map