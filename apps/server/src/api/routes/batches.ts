import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { Readable } from "node:stream";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { BatchItemStatus } from "../../db/types.js";
import { clean } from "../../enrichment/repository.js";
import { csvLine, parseCsv, type ColumnMapping } from "../../lib/csv.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { canonicalizeLinkedInUrl } from "../../lib/linkedin-url.js";
import { enqueueBatchDispatch, enqueueEnrichMany } from "../../queue/queue.js";
import { initialJob } from "../../enrichment/waterfall.js";
import { serializeBatch, serializeBatchItem } from "../serializers.js";
import { isUuid } from "./profiles.js";

const MAX_STORED_COLUMNS = 60;

interface UploadFields {
  name?: string;
  urlColumn?: string;
  firstNameColumn?: string;
  lastNameColumn?: string;
  companyColumn?: string;
}

async function readUpload(req: Parameters<FastifyInstance["post"]>[1] extends never ? never : any, maxBytes: number) {
  const data = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!data) throw badRequest("Upload a CSV file in the 'file' field.");
  const buf = await data.toBuffer().catch((e: Error) => {
    if (/limit/i.test(e.message) || (e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw badRequest(`File is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    throw e;
  });
  if (data.file.truncated) throw badRequest(`File is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  const fields: UploadFields = {};
  for (const [k, v] of Object.entries(data.fields as Record<string, unknown>)) {
    const f = Array.isArray(v) ? v[0] : v;
    if (f && typeof f === "object" && "value" in f && typeof (f as { value: unknown }).value === "string") fields[k as keyof UploadFields] = (f as { value: string }).value;
  }
  return { text: buf.toString("utf8"), fileName: data.filename, fields };
}

export async function batchRoutes(app: FastifyInstance, ctx: AppContext) {
  const maxBytes = ctx.cfg.MAX_UPLOAD_MB * 1024 * 1024;

  /** Parse the file, detect columns, and return a preview. Nothing is stored. */
  app.post("/api/v1/batches/preview", async (req) => {
    const { text, fileName } = await readUpload(req, maxBytes);
    let parsed;
    try {
      parsed = parseCsv(text, ctx.cfg.MAX_BATCH_ROWS);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const sample = parsed.rows.slice(0, 5);
    const urlCol = parsed.detected.url;
    let validSample = 0;
    if (urlCol) for (const r of parsed.rows.slice(0, 200)) if (canonicalizeLinkedInUrl(r[urlCol]).ok) validSample++;
    return {
      fileName,
      headers: parsed.headers,
      rowCount: parsed.rowCount,
      detected: parsed.detected,
      sample,
      validInSample: validSample,
      sampleSize: Math.min(parsed.rows.length, 200),
    };
  });

  /** Create a batch: validate every row, create profiles, queue the work. */
  app.post("/api/v1/batches", async (req) => {
    const { text, fileName, fields } = await readUpload(req, maxBytes);
    let parsed;
    try {
      parsed = parseCsv(text, ctx.cfg.MAX_BATCH_ROWS);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (parsed.rowCount === 0) throw badRequest("The CSV has no data rows.");

    const mapping: ColumnMapping = {
      url: fields.urlColumn || parsed.detected.url || "",
      firstName: fields.firstNameColumn ?? parsed.detected.firstName ?? null,
      lastName: fields.lastNameColumn ?? parsed.detected.lastName ?? null,
      company: fields.companyColumn ?? parsed.detected.company ?? null,
    };
    if (!mapping.url || !parsed.headers.includes(mapping.url)) {
      throw badRequest("Could not find the LinkedIn URL column. Choose it explicitly.", { headers: parsed.headers });
    }
    for (const k of ["firstName", "lastName", "company"] as const) {
      if (mapping[k] && !parsed.headers.includes(mapping[k]!)) mapping[k] = null;
    }

    // Validate and de-duplicate in memory first (cheap), then write in bulk.
    type Row = {
      rowNumber: number;
      inputUrl: string | null;
      canonical: string | null;
      slug: string | null;
      kind: "profile" | "sales_navigator" | null;
      status: BatchItemStatus;
      error: string | null;
      duplicateOf: number | null;
      first: string | null;
      last: string | null;
      company: string | null;
      row: Record<string, string>;
    };
    const rows: Row[] = [];
    const firstSeen = new Map<string, number>();
    let invalid = 0;
    let duplicate = 0;
    parsed.rows.forEach((r, i) => {
      const rowNumber = i + 1;
      const inputUrl = (r[mapping.url] ?? "").trim() || null;
      const first = mapping.firstName ? clean(r[mapping.firstName]) : null;
      const last = mapping.lastName ? clean(r[mapping.lastName]) : null;
      const company = mapping.company ? clean(r[mapping.company]) : null;
      const stored = limitColumns(r);
      const canon = canonicalizeLinkedInUrl(inputUrl);
      if (!canon.ok) {
        invalid++;
        rows.push({ rowNumber, inputUrl, canonical: null, slug: null, kind: null, status: "invalid", error: inputUrl ? canon.reason : "empty LinkedIn URL", duplicateOf: null, first, last, company, row: stored });
        return;
      }
      const seen = firstSeen.get(canon.value.url);
      if (seen) {
        duplicate++;
        rows.push({ rowNumber, inputUrl, canonical: canon.value.url, slug: canon.value.slug, kind: canon.value.kind, status: "duplicate", error: `same profile as row ${seen}`, duplicateOf: seen, first, last, company, row: stored });
        return;
      }
      firstSeen.set(canon.value.url, rowNumber);
      rows.push({ rowNumber, inputUrl, canonical: canon.value.url, slug: canon.value.slug, kind: canon.value.kind, status: "pending", error: null, duplicateOf: null, first, last, company, row: stored });
    });

    const batchName = clean(fields.name) ?? (fileName ? fileName.replace(/\.csv$/i, "") : `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
    const batchId = await ctx.db.transaction().execute(async (trx) => {
      const batch = await trx
        .insertInto("batches")
        .values({
          name: batchName,
          file_name: fileName ?? null,
          created_by: req.user.email ?? req.user.id,
          status: "queued",
          total_rows: rows.length,
          queued_rows: rows.length - invalid - duplicate,
          column_mapping: JSON.stringify(mapping),
          source_headers: parsed.headers,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      // 1. ensure a profile exists for every unique canonical URL
      const uniq = rows.filter((r) => r.status === "pending");
      const CH = 1000;
      for (let i = 0; i < uniq.length; i += CH) {
        const slice = uniq.slice(i, i + CH);
        await trx
          .insertInto("profiles")
          .values(
            slice.map((r) => ({
              linkedin_url: r.canonical!,
              linkedin_slug: r.slug!,
              linkedin_kind: r.kind!,
              first_name: r.first,
              last_name: r.last,
              full_name: r.first && r.last ? `${r.first} ${r.last}` : null,
              company_name: r.company,
              enrichment_status: "pending" as const,
            })),
          )
          .onConflict((oc) => oc.column("linkedin_url").doNothing())
          .execute();
        // fill missing identity fields on existing profiles from this upload
        const withNames = slice.filter((r) => r.first || r.last || r.company);
        if (withNames.length) {
          await sql`
            update profiles p set
              first_name   = coalesce(p.first_name, v.first_name),
              last_name    = coalesce(p.last_name, v.last_name),
              full_name    = coalesce(p.full_name, case when v.first_name is not null and v.last_name is not null then v.first_name || ' ' || v.last_name end),
              company_name = coalesce(p.company_name, v.company_name)
            from jsonb_to_recordset(${JSON.stringify(withNames.map((r) => ({ url: r.canonical, first_name: r.first, last_name: r.last, company_name: r.company })))}::jsonb)
              as v(url text, first_name text, last_name text, company_name text)
            where p.linkedin_url = v.url
              and (p.first_name is null or p.last_name is null or p.company_name is null)
          `.execute(trx);
        }
      }
      const urls = uniq.map((r) => r.canonical!);
      const idByUrl = new Map<string, string>();
      for (let i = 0; i < urls.length; i += CH) {
        const found = await trx.selectFrom("profiles").select(["id", "linkedin_url"]).where("linkedin_url", "in", urls.slice(i, i + CH)).execute();
        for (const f of found) idByUrl.set(f.linkedin_url, f.id);
      }

      // 2. batch items
      for (let i = 0; i < rows.length; i += CH) {
        await trx
          .insertInto("batch_items")
          .values(
            rows.slice(i, i + CH).map((r) => ({
              batch_id: batch.id,
              row_number: r.rowNumber,
              input_url: r.inputUrl,
              input_first_name: r.first,
              input_last_name: r.last,
              input_company: r.company,
              input_row: JSON.stringify(r.row),
              profile_id: r.canonical ? (idByUrl.get(r.canonical) ?? null) : null,
              status: r.status,
              error: r.error,
              duplicate_of_row: r.duplicateOf,
              completed_at: r.status === "pending" ? null : new Date(),
            })),
          )
          .execute();
      }
      return batch.id;
    });

    await enqueueBatchDispatch(ctx.queue, batchId);
    const batch = await ctx.db.selectFrom("batches").selectAll().where("id", "=", batchId).executeTakeFirstOrThrow();
    ctx.log.info({ batchId, rows: rows.length, invalid, duplicate, user: req.user.email }, "batch created");
    return { batch: serializeBatch(batch) };
  });

  app.get("/api/v1/batches", async (req) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    const countRow = await ctx.db.selectFrom("batches").select(sql<number>`count(*)`.as("count")).executeTakeFirst();
    const rows = await ctx.db.selectFrom("batches").selectAll().orderBy("created_at", "desc").offset((q.page - 1) * q.limit).limit(q.limit).execute();
    return { items: rows.map(serializeBatch), page: q.page, limit: q.limit, total: Number(countRow?.count ?? 0) };
  });

  app.get("/api/v1/batches/:id", async (req) => {
    const batch = await loadBatch(req.params);
    return { batch: serializeBatch(batch) };
  });

  const itemsQuery = z.object({
    status: z.enum(["pending", "processing", "mobile_found", "mobile_missing", "invalid", "duplicate", "failed", "cancelled"]).optional(),
    q: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  app.get("/api/v1/batches/:id/items", async (req) => {
    const batch = await loadBatch(req.params);
    const q = itemsQuery.safeParse(req.query);
    if (!q.success) throw badRequest("invalid query", q.error.flatten());
    let base = ctx.db.selectFrom("batch_items").leftJoin("profiles", "profiles.id", "batch_items.profile_id").where("batch_items.batch_id", "=", batch.id);
    if (q.data.status) base = base.where("batch_items.status", "=", q.data.status);
    if (q.data.q) {
      const term = `%${q.data.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
      base = base.where((eb) =>
        eb.or([eb("batch_items.input_url", "ilike", term), eb("profiles.full_name", "ilike", term), eb("profiles.company_name", "ilike", term), eb("profiles.mobile_number", "ilike", term)]),
      );
    }
    const countRow = await base.select(sql<number>`count(*)`.as("count")).executeTakeFirst();
    const rows = await base
      .selectAll("batch_items")
      .select([
        "profiles.linkedin_url",
        "profiles.mobile_number",
        "profiles.mobile_country_code",
        "profiles.mobile_country_iso",
        "profiles.first_name",
        "profiles.last_name",
        "profiles.full_name",
        "profiles.job_title",
        "profiles.company_name",
        "profiles.work_email",
      ])
      .orderBy("batch_items.row_number")
      .offset((q.data.page - 1) * q.data.limit)
      .limit(q.data.limit)
      .execute();
    return { items: rows.map(serializeBatchItem), page: q.data.page, limit: q.data.limit, total: Number(countRow?.count ?? 0) };
  });

  app.post("/api/v1/batches/:id/cancel", async (req) => {
    const batch = await loadBatch(req.params);
    if (batch.status === "completed" || batch.status === "cancelled") throw conflict(`Batch is already ${batch.status}.`);
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("batches").set({ status: "cancelled", completed_at: new Date() }).where("id", "=", batch.id).execute();
      await trx
        .updateTable("batch_items")
        .set({ status: "cancelled", completed_at: new Date(), error: "batch cancelled" })
        .where("batch_id", "=", batch.id)
        .where("status", "=", "pending")
        .execute();
    });
    const updated = await ctx.db.selectFrom("batches").selectAll().where("id", "=", batch.id).executeTakeFirstOrThrow();
    ctx.log.info({ batchId: batch.id, user: req.user.email }, "batch cancelled");
    return { batch: serializeBatch(updated) };
  });

  /** Re-queue rows that ended in 'failed' (provider outage, credits, timeouts). */
  app.post("/api/v1/batches/:id/retry-failed", async (req) => {
    const batch = await loadBatch(req.params);
    if (batch.status === "cancelled") throw conflict("Batch is cancelled.");
    const failed = await ctx.db.selectFrom("batch_items").select(["id", "profile_id"]).where("batch_id", "=", batch.id).where("status", "=", "failed").where("profile_id", "is not", null).execute();
    if (failed.length === 0) return { requeued: 0, batch: serializeBatch(batch) };
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("batch_items").set({ status: "pending", error: null, result_source: null, completed_at: null }).where("id", "in", failed.map((f) => f.id)).execute();
      await trx.updateTable("batches").set({ status: "processing", completed_at: null }).where("id", "=", batch.id).execute();
    });
    await enqueueEnrichMany(ctx.queue, failed.map((f) => initialJob(f.profile_id!, { batchItemId: f.id })));
    const updated = await ctx.db.selectFrom("batches").selectAll().where("id", "=", batch.id).executeTakeFirstOrThrow();
    ctx.log.info({ batchId: batch.id, requeued: failed.length, user: req.user.email }, "failed rows re-queued");
    return { requeued: failed.length, batch: serializeBatch(updated) };
  });

  /** Streaming CSV export: original columns + enrichment columns. */
  app.get("/api/v1/batches/:id/export.csv", async (req, reply) => {
    const batch = await loadBatch(req.params);
    const filter = z.object({ only: z.enum(["all", "mobile_found"]).default("all") }).parse(req.query);
    const sourceHeaders = (batch.source_headers ?? []).slice(0, MAX_STORED_COLUMNS);
    const enrichedHeaders = [
      "row_number",
      "enrichment_status",
      "enrichment_source",
      "mobile_number",
      "mobile_country_code",
      "mobile_country_iso",
      "linkedin_url_canonical",
      "first_name",
      "last_name",
      "full_name",
      "job_title",
      "headline",
      "company_name",
      "company_domain",
      "company_website",
      "company_industry",
      "company_size",
      "work_email",
      "work_email_status",
      "personal_email",
      "city",
      "state",
      "country",
      "error",
    ];
    const db = ctx.db;
    async function* generate() {
      yield csvLine([...sourceHeaders, ...enrichedHeaders]);
      let lastRow = 0;
      for (;;) {
        let q = db
          .selectFrom("batch_items")
          .leftJoin("profiles", "profiles.id", "batch_items.profile_id")
          .selectAll("batch_items")
          .select([
            "profiles.linkedin_url",
            "profiles.first_name",
            "profiles.last_name",
            "profiles.full_name",
            "profiles.job_title",
            "profiles.headline",
            "profiles.company_name",
            "profiles.company_domain",
            "profiles.company_website",
            "profiles.company_industry",
            "profiles.company_size",
            "profiles.work_email",
            "profiles.work_email_status",
            "profiles.personal_email",
            "profiles.city",
            "profiles.state",
            "profiles.country",
            "profiles.mobile_number",
            "profiles.mobile_country_code",
            "profiles.mobile_country_iso",
          ])
          .where("batch_items.batch_id", "=", batch.id)
          .where("batch_items.row_number", ">", lastRow)
          .orderBy("batch_items.row_number")
          .limit(1000);
        if (filter.only === "mobile_found") q = q.where("batch_items.status", "=", "mobile_found");
        const rows = await q.execute();
        if (!rows.length) break;
        let chunk = "";
        for (const r of rows) {
          const original = (r.input_row ?? {}) as Record<string, unknown>;
          chunk += csvLine([
            ...sourceHeaders.map((h) => original[h] ?? ""),
            r.row_number,
            r.status,
            r.result_source ?? "",
            r.mobile_number ?? "",
            r.mobile_country_code ?? "",
            r.mobile_country_iso ?? "",
            r.linkedin_url ?? "",
            r.first_name ?? "",
            r.last_name ?? "",
            r.full_name ?? "",
            r.job_title ?? "",
            r.headline ?? "",
            r.company_name ?? "",
            r.company_domain ?? "",
            r.company_website ?? "",
            r.company_industry ?? "",
            r.company_size ?? "",
            r.work_email ?? "",
            r.work_email_status ?? "",
            r.personal_email ?? "",
            r.city ?? "",
            r.state ?? "",
            r.country ?? "",
            r.error ?? "",
          ]);
        }
        yield chunk;
        lastRow = rows[rows.length - 1]!.row_number;
      }
    }
    const safeName = batch.name.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "batch";
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${safeName}_enriched.csv"`);
    reply.header("cache-control", "no-store");
    return reply.send(Readable.from(generate()));
  });

  async function loadBatch(params: unknown) {
    const { id } = params as { id: string };
    if (!isUuid(id)) throw notFound("Batch not found");
    const batch = await ctx.db.selectFrom("batches").selectAll().where("id", "=", id).executeTakeFirst();
    if (!batch) throw notFound("Batch not found");
    return batch;
  }
}

function limitColumns(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (!k || n >= MAX_STORED_COLUMNS) break;
    out[k] = typeof v === "string" ? v.slice(0, 2000) : String(v ?? "");
    n++;
  }
  return out;
}
