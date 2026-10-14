import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) => z.coerce.number().int().default(def);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: bool.default(false),
  DATABASE_POOL_MAX: int(10),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  PUBLIC_BASE_URL: z.string().default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  AUTH_DISABLED: bool.default(false),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  APOLLO_API_KEY: z.string().optional(),
  APOLLO_BASE_URL: z.string().default("https://api.apollo.io"),
  APOLLO_RATE_PER_MINUTE: int(50),
  APOLLO_REVEAL_PERSONAL_EMAILS: bool.default(false),
  APOLLO_POLL_INTERVAL_SECONDS: int(10),
  APOLLO_PHONE_TIMEOUT_MINUTES: int(15),

  FULLENRICH_API_KEY: z.string().optional(),
  FULLENRICH_BASE_URL: z.string().default("https://app.fullenrich.com"),
  FULLENRICH_RATE_PER_MINUTE: int(50),
  FULLENRICH_ENRICH_FIELDS: z.string().default("contact.phones"),
  FULLENRICH_POLL_INTERVAL_SECONDS: int(20),
  FULLENRICH_TIMEOUT_MINUTES: int(30),
  FULLENRICH_USE_WEBHOOK: bool.default(false),

  WEBHOOK_SECRET: z.string().default(""),

  MOBILE_MISSING_COOLDOWN_DAYS: int(30), // 0 = never re-enrich a 'mobile_missing' profile automatically
  STALE_AFTER_DAYS: int(0),             // 0 = cached mobiles never expire
  DEFAULT_PHONE_REGION: z.string().length(2).optional(),
  LOCK_STALE_MINUTES: int(90),
  PROVIDER_RETRY_DELAYS_MS: z.string().default("15000,60000"), // back-off between retries of a failed provider call

  WORKER_CONCURRENCY: int(5),
  MAX_BATCH_ROWS: int(20000),
  MAX_UPLOAD_MB: int(25),
});

export type Config = z.infer<typeof schema> & {
  apolloEnabled: boolean;
  fullEnrichEnabled: boolean;
  fullEnrichFields: string[];
  providerRetryDelaysMs: number[];
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const c = parsed.data;
  if (!c.AUTH_DISABLED && (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required unless AUTH_DISABLED=true");
  }
  cached = {
    ...c,
    apolloEnabled: Boolean(c.APOLLO_API_KEY),
    fullEnrichEnabled: Boolean(c.FULLENRICH_API_KEY),
    fullEnrichFields: c.FULLENRICH_ENRICH_FIELDS.split(",").map((s) => s.trim()).filter(Boolean),
    providerRetryDelaysMs: c.PROVIDER_RETRY_DELAYS_MS.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0),
  };
  return cached;
}

/** Test helper: reset the memoized config. */
export function resetConfig() {
  cached = null;
}
