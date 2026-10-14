import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

const { Pool, types } = pg;

// Keep bigint/numeric readable as JS numbers for counters and credits.
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric

export type Db = Kysely<Database>;

export interface DbOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
}

export function createPool(opts: DbOptions) {
  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "enrichment",
  });
}

export function createDb(opts: DbOptions): { db: Db; pool: pg.Pool } {
  const pool = createPool(opts);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
