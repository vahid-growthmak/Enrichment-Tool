/**
 * LinkedIn URL canonicalization.
 *
 * The canonical form is the cache key for the whole system, so every variant
 * of the same profile must collapse to exactly one string:
 *   http://linkedin.com/in/John-Doe/?utm=x  ->  https://www.linkedin.com/in/john-doe
 *   https://fr.linkedin.com/in/john-doe/details/experience/
 *   linkedin.com/mwlite/in/john-doe
 *   https://www.linkedin.com/in/%E5%BC%A0%E4%B8%89  (percent-decoded, lowercased)
 */

export type LinkedInKind = "profile" | "sales_navigator";

export interface CanonicalLinkedInUrl {
  url: string;
  slug: string;
  kind: LinkedInKind;
}

export type CanonicalizeResult =
  | { ok: true; value: CanonicalLinkedInUrl }
  | { ok: false; reason: string };

const HOST_RE = /^([a-z0-9-]+\.)*linkedin\.(com|cn)$/i;
const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._%'-]{1,99}$/u;

export function canonicalizeLinkedInUrl(input: string | null | undefined): CanonicalizeResult {
  if (input == null) return { ok: false, reason: "empty" };
  let raw = String(input).trim().replace(/^[<"'\s]+|[>"'\s]+$/g, "");
  if (!raw) return { ok: false, reason: "empty" };
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (!HOST_RE.test(parsed.hostname)) return { ok: false, reason: "not a linkedin.com URL" };

  const segments = parsed.pathname
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  // strip mobile prefix: /mwlite/in/slug
  if (segments[0]?.toLowerCase() === "mwlite") segments.shift();

  const head = segments[0]?.toLowerCase();

  if (head === "in") {
    const rawSlug = segments[1];
    if (!rawSlug) return { ok: false, reason: "missing profile slug" };
    let slug: string;
    try {
      slug = decodeURIComponent(rawSlug);
    } catch {
      slug = rawSlug;
    }
    slug = slug.normalize("NFC").toLowerCase().replace(/\/+$/, "");
    if (!SLUG_RE.test(slug)) return { ok: false, reason: "invalid profile slug" };
    return { ok: true, value: { url: `https://www.linkedin.com/in/${encodeSlug(slug)}`, slug, kind: "profile" } };
  }

  if (head === "sales") {
    // /sales/lead/ACwAAAxxxx,NAME,abc  or /sales/people/ACwAAAxxxx,NAME,abc
    const sub = segments[1]?.toLowerCase();
    if (sub === "lead" || sub === "people") {
      const idPart = (segments[2] ?? "").split(",")[0] ?? "";
      if (!/^[A-Za-z0-9_-]{6,}$/.test(idPart)) return { ok: false, reason: "invalid Sales Navigator lead id" };
      return { ok: true, value: { url: `https://www.linkedin.com/sales/lead/${idPart}`, slug: idPart, kind: "sales_navigator" } };
    }
    return { ok: false, reason: "unsupported Sales Navigator URL" };
  }

  if (head === "company" || head === "school" || head === "showcase") {
    return { ok: false, reason: `this is a ${head} page, not a person profile` };
  }
  if (head === "pub") return { ok: false, reason: "legacy /pub/ URLs are not supported; use the /in/ URL" };
  if (head === "posts" || head === "feed" || head === "pulse") return { ok: false, reason: "this is a post, not a profile" };

  return { ok: false, reason: "not a LinkedIn profile URL" };
}

function encodeSlug(slug: string): string {
  // Keep ASCII as-is, percent-encode non-ASCII consistently.
  return slug
    .split("")
    .map((ch) => (/[\p{ASCII}]/u.test(ch) ? ch : encodeURIComponent(ch)))
    .join("");
}

/** Quick check used by CSV column auto-detection. */
export function looksLikeLinkedInUrl(value: unknown): boolean {
  return typeof value === "string" && /linkedin\.(com|cn)\/(mwlite\/)?(in|sales)\//i.test(value);
}
