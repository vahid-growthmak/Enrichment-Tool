import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, unknown, unknown>;

export type ProfileStatus = "pending" | "in_progress" | "mobile_found" | "mobile_missing" | "failed";
export type Provider = "apollo" | "fullenrich";
export type PhoneSource = Provider | "manual";
export type LineType = "mobile" | "fixed_line_or_mobile" | "landline" | "voip" | "other" | "unknown";
export type AttemptStatus = "submitted" | "polling" | "completed" | "failed" | "timed_out";
export type AttemptOutcome = "mobile_found" | "mobile_missing" | "no_match" | "error" | "timed_out";
export type BatchStatus = "queued" | "processing" | "completed" | "cancelled" | "failed";
export type BatchItemStatus =
  | "pending"
  | "processing"
  | "mobile_found"
  | "mobile_missing"
  | "invalid"
  | "duplicate"
  | "failed"
  | "cancelled";
export type ResultSource = "cache" | Provider;

export interface ProfilesTable {
  id: Generated<string>;
  linkedin_url: string;
  linkedin_slug: string;
  linkedin_kind: "profile" | "sales_navigator";
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  headline: string | null;
  job_title: string | null;
  seniority: string | null;
  photo_url: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_website: string | null;
  company_linkedin_url: string | null;
  company_industry: string | null;
  company_size: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  country_iso: string | null;
  mobile_number: string | null;
  mobile_country_code: string | null;
  mobile_country_iso: string | null;
  mobile_line_type: string | null;
  mobile_source: PhoneSource | null;
  mobile_found_at: Timestamp | null;
  work_email: string | null;
  work_email_status: string | null;
  personal_email: string | null;
  enrichment_status: ProfileStatus;
  enrichment_source: string | null;
  last_enriched_at: Timestamp | null;
  last_attempt_at: Timestamp | null;
  attempt_count: Generated<number>;
  last_error: string | null;
  lock_token: string | null;
  locked_at: Timestamp | null;
  apollo_person_id: string | null;
  fullenrich_profile_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProfilePhonesTable {
  id: Generated<number>;
  profile_id: string;
  number_e164: string;
  country_code: string | null;
  country_iso: string | null;
  line_type: LineType;
  is_mobile: boolean;
  provider: PhoneSource;
  provider_type: string | null;
  provider_status: string | null;
  raw: Json | null;
  created_at: GeneratedTimestamp;
}

export interface ProfileEmailsTable {
  id: Generated<number>;
  profile_id: string;
  email: string;
  kind: "work" | "personal" | "unknown";
  status: string | null;
  provider: PhoneSource;
  raw: Json | null;
  created_at: GeneratedTimestamp;
}

export interface EnrichmentAttemptsTable {
  id: Generated<string>;
  profile_id: string;
  batch_item_id: string | null;
  provider: Provider;
  external_request_id: string | null;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  phones_found: Generated<number>;
  emails_found: Generated<number>;
  credits_used: number | null;
  error_code: string | null;
  error_message: string | null;
  request_payload: Json | null;
  response_payload: Json | null;
  result_payload: Json | null;
  poll_count: Generated<number>;
  next_poll_at: Timestamp | null;
  submitted_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
}

export interface BatchesTable {
  id: Generated<string>;
  name: string;
  file_name: string | null;
  created_by: string | null;
  status: BatchStatus;
  total_rows: number;
  queued_rows: number;
  processed_count: Generated<number>;
  mobile_found_count: Generated<number>;
  mobile_missing_count: Generated<number>;
  cached_count: Generated<number>;
  invalid_count: Generated<number>;
  duplicate_count: Generated<number>;
  failed_count: Generated<number>;
  cancelled_count: Generated<number>;
  column_mapping: Json | null;
  source_headers: string[] | null;
  created_at: GeneratedTimestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  updated_at: GeneratedTimestamp;
}

export interface BatchItemsTable {
  id: Generated<string>;
  batch_id: string;
  row_number: number;
  input_url: string | null;
  input_first_name: string | null;
  input_last_name: string | null;
  input_company: string | null;
  input_row: Json | null;
  profile_id: string | null;
  status: BatchItemStatus;
  result_source: ResultSource | null;
  error: string | null;
  duplicate_of_row: number | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
}

export interface ProviderEventsTable {
  id: Generated<number>;
  provider: string;
  external_request_id: string | null;
  event_key: string | null;
  headers: Json | null;
  payload: Json;
  received_at: GeneratedTimestamp;
  processed_at: Timestamp | null;
  error: string | null;
}

export interface Database {
  profiles: ProfilesTable;
  profile_phones: ProfilePhonesTable;
  profile_emails: ProfileEmailsTable;
  enrichment_attempts: EnrichmentAttemptsTable;
  batches: BatchesTable;
  batch_items: BatchItemsTable;
  provider_events: ProviderEventsTable;
}

export type Profile = Selectable<ProfilesTable>;
export type NewProfile = Insertable<ProfilesTable>;
export type ProfileUpdate = Updateable<ProfilesTable>;
export type ProfilePhone = Selectable<ProfilePhonesTable>;
export type ProfileEmail = Selectable<ProfileEmailsTable>;
export type EnrichmentAttempt = Selectable<EnrichmentAttemptsTable>;
export type Batch = Selectable<BatchesTable>;
export type BatchItem = Selectable<BatchItemsTable>;
