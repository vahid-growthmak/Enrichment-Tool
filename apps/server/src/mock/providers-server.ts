import Fastify from "fastify";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local stand-in for Apollo and FullEnrich with the real wire formats.
 * Behaviour is chosen deterministically from the LinkedIn slug so tests and
 * manual QA are repeatable:
 *
 *   slug contains        Apollo                         FullEnrich
 *   ---------------      ----------------------------   -------------------------
 *   nomatch              person: null                   FINISHED, no data
 *   nomobile             person, landline only          landline only
 *   fe- / fullenrich     person, work_hq only           MOBILE
 *   apollo500            HTTP 500 (always)              MOBILE
 *   apollo429            429 once, then mobile          -
 *   apollotimeout        result never arrives           MOBILE
 *   nocode               mobile without + / country     MOBILE
 *   fecredits            no mobile                      CREDITS_INSUFFICIENT
 *   fe500                no mobile                      HTTP 500 (always)
 *   bothdown             HTTP 500                       HTTP 500
 *   inactive             no mobile                      MOBILE but INACTIVE
 *   slow                 mobile after 3 polls           -
 *   (anything else)      hash: 60% mobile / 25% FE mobile / 15% none
 */


interface ApolloReq { slug: string; polls: number; pollsNeeded: number; scenario: string; }
interface FeReq { slug: string; polls: number; scenario: string; custom: Record<string, string>; input: Record<string, unknown>; }

const apolloReqs = new Map<string, ApolloReq>();
const feReqs = new Map<string, FeReq>();
const calls: Record<string, number> = {};
const seen429 = new Set<string>();
let apolloIdCounter = 1000000;

const hash = (s: string) => parseInt(createHash("md5").update(s).digest("hex").slice(0, 8), 16);
const slugOf = (url: string) => (url.match(/\/(?:in|lead)\/([^/?#]+)/i)?.[1] ?? url).toLowerCase();
const bump = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);

function scenarioFor(slug: string): string {
  for (const k of ["nomatch", "nomobile", "fullenrich", "fe-", "apollo500", "apollo429", "apollotimeout", "nocode", "fecredits", "fe500", "bothdown", "inactive", "slow", "landline"]) {
    if (slug.includes(k)) return k === "fe-" ? "fullenrich" : k === "landline" ? "nomobile" : k;
  }
  const h = hash(slug) % 100;
  return h < 60 ? "apollo_mobile" : h < 85 ? "fullenrich" : "none";
}

function mobileFor(slug: string): { e164: string; region: string; display: string } {
  const h = hash(`m:${slug}`);
  const pick = h % 4;
  const d = (n: number) => String(h % 10 ** n).padStart(n, "0");
  if (pick === 0) return { e164: `+919${d(9)}`, region: "IN", display: `+91 9${d(9)}` };
  if (pick === 1) return { e164: `+336${d(8)}`, region: "FR", display: `+33 6 ${d(8)}` };
  if (pick === 2) return { e164: `+49176${d(8)}`, region: "DE", display: `+49 176 ${d(8)}` };
  return { e164: `+1415555${d(4)}`, region: "US", display: `+1 415-555-${d(4)}` };
}

function personFor(slug: string) {
  const h = hash(`p:${slug}`);
  const firsts = ["Priya", "Daniel", "Aisha", "Marco", "Chen", "Olivia", "Rahul", "Sofia"];
  const lasts = ["Sharma", "Okafor", "Müller", "Rossi", "Wang", "Bennett", "Iyer", "Garcia"];
  const titles = ["Head of Sales", "VP Marketing", "Founder", "Account Executive", "CTO", "Product Manager"];
  const cos = ["Northwind Labs", "Acme Robotics", "Blue Harbor Capital", "Lumen Health", "Orbit Analytics"];
  const countries = [["India", "Bengaluru", "Karnataka"], ["United States", "Austin", "Texas"], ["Germany", "Berlin", "Berlin"], ["France", "Paris", "Île-de-France"]];
  const c = countries[h % countries.length]!;
  const co = cos[h % cos.length]!;
  return {
    first: firsts[h % firsts.length]!,
    last: lasts[(h >>> 3) % lasts.length]!,
    title: titles[(h >>> 5) % titles.length]!,
    company: co,
    domain: `${co.toLowerCase().replace(/[^a-z]/g, "")}.com`,
    country: c[0]!,
    city: c[1]!,
    state: c[2]!,
  };
}

export function buildMockProviders(opts: { latencyMs?: number } = {}) {
const latency = opts.latencyMs ?? Number(process.env.MOCK_LATENCY_MS ?? 0);
const wait = () => (latency ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());
const app = Fastify({ logger: false });

app.get("/__mock/calls", async () => ({ calls, apolloRequests: apolloReqs.size, fullenrichRequests: feReqs.size }));
app.post("/__mock/reset", async () => {
  for (const k of Object.keys(calls)) delete calls[k];
  apolloReqs.clear();
  feReqs.clear();
  seen429.clear();
  return { ok: true };
});

// ---------------------------------------------------------------- Apollo
app.post("/api/v1/people/match", async (req, reply) => {
  await wait();
  bump("apollo.match");
  if (!req.headers["x-api-key"]) return reply.code(401).send("Invalid API key");
  const q = req.query as Record<string, string>;
  const url = q.linkedin_url ?? "";
  const slug = slugOf(url);
  const sc = scenarioFor(slug);

  if (sc === "apollo500" || sc === "bothdown") return reply.code(500).send({ error: "internal server error" });
  if (sc === "apollo429" && !seen429.has(slug)) {
    seen429.add(slug);
    return reply.code(429).header("retry-after", "1").send({ error: "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED" });
  }
  if (q.reveal_phone_number === "true" && q.poll_only !== "true" && !q.webhook_url) {
    return reply.code(400).send({ error: "SEARCH.VALIDATION.WEBHOOK_URL_REQUIRED" });
  }
  if (sc === "nomatch") return reply.code(200).send({ request_id: null, person: null });

  const p = personFor(slug);
  const id = `apollo_${hash(slug).toString(16)}`;
  const requestId = String(++apolloIdCounter);
  apolloReqs.set(requestId, { slug, polls: 0, pollsNeeded: sc === "slow" ? 3 : 1, scenario: sc });
  return {
    request_id: Number(requestId),
    person: {
      id,
      first_name: p.first,
      last_name: p.last,
      name: `${p.first} ${p.last}`,
      title: p.title,
      headline: `${p.title} at ${p.company}`,
      linkedin_url: url,
      email: `${p.first}.${p.last}@${p.domain}`.toLowerCase(),
      email_status: "verified",
      city: sc === "nocode" ? null : p.city,
      state: sc === "nocode" ? null : p.state,
      country: sc === "nocode" ? null : p.country,
      match_confidence: "high",
      organization: { id: `org_${hash(p.company)}`, name: p.company, primary_domain: p.domain, website_url: `https://${p.domain}`, industry: "software", estimated_num_employees: 120 + (hash(p.company) % 900) },
      phone_numbers: [],
    },
  };
});

app.get("/api/v1/webhook_result/:id", async (req, reply) => {
  await wait();
  bump("apollo.poll");
  if (!req.headers["x-api-key"]) return reply.code(401).send("Invalid API key");
  const { id } = req.params as { id: string };
  const r = apolloReqs.get(id);
  if (!r) return reply.code(404).send({ error: "request_id_unknown" });
  r.polls++;
  if (r.scenario === "apollotimeout" || r.polls < r.pollsNeeded) {
    return reply.code(404).send({ error: "result_pending", retry_after_seconds: 1 });
  }
  const phones: Record<string, unknown>[] = [];
  const m = mobileFor(r.slug);
  const p = personFor(r.slug);
  const landline = { raw_number: "+1 212 555 0100", sanitized_number: "+12125550100", type_cd: "work_hq", status_cd: "valid_number", position: 0 };
  switch (r.scenario) {
    case "apollo_mobile":
    case "apollo429":
    case "slow":
      phones.push({ raw_number: m.display, sanitized_number: m.e164, type_cd: "mobile", status_cd: "valid_number", position: 0 }, { ...landline, position: 1 });
      break;
    case "nocode":
      phones.push({ raw_number: "9876543210", sanitized_number: "9876543210", type_cd: "mobile", status_cd: "valid_number", position: 0 });
      break;
    case "nomobile":
    case "fullenrich":
    case "fecredits":
    case "fe500":
    case "inactive":
    case "none":
      phones.push(landline);
      break;
  }
  void p;
  return {
    request_id: id,
    webhook_status: "success",
    request_type: "phone",
    last_dispatched_at: new Date().toISOString(),
    failure_reason: null,
    webhook_result: {
      status: "success",
      total_requested_enrichments: 1,
      unique_enriched_records: 1,
      missing_records: 0,
      credits_consumed: phones.some((x) => x.type_cd === "mobile") ? 8 : 0,
      people: [{ id: `apollo_${hash(r.slug).toString(16)}`, status: "success", phone_numbers: phones }],
    },
  };
});

// ------------------------------------------------------------ FullEnrich
app.post("/api/v2/contact/enrich/bulk", async (req, reply) => {
  await wait();
  bump("fullenrich.submit");
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return reply.code(401).send({ error: "error.authorization.not_bearer" });
  const body = (req.body ?? {}) as { name?: string; data?: Record<string, unknown>[] };
  if (!body.name) return reply.code(400).send({ error: "error.enrichment.name.empty" });
  if (!body.data?.length) return reply.code(400).send({ error: "error.enrichment.data.empty" });
  const item = body.data[0]!;
  if ("first_name" in item && !item.first_name) return reply.code(400).send({ error: "error.enrichment.first_name.empty" });
  const url = String(item.linkedin_url ?? "");
  const slug = slugOf(url);
  const sc = scenarioFor(slug);
  if (sc === "fe500" || sc === "bothdown") return reply.code(500).send({ error: "internal" });
  const id = `fe-${hash(`fe:${slug}:${feReqs.size}`).toString(16)}-${feReqs.size}`;
  feReqs.set(id, { slug, polls: 0, scenario: sc, custom: (item.custom as Record<string, string>) ?? {}, input: item });
  return { enrichment_id: id };
});

app.get("/api/v2/contact/enrich/bulk/:id", async (req, reply) => {
  await wait();
  bump("fullenrich.poll");
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return reply.code(401).send({ error: "error.authorization.not_bearer" });
  const { id } = req.params as { id: string };
  const r = feReqs.get(id);
  if (!r) return reply.code(404).send({ error: "error.enrichment.not_found" });
  r.polls++;
  if (r.polls < 2) return reply.code(400).send({ error: "error.enrichment.in_progress", message: "Enrichment not ready, try again in 30 seconds" });
  if (r.scenario === "fecredits") return reply.code(402).send({ id, name: "waterfall", status: "CREDITS_INSUFFICIENT", cost: { credits: 0 }, data: [] });
  if (r.scenario === "nomatch") return { id, name: "waterfall", status: "FINISHED", cost: { credits: 0 }, data: [{ input: r.input, custom: r.custom, contact_info: { most_probable_phone: null, phones: [], work_emails: [], personal_emails: [] }, profile: null }] };

  const m = mobileFor(r.slug);
  const p = personFor(r.slug);
  const mobile = { number: m.display, region: m.region, line_type: "MOBILE", line_status: r.scenario === "inactive" ? "INACTIVE" : "ACTIVE", ownership_match: "CONFIRMED", ownership_match_confidence: 90, connect_rate: "HIGH" };
  const landline = { number: "+33 1 42 86 82 82", region: "FR", line_type: "LANDLINE", line_status: "ACTIVE" };
  const givesMobile = ["fullenrich", "apollo500", "apollotimeout", "nocode", "inactive"].includes(r.scenario);
  const phones = givesMobile ? [mobile, landline] : r.scenario === "none" || r.scenario === "nomobile" ? [landline] : [];
  return {
    id,
    name: "waterfall",
    status: "FINISHED",
    cost: { credits: givesMobile ? 10 : 0 },
    data: [
      {
        input: { first_name: r.input.first_name ?? null, last_name: r.input.last_name ?? null, professional_network_url: r.input.linkedin_url },
        custom: r.custom,
        contact_info: {
          most_probable_work_email: { email: `${p.first}.${p.last}@${p.domain}`.toLowerCase(), status: "DELIVERABLE" },
          most_probable_personal_email: null,
          most_probable_phone: phones[0] ?? null,
          work_emails: [{ email: `${p.first}.${p.last}@${p.domain}`.toLowerCase(), status: "DELIVERABLE" }],
          personal_emails: [],
          phones,
        },
        profile: {
          id: `fe_${hash(r.slug).toString(16)}`,
          full_name: `${p.first} ${p.last}`,
          first_name: p.first,
          last_name: p.last,
          headline: `${p.title} at ${p.company}`,
          location: { country: p.country, country_code: m.region, city: p.city, region: p.state },
          employment: { current: { title: p.title, is_current: true, company: { name: p.company, domain: p.domain, website: `https://${p.domain}`, headcount: 200, industry: { main_industry: "Software Development" } } }, all: [] },
        },
      },
    ],
  };
});

return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 4100);
  buildMockProviders()
    .listen({ port, host: "127.0.0.1" })
    .then(() => console.log(`mock providers listening on http://127.0.0.1:${port}`));
}
