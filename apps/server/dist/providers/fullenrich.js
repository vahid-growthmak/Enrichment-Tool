import { ProviderError } from "../lib/errors.js";
import { httpJson } from "../lib/http.js";
const rec = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/**
 * FullEnrich v2 (POST /api/v2/contact/enrich/bulk, GET /api/v2/contact/enrich/bulk/{id}).
 * Results are asynchronous; we poll (and optionally also accept the webhook).
 */
export class FullEnrichProvider {
    name = "fullenrich";
    enabled;
    baseUrl;
    apiKey;
    fields;
    pollIntervalMs;
    webhookUrl;
    constructor(cfg) {
        this.apiKey = cfg.FULLENRICH_API_KEY ?? "";
        this.enabled = Boolean(this.apiKey);
        this.baseUrl = cfg.FULLENRICH_BASE_URL.replace(/\/+$/, "");
        this.fields = cfg.fullEnrichFields.length ? cfg.fullEnrichFields : ["contact.phones"];
        this.pollIntervalMs = cfg.FULLENRICH_POLL_INTERVAL_SECONDS * 1000;
        this.webhookUrl = cfg.FULLENRICH_USE_WEBHOOK
            ? `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/fullenrich${cfg.WEBHOOK_SECRET ? `?token=${encodeURIComponent(cfg.WEBHOOK_SECRET)}` : ""}`
            : null;
    }
    headers() {
        return { authorization: `Bearer ${this.apiKey}` };
    }
    async submit(input) {
        const item = { linkedin_url: input.linkedinUrl, enrich_fields: this.fields, custom: { profile_id: input.profileId } };
        // Only send name/company when both names are present — a lone empty name is a 400.
        if (input.firstName && input.lastName) {
            item.first_name = input.firstName;
            item.last_name = input.lastName;
            if (input.companyDomain)
                item.domain = input.companyDomain;
            else if (input.company)
                item.company_name = input.company;
        }
        const body = { name: `waterfall ${input.profileId}`, data: [item] };
        if (this.webhookUrl)
            body.webhook_url = this.webhookUrl;
        const res = await httpJson(`${this.baseUrl}/api/v2/contact/enrich/bulk`, {
            method: "POST",
            headers: this.headers(),
            body,
            retries: 2,
            timeoutMs: 30_000,
        });
        const resBody = rec(res.body) ?? {};
        if (res.status === 401 || res.status === 403) {
            throw new ProviderError("fullenrich", "FullEnrich rejected the API key", { code: "unauthorized", status: res.status, retryable: false, body: resBody });
        }
        if (res.status === 429) {
            throw new ProviderError("fullenrich", "FullEnrich rate limit exceeded", { code: "rate_limited", status: 429, retryable: true, retryAfterMs: 60_000, body: resBody });
        }
        if (res.status === 402) {
            throw new ProviderError("fullenrich", "FullEnrich credits exhausted", { code: "credits_insufficient", status: 402, retryable: false, body: resBody });
        }
        if (res.status === 400) {
            throw new ProviderError("fullenrich", `FullEnrich rejected the request: ${str(resBody.error) ?? str(resBody.message) ?? "bad request"}`, { code: "bad_request", status: 400, retryable: false, body: resBody });
        }
        if (res.status >= 500) {
            throw new ProviderError("fullenrich", `FullEnrich server error (${res.status})`, { code: "server_error", status: res.status, retryable: true, body: resBody });
        }
        const id = str(resBody.enrichment_id);
        if (res.status !== 200 || !id) {
            throw new ProviderError("fullenrich", `Unexpected FullEnrich response (${res.status})`, { code: "unexpected_status", status: res.status, retryable: false, body: resBody });
        }
        return { kind: "pending", externalRequestId: id, person: null, phones: [], emails: [], raw: resBody };
    }
    async poll(externalRequestId) {
        const res = await httpJson(`${this.baseUrl}/api/v2/contact/enrich/bulk/${encodeURIComponent(externalRequestId)}`, {
            method: "GET",
            headers: this.headers(),
            retries: 1,
            timeoutMs: 20_000,
        });
        const body = rec(res.body) ?? {};
        if (res.status === 400) {
            const code = str(body.error) ?? str(body.code) ?? "";
            if (/in_progress/i.test(code) || /not ready/i.test(JSON.stringify(body)))
                return { kind: "pending", retryInMs: this.pollIntervalMs, raw: body };
            return { kind: "failed", code: code || "bad_request", message: str(body.message) ?? "FullEnrich rejected the poll request", retryable: false, raw: body };
        }
        if (res.status === 404)
            return { kind: "failed", code: "not_found", message: "FullEnrich does not recognise this enrichment id", retryable: false, raw: body };
        if (res.status === 401 || res.status === 403)
            return { kind: "failed", code: "unauthorized", message: "FullEnrich rejected the API key", retryable: false, raw: body };
        if (res.status === 429)
            return { kind: "pending", retryInMs: 60_000, raw: body };
        if (res.status >= 500)
            return { kind: "pending", retryInMs: this.pollIntervalMs, raw: body };
        if (res.status !== 200 && res.status !== 402) {
            return { kind: "failed", code: "unexpected_status", message: `Unexpected FullEnrich response (${res.status})`, retryable: false, raw: body };
        }
        return parseResult(body);
    }
}
export function parseResult(body) {
    const status = (str(body.status) ?? "").toUpperCase();
    if (status === "CREATED" || status === "IN_PROGRESS")
        return { kind: "pending", raw: body };
    if (status === "CREDITS_INSUFFICIENT")
        return { kind: "failed", code: "credits_insufficient", message: "FullEnrich credits exhausted", retryable: false, raw: body };
    if (status === "RATE_LIMIT")
        return { kind: "failed", code: "rate_limited", message: "FullEnrich rate limit reached", retryable: true, raw: body };
    if (status === "CANCELED" || status === "CANCELLED")
        return { kind: "failed", code: "cancelled", message: "FullEnrich enrichment was cancelled", retryable: false, raw: body };
    if (status !== "FINISHED")
        return { kind: "failed", code: "unknown_status", message: `FullEnrich returned status ${status || "(none)"}`, retryable: false, raw: body };
    const data = Array.isArray(body.data) ? body.data.map(rec).filter((d) => !!d) : [];
    const credits = num(rec(body.cost)?.credits);
    const first = data[0];
    if (!first)
        return { kind: "completed", person: null, phones: [], emails: [], creditsUsed: credits, raw: body };
    return { kind: "completed", ...parseRecord(first), creditsUsed: credits, raw: body };
}
function parseRecord(d) {
    const contact = rec(d.contact_info) ?? {};
    const profile = rec(d.profile);
    const employment = rec(rec(profile?.employment)?.current);
    const company = rec(employment?.company);
    const location = rec(profile?.location);
    const social = rec(rec(profile?.social_profiles)?.professional_network);
    const companySocial = rec(rec(company?.social_profiles)?.professional_network);
    const person = profile
        ? {
            externalId: str(profile.id),
            firstName: str(profile.first_name),
            lastName: str(profile.last_name),
            fullName: str(profile.full_name),
            headline: str(profile.headline),
            jobTitle: str(employment?.title),
            companyName: str(company?.name),
            companyDomain: str(company?.domain),
            companyWebsite: str(company?.website),
            companyLinkedinUrl: str(companySocial?.url),
            companyIndustry: str(rec(company?.industry)?.main_industry),
            companySize: num(company?.headcount),
            city: str(location?.city),
            state: str(location?.region),
            country: str(location?.country),
            countryIso: str(location?.country_code),
            photoUrl: null,
            seniority: null,
        }
        : null;
    void social;
    const phones = [];
    const seen = new Set();
    const pushPhone = (p) => {
        const number = str(p?.number);
        if (!p || !number || seen.has(number))
            return;
        seen.add(number);
        const lineType = (str(p.line_type) ?? "").toUpperCase();
        const lineStatus = (str(p.line_status) ?? "").toUpperCase();
        phones.push({
            raw: number,
            providerType: lineType === "MOBILE" ? "mobile" : lineType === "LANDLINE" ? "landline" : lineType === "VOIP" ? "voip" : "unknown",
            providerStatus: lineStatus || null,
            regionIso: str(p.region),
            inactive: lineStatus === "INACTIVE",
            record: p,
        });
    };
    pushPhone(rec(contact.most_probable_phone));
    for (const p of Array.isArray(contact.phones) ? contact.phones : [])
        pushPhone(rec(p));
    const emails = [];
    const seenEmails = new Set();
    const pushEmail = (e, kind) => {
        const email = str(e?.email);
        if (!e || !email || seenEmails.has(email.toLowerCase()))
            return;
        seenEmails.add(email.toLowerCase());
        emails.push({ email, kind, status: str(e.status), record: e });
    };
    pushEmail(rec(contact.most_probable_work_email), "work");
    for (const e of Array.isArray(contact.work_emails) ? contact.work_emails : [])
        pushEmail(rec(e), "work");
    pushEmail(rec(contact.most_probable_personal_email), "personal");
    for (const e of Array.isArray(contact.personal_emails) ? contact.personal_emails : [])
        pushEmail(rec(e), "personal");
    return { person, phones, emails, raw: d };
}
//# sourceMappingURL=fullenrich.js.map