# Waterfall — mobile number enrichment

Finds mobile numbers for LinkedIn profiles with a strict, cost-controlled chain:

1. **Database** (Supabase Postgres) — if we already own a mobile for the URL, return it. Zero cost.
2. **Apollo** — people match + phone reveal (asynchronous, polled). Mobile found → saved, stop.
3. **FullEnrich** — fallback only. Mobile found → saved, stop.

A "mobile" is a valid E.164 number **with a country code** that the provider or the numbering plan identifies as mobile. Landlines, switchboards, inactive lines and numbers whose country cannot be determined are stored for audit but never used as the result. Everything a provider returns (identity, company, emails, every phone, raw JSON) is kept in normalized tables.

## Layout

```
apps/server   Fastify API + BullMQ worker (TypeScript, Node 22)
apps/web      Next.js 15 UI
```

| Process | Entry | Purpose |
|---|---|---|
| API | `apps/server/src/main.ts` | REST endpoints, CSV upload/export, auth |
| Worker | `apps/server/src/worker-main.ts` | Runs the waterfall jobs (Redis queue) |
| Web | `apps/web` | UI |
| Mock providers | `apps/server/src/mock/providers-server.ts` | Local stand-in for Apollo + FullEnrich |

## Local development

Prerequisites: Node 22, pnpm, Postgres, Redis.

```bash
pnpm install
createdb enrichment_dev                      # or any Postgres database
cp .env.example apps/server/.env             # then edit DATABASE_URL etc.
# apps/web/.env.local: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_AUTH_DISABLED=true

cd apps/server
pnpm dev:mock       # mock Apollo + FullEnrich on :4100
pnpm dev            # API on :4000 (runs migrations on boot)
pnpm dev:worker     # worker
cd ../web && pnpm dev   # UI on :3000
```

With `APOLLO_BASE_URL` / `FULLENRICH_BASE_URL` pointing at the mock (`http://127.0.0.1:4100`), the slug of the LinkedIn URL chooses the scenario (`nomobile-`, `fe-`, `apollo500-`, `nomatch-`, `apollotimeout-`, `fecredits-`, `bothdown-`, `nocode-`, `inactive-`, `slow-`; anything else is a deterministic mix). See the header of the mock file.

### Tests

```bash
cd apps/server
pnpm test:unit            # URL canonicalisation, phone rules, cache policy, CSV, provider parsers
pnpm test:integration     # real API + worker + queue against the in-process mock providers
```

Integration tests use `.env.test` (database `enrichment_test`, Redis db 5) and cover: cache hits, cooldown, forced re-enrichment, Apollo → FullEnrich fallback, 429/500/timeouts, credits exhausted, rejected numbers without country code, inactive lines, concurrent requests for the same profile, stale lock recovery, mixed CSV batches with invalid/duplicate/cached/failed rows, cancel, retry-failed, export, and a 500-row stress run.

## Configuration

All settings are environment variables; see `.env.example`. The important ones:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase: use the **transaction pooler** URL on Railway) |
| `DATABASE_SSL` | `true` for Supabase |
| `REDIS_URL` | Redis for the queue |
| `APOLLO_API_KEY`, `FULLENRICH_API_KEY` | Provider keys. A missing key disables that layer (logged). |
| `APOLLO_RATE_PER_MINUTE`, `FULLENRICH_RATE_PER_MINUTE` | Per-provider rate limits shared across workers |
| `MOBILE_MISSING_COOLDOWN_DAYS` | Don't re-buy a "no mobile" answer for this long (0 = never automatically) |
| `STALE_AFTER_DAYS` | Re-enrich cached mobiles older than this (0 = never) |
| `AUTH_DISABLED` | `true` locally. In production the API verifies Supabase sessions. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Needed by the API to verify sessions when auth is on |
| `CORS_ORIGIN` | The web app's public URL |

## Authentication

The web app signs users in with Supabase Auth (email + password). Create users in the Supabase dashboard (Authentication → Users → Add user); there is no self-service sign-up. The API verifies each request's access token against Supabase.

## Database

`apps/server/migrations/*.sql` is the schema. It runs automatically on API/worker boot (`schema_migrations` tracks what was applied) and can also be pasted into the Supabase SQL editor.

Tables: `profiles` (one row per canonical LinkedIn URL — the golden record), `profile_phones`, `profile_emails`, `enrichment_attempts` (every provider call with raw request/response JSON), `batches`, `batch_items`, `provider_events` (raw webhooks). Batch counters are maintained by a trigger so they are always consistent. RLS is enabled; the backend connects as the database owner, browser clients get read-only access when authenticated.

## Deploying on Railway

Three services from this repo (set each service's **Root Directory** to `/` and use the commands below), plus a Redis plugin:

| Service | Build | Start |
|---|---|---|
| api | `pnpm install --frozen-lockfile && pnpm --filter @enrichment/server build` | `pnpm --filter @enrichment/server start` |
| worker | same | `pnpm --filter @enrichment/server start:worker` |
| web | `pnpm install --frozen-lockfile && pnpm --filter web build` | `pnpm --filter web start` |

Environment for **api** and **worker**: everything in the server section of `.env.example` with real values — `DATABASE_URL` (Supabase pooler URL, `DATABASE_SSL=true`), `REDIS_URL` (from the Railway Redis plugin), `APOLLO_API_KEY`, `FULLENRICH_API_KEY`, `AUTH_DISABLED=false`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CORS_ORIGIN=https://<web domain>`, `PUBLIC_BASE_URL=https://<api domain>`, `NODE_ENV=production`.

Environment for **web**: `NEXT_PUBLIC_API_URL=https://<api domain>`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_AUTH_DISABLED=false`.

Only the web service needs a public domain for users; the api needs one too (the browser calls it directly). The worker needs none.

## API

All `/api/v1/*` routes require `Authorization: Bearer <supabase access token>` unless `AUTH_DISABLED=true`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/enrich/single` | `{ linkedinUrl, firstName?, lastName?, company?, force? }` → cached answer or queued job |
| POST | `/api/v1/enrich/validate` | Canonicalise a URL and report whether it is on file |
| GET | `/api/v1/profiles` | Search / filter / paginate |
| GET | `/api/v1/profiles/:id` | Profile + all phones, emails and provider attempts |
| POST | `/api/v1/profiles/:id/re-enrich` | Force the waterfall to run again |
| POST | `/api/v1/batches/preview` | Parse a CSV, detect columns, return a sample |
| POST | `/api/v1/batches` | Create a batch (multipart: `file`, `name`, `urlColumn`, …) |
| GET | `/api/v1/batches`, `/api/v1/batches/:id`, `/api/v1/batches/:id/items` | Status and rows |
| POST | `/api/v1/batches/:id/cancel`, `/api/v1/batches/:id/retry-failed` | Control |
| GET | `/api/v1/batches/:id/export.csv?only=all|mobile_found` | Streaming export: original columns + enrichment |
| GET | `/api/v1/stats`, `/health` | Dashboard numbers, liveness |
