import type { Config } from "../config.js";
import { ProviderError } from "../lib/errors.js";
import { httpJson } from "../lib/http.js";
import { countryNameToIso, type ProviderPhoneHint } from "../lib/phone.js";
import type { EnrichInput, EnrichmentProvider, PollResult, ProviderData, ProviderEmail, ProviderPerson, ProviderPhone, SubmitResult } from "./types.js";

type AnyRecord = Record<string, unknown>;
const rec = (v: unknown): AnyRecord | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as AnyRecord) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Apollo.io People Enrichment (POST /api/v1/people/match).
 *
 * Mobile numbers are only delivered asynchronously. We use `poll_only=true`
 * and poll GET /api/v1/webhook_result/{request_id} — no public webhook needed.
 */
export class ApolloProvider implements EnrichmentProvider {
  readonly name = "apollo" as const;
  readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly revealPersonalEmails: boolean;
  private readonly pollIntervalMs: number;

  constructor(cfg: Pick<Config, "APOLLO_API_KEY" | "APOLLO_BASE_URL" | "APOLLO_REVEAL_PERSONAL_EMAILS" | "APOLLO_POLL_INTERVAL_SECONDS">) {
    this.apiKey = cfg.APOLLO_API_KEY ?? "";
    this.enabled = Boolean(this.apiKey);
    this.baseUrl = cfg.APOLLO_BASE_URL.replace(/\/+$/, "");
    this.revealPersonalEmails = cfg.APOLLO_REVEAL_PERSONAL_EMAILS;
    this.pollIntervalMs = cfg.APOLLO_POLL_INTERVAL_SECONDS * 1000;
  }

  private headers() {
    return { "x-api-key": this.apiKey, "cache-control": "no-cache" };
  }

  async submit(input: EnrichInput): Promise<SubmitResult> {
    const params = new URLSearchParams();
    params.set("linkedin_url", input.linkedinUrl);
    if (input.firstName) params.set("first_name", input.firstName);
    if (input.lastName) params.set("last_name", input.lastName);
    if (input.company) params.set("organization_name", input.company);
    if (input.companyDomain) params.set("domain", input.companyDomain);
    params.set("reveal_personal_emails", String(this.revealPersonalEmails));
    params.set("reveal_phone_number", "true");
    params.set("poll_only", "true");

    const url = `${this.baseUrl}/api/v1/people/match?${params.toString()}`;
    const res = await httpJson<AnyRecord>(url, { method: "POST", headers: this.headers(), retries: 2, timeoutMs: 30_000 });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("apollo", "Apollo rejected the API key", { code: "unauthorized", status: res.status, retryable: false, body: res.body });
    }
    if (res.status === 429) {
      throw new ProviderError("apollo", "Apollo rate limit exceeded", { code: "rate_limited", status: 429, retryable: true, retryAfterMs: 60_000, body: res.body });
    }
    if (res.status === 422 || res.status === 400) {
      throw new ProviderError("apollo", `Apollo rejected the request: ${errorMessage(res.body)}`, { code: "bad_request", status: res.status, retryable: false, body: res.body });
    }
    if (res.status >= 500) {
      throw new ProviderError("apollo", `Apollo server error (${res.status})`, { code: "server_error", status: res.status, retryable: true, body: res.body });
    }
    if (res.status !== 200) {
      throw new ProviderError("apollo", `Unexpected Apollo response (${res.status})`, { code: "unexpected_status", status: res.status, retryable: false, body: res.body });
    }

    const body = rec(res.body) ?? {};
    const person = rec(body.person);
    if (!person) return { kind: "no_match", raw: body };

    const data = parsePerson(person, body);
    const requestId = body.request_id != null ? String(body.request_id) : null;

    // Phone numbers may already be present on the synchronous response for
    // previously revealed contacts; if a mobile is there we are done.
    if (!requestId) return { kind: "completed", ...data };
    return { kind: "pending", externalRequestId: requestId, ...data };
  }

  async poll(externalRequestId: string): Promise<PollResult> {
    const url = `${this.baseUrl}/api/v1/webhook_result/${encodeURIComponent(externalRequestId)}`;
    const res = await httpJson<AnyRecord>(url, { method: "GET", headers: this.headers(), retries: 1, timeoutMs: 20_000 });
    const body = rec(res.body) ?? {};

    if (res.status === 404) {
      const code = str(body.error) ?? str(body.code) ?? "";
      if (code === "result_pending" || /pending/i.test(JSON.stringify(body))) {
        const retryAfter = num(body.retry_after_seconds);
        return { kind: "pending", retryInMs: retryAfter ? retryAfter * 1000 : this.pollIntervalMs, raw: body };
      }
      return { kind: "failed", code: "request_id_unknown", message: "Apollo does not recognise this request id", retryable: false, raw: body };
    }
    if (res.status === 410) return { kind: "failed", code: "request_id_expired", message: "Apollo result expired", retryable: false, raw: body };
    if (res.status === 401 || res.status === 403) return { kind: "failed", code: "unauthorized", message: "Apollo rejected the API key", retryable: false, raw: body };
    if (res.status === 429) return { kind: "pending", retryInMs: 60_000, raw: body };
    if (res.status >= 500) return { kind: "pending", retryInMs: this.pollIntervalMs, raw: body };
    if (res.status !== 200) return { kind: "failed", code: "unexpected_status", message: `Unexpected Apollo response (${res.status})`, retryable: false, raw: body };

    const status = str(body.webhook_status) ?? "";
    if (status === "in_progress" || status === "pending") return { kind: "pending", retryInMs: this.pollIntervalMs, raw: body };
    if (status === "failed") {
      return { kind: "failed", code: "webhook_failed", message: str(body.failure_reason) ?? "Apollo phone reveal failed", retryable: false, raw: body };
    }

    const result = rec(body.webhook_result) ?? {};
    const people = Array.isArray(result.people) ? result.people.map(rec).filter((p): p is AnyRecord => !!p) : [];
    const phones: ProviderPhone[] = [];
    for (const p of people) {
      for (const ph of asArray(p.phone_numbers)) phones.push(...toPhone(ph));
    }
    return {
      kind: "completed",
      person: null,
      phones,
      emails: [],
      creditsUsed: num(result.credits_consumed),
      raw: body,
    };
  }
}

function errorMessage(body: unknown): string {
  const b = rec(body);
  return str(b?.message) ?? str(b?.error) ?? str(b?.error_code) ?? "unknown error";
}

function asArray(v: unknown): AnyRecord[] {
  return Array.isArray(v) ? v.map(rec).filter((x): x is AnyRecord => !!x) : [];
}

export function parsePerson(person: AnyRecord, raw: unknown): ProviderData {
  const org = rec(person.organization);
  const contact = rec(person.contact);
  const country = str(person.country);
  const out: ProviderPerson = {
    externalId: str(person.id),
    firstName: str(person.first_name),
    lastName: str(person.last_name),
    fullName: str(person.name),
    headline: str(person.headline),
    jobTitle: str(person.title),
    seniority: str(person.seniority),
    photoUrl: str(person.photo_url),
    companyName: str(org?.name) ?? str(person.organization_name),
    companyDomain: str(org?.primary_domain),
    companyWebsite: str(org?.website_url),
    companyLinkedinUrl: str(org?.linkedin_url),
    companyIndustry: str(org?.industry),
    companySize: num(org?.estimated_num_employees),
    city: str(person.city),
    state: str(person.state),
    country,
    countryIso: countryNameToIso(country),
  };

  const emails: ProviderEmail[] = [];
  const primary = str(person.email);
  if (primary) emails.push({ email: primary, kind: "work", status: str(person.email_status), record: { email: primary, email_status: person.email_status } });
  for (const pe of Array.isArray(person.personal_emails) ? person.personal_emails : []) {
    const e = typeof pe === "string" ? pe : str(rec(pe)?.email);
    if (e) emails.push({ email: e, kind: "personal", status: null, record: pe });
  }

  const phones: ProviderPhone[] = [];
  for (const ph of asArray(person.phone_numbers)) phones.push(...toPhone(ph, out.countryIso));
  for (const ph of asArray(contact?.phone_numbers)) phones.push(...toPhone(ph, out.countryIso));

  return { person: out, phones, emails, raw };
}

function toPhone(ph: AnyRecord, regionIso: string | null = null): ProviderPhone[] {
  const number = str(ph.sanitized_number) ?? str(ph.raw_number);
  if (!number) return [];
  const type = (str(ph.type_cd) ?? str(ph.type) ?? "").toLowerCase();
  const status = str(ph.status_cd) ?? str(ph.status);
  if (status && /invalid/i.test(status)) return [];
  return [{ raw: number, providerType: mapType(type), providerStatus: status, regionIso, record: ph }];
}

function mapType(t: string): ProviderPhoneHint {
  switch (t) {
    case "mobile":
      return "mobile";
    case "work_hq":
    case "home":
      return "landline";
    case "work_direct":
    case "other":
    case "":
      return "unknown";
    default:
      return "other";
  }
}
