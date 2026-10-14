import type { ProviderPhoneHint } from "../lib/phone.js";

export type ProviderName = "apollo" | "fullenrich";

export interface EnrichInput {
  linkedinUrl: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  /** our profile id, passed through as a correlation key when the provider supports it */
  profileId: string;
}

export interface ProviderPerson {
  externalId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  headline?: string | null;
  jobTitle?: string | null;
  seniority?: string | null;
  photoUrl?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  companyLinkedinUrl?: string | null;
  companyIndustry?: string | null;
  companySize?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryIso?: string | null;
}

export interface ProviderPhone {
  raw: string;
  providerType: ProviderPhoneHint;
  providerStatus?: string | null;
  /** region hint for numbers delivered without a + prefix */
  regionIso?: string | null;
  /** provider says the line is dead; never accept as the golden mobile */
  inactive?: boolean;
  record: unknown;
}

export interface ProviderEmail {
  email: string;
  kind: "work" | "personal" | "unknown";
  status?: string | null;
  record: unknown;
}

export interface ProviderData {
  person: ProviderPerson | null;
  phones: ProviderPhone[];
  emails: ProviderEmail[];
  creditsUsed?: number | null;
  raw: unknown;
}

export type SubmitResult =
  | ({ kind: "completed" } & ProviderData)
  | ({ kind: "pending"; externalRequestId: string } & ProviderData)
  | { kind: "no_match"; raw: unknown };

export type PollResult =
  | { kind: "pending"; retryInMs?: number; raw?: unknown }
  | ({ kind: "completed" } & ProviderData)
  | { kind: "failed"; code: string; message: string; retryable: boolean; raw?: unknown };

export interface EnrichmentProvider {
  readonly name: ProviderName;
  readonly enabled: boolean;
  submit(input: EnrichInput): Promise<SubmitResult>;
  poll(externalRequestId: string): Promise<PollResult>;
}
