import { parsePhoneNumberFromString, getCountries, type CountryCode, type NumberType } from "libphonenumber-js/max";
import type { LineType } from "../db/types.js";

export interface NormalizedPhone {
  e164: string;
  countryCallingCode: string; // '+91'
  countryIso: string;         // 'IN'
  lineType: LineType;
  /** true when we are confident this is a mobile (or a region where mobile and landline are indistinguishable, e.g. US) */
  isMobile: boolean;
}

export type ProviderPhoneHint = "mobile" | "landline" | "voip" | "other" | "unknown";

export interface NormalizeOptions {
  /** Provider's own classification of the number. */
  providerType?: ProviderPhoneHint;
  /** ISO 3166-1 alpha-2 hint, e.g. from the person's country. Used only when the number has no + prefix. */
  regionHint?: string | null;
  /** Fallback region when nothing else is known (config DEFAULT_PHONE_REGION). */
  defaultRegion?: string | null;
}

const VALID_COUNTRIES = new Set<string>(getCountries());

/**
 * Normalize a raw provider phone number into E.164 with a guaranteed country
 * code. Returns null when the country cannot be determined — a number without
 * a country code is useless for outreach, so it is never accepted as a mobile.
 */
export function normalizePhone(raw: string | null | undefined, opts: NormalizeOptions = {}): NormalizedPhone | null {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text) return null;

  // "00 44 ..." international prefix -> "+44 ..."
  if (/^00\s*\d/.test(text)) text = `+${text.replace(/^00\s*/, "")}`;
  // strip extensions like "x123", "ext. 12"
  text = text.replace(/\s*(x|ext\.?|extension)\s*\d+$/i, "");

  const hasPlus = text.startsWith("+");
  const region = toCountryCode(opts.regionHint) ?? toCountryCode(opts.defaultRegion);

  let parsed = hasPlus ? parsePhoneNumberFromString(text) : region ? parsePhoneNumberFromString(text, region) : undefined;

  // Some providers return international numbers without the "+" (e.g. "919876543210").
  if (!parsed && !hasPlus && /^\d{10,15}$/.test(text.replace(/[\s().-]/g, ""))) {
    const candidate = parsePhoneNumberFromString(`+${text.replace(/[\s().-]/g, "")}`);
    if (candidate?.isValid()) parsed = candidate;
  }

  if (!parsed || !parsed.isValid() || !parsed.country) return null;

  const libType = parsed.getType();
  const lineType = classify(libType, opts.providerType);
  const isMobile = decideMobile(lineType, opts.providerType);

  return {
    e164: parsed.number,
    countryCallingCode: `+${parsed.countryCallingCode}`,
    countryIso: parsed.country,
    lineType,
    isMobile,
  };
}

function toCountryCode(v: string | null | undefined): CountryCode | undefined {
  if (!v) return undefined;
  const up = v.trim().toUpperCase();
  return VALID_COUNTRIES.has(up) ? (up as CountryCode) : undefined;
}

function classify(libType: NumberType, hint?: ProviderPhoneHint): LineType {
  switch (libType) {
    case "MOBILE":
      return "mobile";
    case "FIXED_LINE_OR_MOBILE":
      return hint === "mobile" ? "mobile" : hint === "landline" ? "landline" : "fixed_line_or_mobile";
    case "FIXED_LINE":
      return "landline";
    case "VOIP":
      return "voip";
    case "PERSONAL_NUMBER":
      return hint === "mobile" ? "mobile" : "other";
    case undefined:
      return hint === "mobile" ? "mobile" : hint === "landline" ? "landline" : hint === "voip" ? "voip" : "unknown";
    default:
      return "other";
  }
}

function decideMobile(lineType: LineType, hint?: ProviderPhoneHint): boolean {
  if (lineType === "mobile") return true;
  // Regions like the US/CA do not distinguish mobile from landline numerically;
  // trust the provider when it says mobile, otherwise be conservative.
  if (lineType === "fixed_line_or_mobile") return hint === "mobile" || hint === "unknown" || hint === undefined;
  return false;
}

/** Map a free-text country name ("United States", "india") to ISO alpha-2. */
const countryNameIndex: Map<string, string> = (() => {
  const idx = new Map<string, string>();
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of getCountries()) {
      const name = dn.of(code);
      if (name) idx.set(name.toLowerCase(), code);
    }
  } catch {
    /* Intl unavailable: fall back to the aliases below */
  }
  const aliases: Record<string, string> = {
    usa: "US", "united states of america": "US", "u.s.": "US", "u.s.a.": "US", us: "US",
    uk: "GB", "united kingdom": "GB", england: "GB", britain: "GB", "great britain": "GB",
    uae: "AE", "united arab emirates": "AE",
    "south korea": "KR", korea: "KR", russia: "RU", vietnam: "VN", iran: "IR", syria: "SY",
    "czech republic": "CZ", turkey: "TR", türkiye: "TR", taiwan: "TW", "hong kong": "HK", macau: "MO",
    netherlands: "NL", "the netherlands": "NL", holland: "NL", "ivory coast": "CI",
  };
  for (const [k, v] of Object.entries(aliases)) idx.set(k, v);
  return idx;
})();

export function countryNameToIso(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (key.length === 2 && VALID_COUNTRIES.has(key.toUpperCase())) return key.toUpperCase();
  return countryNameIndex.get(key) ?? null;
}
