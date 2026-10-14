import { describe, expect, it } from "vitest";
import { countryNameToIso, normalizePhone } from "../../src/lib/phone.js";

describe("normalizePhone", () => {
  it("always produces E.164 with the country code", () => {
    const n = normalizePhone("+91 98765 43210", { providerType: "mobile" });
    expect(n).toMatchObject({ e164: "+919876543210", countryCallingCode: "+91", countryIso: "IN", lineType: "mobile", isMobile: true });
  });

  it("rejects numbers whose country cannot be determined", () => {
    expect(normalizePhone("9876543210", { providerType: "mobile" })).toBeNull();
    expect(normalizePhone("(415) 555-2671")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("not a number")).toBeNull();
    expect(normalizePhone("+1 123")).toBeNull();
  });

  it("uses the region hint or default region for national-format numbers", () => {
    expect(normalizePhone("9876543210", { regionHint: "IN" })?.e164).toBe("+919876543210");
    expect(normalizePhone("(415) 555-2671", { defaultRegion: "US" })?.e164).toBe("+14155552671");
    expect(normalizePhone("9876543210", { regionHint: "india" })).toBeNull(); // hint must be ISO
  });

  it("recovers international numbers delivered without the plus sign", () => {
    expect(normalizePhone("919876543210")?.e164).toBe("+919876543210");
    expect(normalizePhone("4917612345678")?.e164).toBe("+4917612345678");
    expect(normalizePhone("0044 7911 123456")?.countryCallingCode).toBe("+44");
  });

  it("strips extensions", () => {
    expect(normalizePhone("+33 1 42 86 82 82 ext. 12")?.e164).toBe("+33142868282");
  });

  it("classifies line types and never promotes a landline", () => {
    expect(normalizePhone("+33 1 42 86 82 82", { providerType: "mobile" })).toMatchObject({ lineType: "landline", isMobile: false });
    expect(normalizePhone("+33 6 12 34 56 78")).toMatchObject({ lineType: "mobile", isMobile: true });
    expect(normalizePhone("+33 6 12 34 56 78", { providerType: "landline" })).toMatchObject({ isMobile: true }); // numbering plan wins
  });

  it("trusts the provider in regions where mobile and landline overlap (US/CA)", () => {
    expect(normalizePhone("+1 415 555 2671", { providerType: "mobile" })).toMatchObject({ lineType: "mobile", isMobile: true });
    expect(normalizePhone("+1 415 555 2671", { providerType: "landline" })).toMatchObject({ lineType: "landline", isMobile: false });
    expect(normalizePhone("+1 415 555 2671", { providerType: "unknown" })).toMatchObject({ lineType: "fixed_line_or_mobile", isMobile: true });
    expect(normalizePhone("+1 415 555 2671", { providerType: "other" })).toMatchObject({ lineType: "fixed_line_or_mobile", isMobile: false });
  });
});

describe("countryNameToIso", () => {
  it("maps names, aliases and codes", () => {
    expect(countryNameToIso("United States")).toBe("US");
    expect(countryNameToIso("usa")).toBe("US");
    expect(countryNameToIso("India")).toBe("IN");
    expect(countryNameToIso("United Kingdom")).toBe("GB");
    expect(countryNameToIso("UAE")).toBe("AE");
    expect(countryNameToIso("de")).toBe("DE");
    expect(countryNameToIso("Atlantis")).toBeNull();
    expect(countryNameToIso(null)).toBeNull();
  });
});
