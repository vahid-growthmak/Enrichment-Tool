import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, waitFor, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.truncate();
  await h.resetMock();
});

function multipart(fields: Record<string, string>, file: { name: string; content: string }) {
  const boundary = "----vitest" + Math.random().toString(16).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n--${boundary}--\r\n`;
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(content: string, fields: Record<string, string> = {}, name = "leads.csv") {
  const res = await h.app.inject({ method: "POST", url: "/api/v1/batches", ...multipart(fields, { name, content }) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function waitBatch(id: string, status = "completed", timeoutMs = 120_000) {
  return waitFor(
    async () => {
      const b = JSON.parse((await h.app.inject({ method: "GET", url: `/api/v1/batches/${id}` })).body).batch;
      return b.status === status ? b : null;
    },
    { label: `batch ${id} ${status}`, timeoutMs, intervalMs: 500 },
  );
}

describe("bulk batches", () => {
  it("preview detects columns and counts rows without storing anything", async () => {
    const csv = "Name,Company,LinkedIn URL\nAda,Acme,https://www.linkedin.com/in/ada\nBob,Beta,not-a-url\n";
    const res = await h.app.inject({ method: "POST", url: "/api/v1/batches/preview", ...multipart({}, { name: "x.csv", content: csv }) });
    const body = JSON.parse(res.body);
    expect(body.rowCount).toBe(2);
    expect(body.detected.url).toBe("LinkedIn URL");
    expect(body.detected.company).toBe("Company");
    expect(body.validInSample).toBe(1);
    expect(await h.db.selectFrom("batches").selectAll().execute()).toHaveLength(0);
  });

  it("processes a mixed file: valid, invalid, duplicate, cached and failing rows, with correct counters", async () => {
    // pre-warm one profile so it is served from cache
    const warm = await h.app.inject({ method: "POST", url: "/api/v1/enrich/single", payload: { linkedinUrl: "https://www.linkedin.com/in/slow-warm" } });
    const warmId = JSON.parse(warm.body).profile.id;
    await waitFor(async () => {
      const p = await h.db.selectFrom("profiles").select("enrichment_status").where("id", "=", warmId).executeTakeFirst();
      return p?.enrichment_status === "mobile_found" ? p : null;
    });
    await h.resetMock();

    const csv = [
      "first_name,last_name,company,linkedin_url,notes",
      "Ada,Lovelace,Acme,https://www.linkedin.com/in/slow-row1,\"has, comma\"",
      "Bob,Jones,Beta,linkedin.com/in/fe-row2,",
      "Cy,Young,Gamma,https://www.linkedin.com/in/nomobile-row3,",
      "Di,Prince,Delta,https://www.linkedin.com/company/not-a-person,",
      "Ed,Norton,Eps,,",
      "Fay,Wray,Zeta,https://www.linkedin.com/in/SLOW-ROW1/,dup of row 1",
      "Gus,Fring,Eta,https://www.linkedin.com/in/slow-warm,cached",
      "Hal,Jordan,Theta,https://www.linkedin.com/in/fecredits-row8,fails",
      "",
    ].join("\n");
    const { status, body } = await upload(csv, { name: "QA batch" });
    expect(status).toBe(200);
    const b = body.batch;
    expect(b.name).toBe("QA batch");
    expect(b.total).toBe(8);
    expect(b.invalid).toBe(2);
    expect(b.duplicate).toBe(1);
    expect(b.queued).toBe(5);
    expect(b.columnMapping).toEqual({ url: "linkedin_url", firstName: "first_name", lastName: "last_name", company: "company" });

    const done = await waitBatch(b.id);
    expect(done).toMatchObject({ status: "completed", processed: 8, total: 8, foundMobile: 3, mobileMissing: 1, cached: 1, invalid: 2, duplicate: 1, failed: 1 });
    expect(done.completedAt).toBeTruthy();
    expect(done.hitRate).toBeCloseTo(3 / 5);

    const calls = await h.mockCalls();
    expect(calls["apollo.match"]).toBe(4); // 5 queued rows minus the cached one

    const items = JSON.parse((await h.app.inject({ method: "GET", url: `/api/v1/batches/${b.id}/items?limit=100` })).body).items as Array<Record<string, unknown>>;
    const byRow = Object.fromEntries(items.map((i) => [i.rowNumber as number, i]));
    expect(byRow[1]).toMatchObject({ status: "mobile_found", source: "apollo" });
    expect(byRow[2]).toMatchObject({ status: "mobile_found", source: "fullenrich" });
    expect(byRow[3]).toMatchObject({ status: "mobile_missing" });
    expect(byRow[4]).toMatchObject({ status: "invalid" });
    expect((byRow[4]!.error as string)).toMatch(/company page/);
    expect(byRow[5]).toMatchObject({ status: "invalid", error: "empty LinkedIn URL" });
    expect(byRow[6]).toMatchObject({ status: "duplicate", duplicateOfRow: 1 });
    expect(byRow[7]).toMatchObject({ status: "mobile_found", source: "cache" });
    expect(byRow[8]).toMatchObject({ status: "failed" });
    expect((byRow[1]!.profile as { mobile: { number: string } }).mobile.number).toMatch(/^\+/);

    // the user-supplied names were stored on the new profiles
    const p1 = await h.db.selectFrom("profiles").selectAll().where("linkedin_url", "=", "https://www.linkedin.com/in/slow-row1").executeTakeFirstOrThrow();
    expect(p1.first_name).toBeTruthy();

    // export: original columns + enrichment columns, formulas neutralised, quoting intact
    const exp = await h.app.inject({ method: "GET", url: `/api/v1/batches/${b.id}/export.csv` });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toMatch(/text\/csv/);
    expect(exp.headers["content-disposition"]).toMatch(/QA_batch_enriched\.csv/);
    const lines = exp.body.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("first_name,last_name,company,linkedin_url,notes,row_number,enrichment_status,enrichment_source,mobile_number,mobile_country_code,mobile_country_iso,linkedin_url_canonical,first_name,last_name,full_name,job_title,headline,company_name,company_domain,company_website,company_industry,company_size,work_email,work_email_status,personal_email,city,state,country,error");
    expect(lines[1]).toContain('"has, comma",1,mobile_found,apollo,+');
    expect(lines[7]).toContain(",7,mobile_found,cache,+");
    const onlyFound = await h.app.inject({ method: "GET", url: `/api/v1/batches/${b.id}/export.csv?only=mobile_found` });
    expect(onlyFound.body.split("\r\n").filter(Boolean)).toHaveLength(4);

    // retry the failed row: FullEnrich still has no credits, so it fails again — but it was re-queued and re-processed
    await h.resetMock();
    const retry = JSON.parse((await h.app.inject({ method: "POST", url: `/api/v1/batches/${b.id}/retry-failed` })).body);
    expect(retry.requeued).toBe(1);
    const after = await waitBatch(b.id);
    expect(after.failed).toBe(1);
    expect(after.processed).toBe(8);
    expect((await h.mockCalls())["apollo.match"]).toBe(1);
  }, 180_000);

  it("explicit column mapping overrides detection; unknown mapping is a 400", async () => {
    const csv = "a,b\nhttps://www.linkedin.com/in/slow-m1,x\n";
    const bad = await upload(csv, { urlColumn: "zzz" });
    expect(bad.status).toBe(400);
    const good = await upload(csv, { urlColumn: "a" });
    expect(good.status).toBe(200);
    expect(good.body.batch.queued).toBe(1);
    await waitBatch(good.body.batch.id);
  });

  it("rejects empty files, files without data rows, and oversized row counts", async () => {
    expect((await upload("")).status).toBe(400);
    expect((await upload("linkedin_url\n")).status).toBe(400);
    const many = "linkedin_url\n" + Array.from({ length: h.cfg.MAX_BATCH_ROWS + 1 }, (_, i) => `https://www.linkedin.com/in/p${i}`).join("\n");
    const r = await upload(many);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/more than/);
  });

  it("cancel stops pending rows and keeps counters consistent", async () => {
    // Enough rows that some are still queued when we cancel; in-flight rows finish normally.
    const csv = "linkedin_url\n" + Array.from({ length: 300 }, (_, i) => `https://www.linkedin.com/in/slow-cancel-${i}`).join("\n");
    const { body } = await upload(csv);
    const res = await h.app.inject({ method: "POST", url: `/api/v1/batches/${body.batch.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).batch.status).toBe("cancelled");
    const final = await waitFor(
      async () => {
        const b = JSON.parse((await h.app.inject({ method: "GET", url: `/api/v1/batches/${body.batch.id}` })).body).batch;
        return b.processed === 300 ? b : null;
      },
      { label: "all rows settled after cancel", timeoutMs: 90_000, intervalMs: 500 },
    );
    expect(final.status).toBe("cancelled");
    expect(final.cancelled).toBeGreaterThan(0);
    expect(final.cancelled + final.foundMobile + final.mobileMissing + final.failed).toBe(300);
    const pending = await h.db.selectFrom("batch_items").select("id").where("batch_id", "=", body.batch.id).where("status", "in", ["pending", "processing"]).execute();
    expect(pending).toHaveLength(0);
    expect((await h.app.inject({ method: "POST", url: `/api/v1/batches/${body.batch.id}/cancel` })).statusCode).toBe(409);
  }, 120_000);

  it("stress: 500 rows complete with the expected mix and no stuck rows", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => `https://www.linkedin.com/in/bulk-${i}`);
    const csv = "linkedin_url\n" + rows.join("\n");
    const { status, body } = await upload(csv, { name: "stress" });
    expect(status).toBe(200);
    expect(body.batch.total).toBe(500);
    const b = await waitBatch(body.batch.id, "completed", 300_000);
    expect(b.processed).toBe(500);
    expect(b.foundMobile + b.mobileMissing + b.failed).toBe(500);
    expect(b.failed).toBe(0);
    expect(b.foundMobile).toBeGreaterThan(350); // hash mix: ~60% apollo + ~25% fullenrich
    const stuck = await h.db.selectFrom("profiles").select("id").where("lock_token", "is not", null).execute();
    expect(stuck).toHaveLength(0);
    const calls = await h.mockCalls();
    expect(calls["apollo.match"]).toBe(500);
    const list = JSON.parse((await h.app.inject({ method: "GET", url: "/api/v1/batches" })).body);
    expect(list.total).toBe(1);
  }, 320_000);
});
