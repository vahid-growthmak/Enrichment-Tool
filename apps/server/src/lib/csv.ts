import Papa from "papaparse";
import { looksLikeLinkedInUrl } from "./linkedin-url.js";

export interface ColumnMapping {
  url: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  detected: Partial<ColumnMapping>;
}

const URL_HEADERS = ["linkedin_url", "linkedin", "linkedinurl", "linkedin profile", "linkedin profile url", "profile_url", "profile url", "person_linkedin_url", "linkedin_profile_url", "url", "link"];
const FIRST_HEADERS = ["first_name", "firstname", "first name", "given name", "first"];
const LAST_HEADERS = ["last_name", "lastname", "last name", "surname", "family name", "last"];
const COMPANY_HEADERS = ["company", "company_name", "company name", "organization", "organisation", "employer", "account"];

export function parseCsv(text: string, maxRows: number): ParsedCsv {
  const cleaned = text.replace(/^﻿/, "");
  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
    dynamicTyping: false,
  });
  // A single-column file (just URLs) makes the delimiter "undetectable"; Papa
  // falls back to a comma, which is exactly right, so that is not an error.
  const headers = (result.meta.fields ?? []).filter((h) => h !== "");
  if (headers.length === 0) throw new Error("The CSV has no header row.");
  const rows = result.data.slice(0, maxRows + 1);
  if (rows.length > maxRows) throw new Error(`The CSV has more than ${maxRows} rows. Split it into smaller files.`);

  return { headers, rows, rowCount: rows.length, detected: detectColumns(headers, rows) };
}

export function detectColumns(headers: string[], rows: Record<string, string>[]): Partial<ColumnMapping> {
  const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9 _]/g, "");
  const find = (candidates: string[]) => headers.find((h) => candidates.includes(norm(h)));

  let url = find(URL_HEADERS);
  if (!url) {
    // fall back to the column whose values look like LinkedIn URLs most often
    const sample = rows.slice(0, 50);
    let best: { h: string; score: number } | null = null;
    for (const h of headers) {
      const score = sample.filter((r) => looksLikeLinkedInUrl(r[h])).length;
      if (score > 0 && (!best || score > best.score)) best = { h, score };
    }
    url = best?.h;
  }
  return {
    url,
    firstName: find(FIRST_HEADERS) ?? null,
    lastName: find(LAST_HEADERS) ?? null,
    company: find(COMPANY_HEADERS) ?? null,
  };
}

/** RFC 4180 field escaping. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Guard against spreadsheet formula injection — but never mangle E.164 phone
  // numbers, which legitimately start with "+".
  const safe = /^[=+\-@\t\r]/.test(s) && !/^\+\d{6,15}$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvField).join(",") + "\r\n";
}
