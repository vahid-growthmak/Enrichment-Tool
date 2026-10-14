import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Minimal, dependency-free SQL migration runner.
 * Files in ./migrations run in lexical order inside a transaction; applied
 * versions are recorded in schema_migrations. Safe to run repeatedly.
 */
export async function runMigrations(connectionString: string, opts: { ssl?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    await client.query("select pg_advisory_lock(727272)");
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ version: string }>("select version from schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      log(`applying ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await client.query("select pg_advisory_unlock(727272)");
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runMigrations(url, { ssl: ["1", "true"].includes(String(process.env.DATABASE_SSL).toLowerCase()), log: console.log })
    .then(() => {
      console.log("migrations up to date");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
