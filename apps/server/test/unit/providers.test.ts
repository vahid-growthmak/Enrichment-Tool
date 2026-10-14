import { describe, expect, it } from "vitest";
import { parsePerson } from "../../src/providers/apollo.js";
import { parseResult } from "../../src/providers/fullenrich.js";

describe("apollo parsePerson", () => {
  it("maps identity, organisation, emails and phones", () => {
    const d = parsePerson(
      {
        id: "abc",
        first_name: "John",
        last_name: "Doe",
        name: "John Doe",
        title: "CTO",
        email: "john@acme.com",
        email_status: "verified",
        city: "Austin",
        state: "Texas",
        country: "United States",
        organization: { name: "Acme", primary_domain: "acme.com", website_url: "https://acme.com", industry: "software", estimated_num_employees: 50 },
        personal_emails: ["john@gmail.com"],
        contact: { phone_numbers: [{ raw_number: "+1 415 555 2671", sanitized_number: "+14155552671", type_cd: "mobile", status_cd: "valid_number" }, { sanitized_number: "+12125550100", type_cd: "work_hq", status_cd: "invalid_number" }] },
      },
      {},
    );
    expect(d.person).toMatchObject({ externalId: "abc", firstName: "John", jobTitle: "CTO", companyName: "Acme", companyDomain: "acme.com", countryIso: "US", companySize: 50 });
    expect(d.emails.map((e) => [e.email, e.kind])).toEqual([
      ["john@acme.com", "work"],
      ["john@gmail.com", "personal"],
    ]);
    expect(d.phones).toHaveLength(1); // invalid_number dropped
    expect(d.phones[0]).toMatchObject({ raw: "+14155552671", providerType: "mobile", regionIso: "US" });
  });
});

describe("fullenrich parseResult", () => {
  it("maps the documented FINISHED payload", () => {
    const r = parseResult({
      id: "x",
      status: "FINISHED",
      cost: { credits: 14 },
      data: [
        {
          contact_info: {
            most_probable_work_email: { email: "john.snow@example.com", status: "DELIVERABLE" },
            most_probable_phone: { number: "+1 555-123-4567", region: "US", line_type: "MOBILE", line_status: "ACTIVE" },
            work_emails: [{ email: "john.snow@example.com", status: "DELIVERABLE" }],
            personal_emails: [{ email: "johnsnow@gmail.com", status: "DELIVERABLE" }],
            phones: [
              { number: "+1 555-123-4567", region: "US", line_type: "MOBILE", line_status: "ACTIVE" },
              { number: "+33 1 42 86 82 82", region: "FR", line_type: "LANDLINE", line_status: "ACTIVE" },
            ],
          },
          profile: {
            id: "pid",
            first_name: "John",
            last_name: "Snow",
            full_name: "John Snow",
            headline: "Head of Sales",
            location: { country: "United States", country_code: "US", city: "San Francisco", region: "California" },
            employment: { current: { title: "Head of Sales Operations", company: { name: "Example Inc", domain: "example.com", headcount: 250, industry: { main_industry: "Software Development" } } } },
          },
        },
      ],
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.creditsUsed).toBe(14);
    expect(r.person).toMatchObject({ firstName: "John", jobTitle: "Head of Sales Operations", companyName: "Example Inc", companyDomain: "example.com", countryIso: "US", city: "San Francisco", companySize: 250 });
    expect(r.phones.map((p) => [p.raw, p.providerType, p.regionIso])).toEqual([
      ["+1 555-123-4567", "mobile", "US"],
      ["+33 1 42 86 82 82", "landline", "FR"],
    ]);
    expect(r.emails.map((e) => e.kind)).toEqual(["work", "personal"]);
  });
  it("maps non-terminal and failure statuses", () => {
    expect(parseResult({ status: "IN_PROGRESS" }).kind).toBe("pending");
    expect(parseResult({ status: "CREDITS_INSUFFICIENT" })).toMatchObject({ kind: "failed", code: "credits_insufficient", retryable: false });
    expect(parseResult({ status: "RATE_LIMIT" })).toMatchObject({ kind: "failed", retryable: true });
    expect(parseResult({ status: "FINISHED", data: [] })).toMatchObject({ kind: "completed", phones: [] });
  });
});
