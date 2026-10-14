-- =============================================================================
-- Enrichment Waterfall — initial schema
-- Designed for 1M+ profiles: narrow hot table (profiles), side tables for
-- multi-valued data (phones/emails), append-only attempt log with raw JSON.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- profiles — one row per canonical LinkedIn URL (the "golden record")
-- -----------------------------------------------------------------------------
create table if not exists profiles (
  id                  uuid primary key default gen_random_uuid(),

  linkedin_url        text not null,                 -- canonical form, unique
  linkedin_slug       text not null,
  linkedin_kind       text not null default 'profile' -- 'profile' | 'sales_navigator'
                      check (linkedin_kind in ('profile','sales_navigator')),

  first_name          text,
  last_name           text,
  full_name           text,
  headline            text,
  job_title           text,
  seniority           text,
  photo_url           text,

  company_name        text,
  company_domain      text,
  company_website     text,
  company_linkedin_url text,
  company_industry    text,
  company_size        integer,

  city                text,
  state               text,
  country             text,
  country_iso         char(2),

  -- the golden field, always E.164 with country code
  mobile_number       text,
  mobile_country_code text,                           -- e.g. '+91'
  mobile_country_iso  char(2),                        -- e.g. 'IN'
  mobile_line_type    text,                           -- 'mobile' | 'fixed_line_or_mobile'
  mobile_source       text check (mobile_source in ('apollo','fullenrich','manual')),
  mobile_found_at     timestamptz,

  work_email          text,
  work_email_status   text,
  personal_email      text,

  enrichment_status   text not null default 'pending'
                      check (enrichment_status in ('pending','in_progress','mobile_found','mobile_missing','failed')),
  enrichment_source   text,                           -- provider that produced the final state
  last_enriched_at    timestamptz,                    -- last time a full waterfall finished
  last_attempt_at     timestamptz,
  attempt_count       integer not null default 0,
  last_error          text,

  -- in-flight lock so two workers never enrich the same profile at once
  lock_token          uuid,
  locked_at           timestamptz,

  apollo_person_id    text,
  fullenrich_profile_id text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists profiles_linkedin_url_key on profiles (linkedin_url);
create index if not exists profiles_mobile_number_idx on profiles (mobile_number) where mobile_number is not null;
create index if not exists profiles_status_idx on profiles (enrichment_status);
create index if not exists profiles_company_domain_idx on profiles (company_domain) where company_domain is not null;
create index if not exists profiles_updated_at_idx on profiles (updated_at desc);
create index if not exists profiles_work_email_idx on profiles (lower(work_email)) where work_email is not null;
create index if not exists profiles_locked_idx on profiles (locked_at) where lock_token is not null;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- profile_phones — every phone number any provider ever returned
-- -----------------------------------------------------------------------------
create table if not exists profile_phones (
  id                  bigserial primary key,
  profile_id          uuid not null references profiles(id) on delete cascade,
  number_e164         text not null,
  country_code        text,
  country_iso         char(2),
  line_type           text not null default 'unknown'
                      check (line_type in ('mobile','fixed_line_or_mobile','landline','voip','other','unknown')),
  is_mobile           boolean not null default false,
  provider            text not null check (provider in ('apollo','fullenrich','manual')),
  provider_type       text,                           -- raw provider classification
  provider_status     text,
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  unique (profile_id, number_e164)
);
create index if not exists profile_phones_number_idx on profile_phones (number_e164);

-- -----------------------------------------------------------------------------
-- profile_emails — every email any provider ever returned
-- -----------------------------------------------------------------------------
create table if not exists profile_emails (
  id                  bigserial primary key,
  profile_id          uuid not null references profiles(id) on delete cascade,
  email               text not null,
  kind                text not null check (kind in ('work','personal','unknown')),
  status              text,
  provider            text not null check (provider in ('apollo','fullenrich','manual')),
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  unique (profile_id, email)
);
create index if not exists profile_emails_email_idx on profile_emails (lower(email));

-- -----------------------------------------------------------------------------
-- enrichment_attempts — append-only log of every provider call (raw JSON kept)
-- -----------------------------------------------------------------------------
create table if not exists enrichment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references profiles(id) on delete cascade,
  batch_item_id       uuid,
  provider            text not null check (provider in ('apollo','fullenrich')),
  external_request_id text,
  status              text not null default 'submitted'
                      check (status in ('submitted','polling','completed','failed','timed_out')),
  outcome             text check (outcome in ('mobile_found','mobile_missing','no_match','error','timed_out')),
  phones_found        integer not null default 0,
  emails_found        integer not null default 0,
  credits_used        numeric(10,2),
  error_code          text,
  error_message       text,
  request_payload     jsonb,
  response_payload    jsonb,                          -- synchronous response
  result_payload      jsonb,                          -- asynchronous result (poll/webhook)
  poll_count          integer not null default 0,
  next_poll_at        timestamptz,
  submitted_at        timestamptz not null default now(),
  completed_at        timestamptz
);
create index if not exists enrichment_attempts_profile_idx on enrichment_attempts (profile_id, submitted_at desc);
create index if not exists enrichment_attempts_external_idx on enrichment_attempts (provider, external_request_id);
create index if not exists enrichment_attempts_open_idx on enrichment_attempts (status, next_poll_at) where status in ('submitted','polling');

-- -----------------------------------------------------------------------------
-- batches — one CSV upload
-- -----------------------------------------------------------------------------
create table if not exists batches (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  file_name           text,
  created_by          text,
  status              text not null default 'queued'
                      check (status in ('queued','processing','completed','cancelled','failed')),
  total_rows          integer not null default 0,     -- rows in the file
  queued_rows         integer not null default 0,     -- rows that went to the queue
  processed_count     integer not null default 0,     -- rows in a terminal state
  mobile_found_count  integer not null default 0,
  mobile_missing_count integer not null default 0,
  cached_count        integer not null default 0,     -- served from DB without provider calls
  invalid_count       integer not null default 0,
  duplicate_count     integer not null default 0,
  failed_count        integer not null default 0,
  cancelled_count     integer not null default 0,
  column_mapping      jsonb,
  source_headers      text[],
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  updated_at          timestamptz not null default now()
);
create index if not exists batches_created_at_idx on batches (created_at desc);

drop trigger if exists batches_set_updated_at on batches;
create trigger batches_set_updated_at before update on batches
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- batch_items — one row per CSV line
-- -----------------------------------------------------------------------------
create table if not exists batch_items (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references batches(id) on delete cascade,
  row_number          integer not null,
  input_url           text,
  input_first_name    text,
  input_last_name     text,
  input_company       text,
  input_row           jsonb,                          -- original columns for export passthrough
  profile_id          uuid references profiles(id) on delete set null,
  status              text not null default 'pending'
                      check (status in ('pending','processing','mobile_found','mobile_missing','invalid','duplicate','failed','cancelled')),
  result_source       text,                           -- 'cache' | 'apollo' | 'fullenrich'
  error               text,
  duplicate_of_row    integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  unique (batch_id, row_number)
);
create index if not exists batch_items_batch_status_idx on batch_items (batch_id, status);
create index if not exists batch_items_profile_idx on batch_items (profile_id) where profile_id is not null;

drop trigger if exists batch_items_set_updated_at on batch_items;
create trigger batch_items_set_updated_at before update on batch_items
  for each row execute function set_updated_at();

-- Counter maintenance: batches.* counts are derived from batch_items transitions,
-- so they are always consistent regardless of which worker finished the row.
create or replace function batch_items_counters() returns trigger
language plpgsql as $$
declare
  old_status text := case when tg_op = 'INSERT' then null else old.status end;
  new_status text := new.status;
  old_source text := case when tg_op = 'INSERT' then null else old.result_source end;
  d_processed int := 0; d_found int := 0; d_missing int := 0; d_cached int := 0;
  d_invalid int := 0; d_dup int := 0; d_failed int := 0; d_cancelled int := 0;
begin
  if tg_op = 'UPDATE' and old_status = new_status and old_source is not distinct from new.result_source then
    return new;
  end if;

  -- remove contribution of the old state
  if old_status is not null then
    if old_status not in ('pending','processing') then d_processed := d_processed - 1; end if;
    if old_status = 'mobile_found'   then d_found := d_found - 1; end if;
    if old_status = 'mobile_missing' then d_missing := d_missing - 1; end if;
    if old_status in ('mobile_found','mobile_missing') and old_source = 'cache' then d_cached := d_cached - 1; end if;
    if old_status = 'invalid'   then d_invalid := d_invalid - 1; end if;
    if old_status = 'duplicate' then d_dup := d_dup - 1; end if;
    if old_status = 'failed'    then d_failed := d_failed - 1; end if;
    if old_status = 'cancelled' then d_cancelled := d_cancelled - 1; end if;
  end if;

  -- add contribution of the new state
  if new_status not in ('pending','processing') then d_processed := d_processed + 1; end if;
  if new_status = 'mobile_found'   then d_found := d_found + 1; end if;
  if new_status = 'mobile_missing' then d_missing := d_missing + 1; end if;
  if new_status in ('mobile_found','mobile_missing') and new.result_source = 'cache' then d_cached := d_cached + 1; end if;
  if new_status = 'invalid'   then d_invalid := d_invalid + 1; end if;
  if new_status = 'duplicate' then d_dup := d_dup + 1; end if;
  if new_status = 'failed'    then d_failed := d_failed + 1; end if;
  if new_status = 'cancelled' then d_cancelled := d_cancelled + 1; end if;

  update batches b set
    processed_count      = b.processed_count + d_processed,
    mobile_found_count   = b.mobile_found_count + d_found,
    mobile_missing_count = b.mobile_missing_count + d_missing,
    cached_count         = b.cached_count + d_cached,
    invalid_count        = b.invalid_count + d_invalid,
    duplicate_count      = b.duplicate_count + d_dup,
    failed_count         = b.failed_count + d_failed,
    cancelled_count      = b.cancelled_count + d_cancelled,
    started_at           = coalesce(b.started_at, case when new_status = 'processing' then now() end),
    status               = case
                             when b.status in ('cancelled','failed') then b.status
                             when b.processed_count + d_processed >= b.total_rows and b.total_rows > 0 then 'completed'
                             when b.status = 'queued' and new_status <> 'pending' then 'processing'
                             else b.status
                           end,
    completed_at         = case
                             when b.completed_at is not null then b.completed_at
                             when b.processed_count + d_processed >= b.total_rows and b.total_rows > 0 then now()
                             else null
                           end
  where b.id = new.batch_id;

  return new;
end $$;

drop trigger if exists batch_items_counters_trg on batch_items;
create trigger batch_items_counters_trg
  after insert or update of status, result_source on batch_items
  for each row execute function batch_items_counters();

-- -----------------------------------------------------------------------------
-- provider_events — raw inbound webhooks (idempotency + audit)
-- -----------------------------------------------------------------------------
create table if not exists provider_events (
  id                  bigserial primary key,
  provider            text not null,
  external_request_id text,
  event_key           text,                           -- dedupe key
  headers             jsonb,
  payload             jsonb not null,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  error               text
);
create unique index if not exists provider_events_event_key_idx on provider_events (provider, event_key) where event_key is not null;
create index if not exists provider_events_request_idx on provider_events (provider, external_request_id);

-- -----------------------------------------------------------------------------
-- Row Level Security. The backend connects with the postgres role (bypasses
-- RLS). Browser clients using the anon/publishable key get read-only access
-- when authenticated, and no write access at all.
-- -----------------------------------------------------------------------------
alter table profiles            enable row level security;
alter table profile_phones      enable row level security;
alter table profile_emails      enable row level security;
alter table enrichment_attempts enable row level security;
alter table batches             enable row level security;
alter table batch_items         enable row level security;
alter table provider_events     enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'drop policy if exists "authenticated read" on profiles';
    execute 'create policy "authenticated read" on profiles for select to authenticated using (true)';
    execute 'drop policy if exists "authenticated read" on profile_phones';
    execute 'create policy "authenticated read" on profile_phones for select to authenticated using (true)';
    execute 'drop policy if exists "authenticated read" on profile_emails';
    execute 'create policy "authenticated read" on profile_emails for select to authenticated using (true)';
    execute 'drop policy if exists "authenticated read" on batches';
    execute 'create policy "authenticated read" on batches for select to authenticated using (true)';
    execute 'drop policy if exists "authenticated read" on batch_items';
    execute 'create policy "authenticated read" on batch_items for select to authenticated using (true)';
  end if;
end $$;
