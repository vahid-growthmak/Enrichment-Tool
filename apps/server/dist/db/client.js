import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
const { Pool, types } = pg;
// Keep bigint/numeric readable as JS numbers for counters and credits.
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric
export function createPool(opts) {
    return new Pool({
        connectionString: opts.connectionString,
        max: opts.max ?? 10,
        ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        application_name: "enrichment",
    });
}
export function createDb(opts) {
    const pool = createPool(opts);
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    return { db, pool };
}
//# sourceMappingURL=client.js.map