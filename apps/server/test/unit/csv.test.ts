import { describe, expect, it } from "vitest";
import { csvField, csvLine, detectColumns, parseCsv } from "../../src/lib/csv.js";

describe("parseCsv", () => {
  it("parses headers, strips BOM, skips blank lines and detects columns", () => {
    const text = "﻿First Name,Last Name,Company,LinkedIn Profile\nJohn,Doe,Acme,https://www.linkedin.com/in/john-doe\n\nJane,Roe,Beta,linkedin.com/in/jane-roe\n";
    const r = parseCsv(text, 100);
    expect(r.headers).toEqual(["First Name", "Last Name", "Company", "LinkedIn Profile"]);
    expect(r.rowCount).toBe(2);
    expect(r.detected).toEqual({ url: "LinkedIn Profile", firstName: "First Name", lastName: "Last Name", company: "Company" });
  });
  it("detects the URL column by content when the header is unhelpful", () => {
    const r = parseCsv("a,b\nx,https://www.linkedin.com/in/john\ny,https://www.linkedin.com/in/jane\n", 100);
    expect(r.detected.url).toBe("b");
  });
  it("enforces the row limit", () => {
    expect(() => parseCsv("url\n1\n2\n3\n", 2)).toThrow(/more than 2 rows/);
  });
  it("rejects a file without a header", () => {
    expect(() => parseCsv("", 10)).toThrow(/header/);
  });
  it("handles semicolon-delimited files and quoted values", () => {
    const r = parseCsv('name;linkedin_url\n"Doe, John";https://www.linkedin.com/in/john\n', 10);
    expect(r.rows[0]).toEqual({ name: "Doe, John", linkedin_url: "https://www.linkedin.com/in/john" });
  });
  it("detectColumns returns nulls when nothing matches", () => {
    expect(detectColumns(["foo"], [{ foo: "bar" }])).toEqual({ url: undefined, firstName: null, lastName: null, company: null });
  });
});

describe("csv output", () => {
  it("escapes per RFC 4180 and neutralises formula injection", () => {
    expect(csvField('a "quoted", value')).toBe('"a ""quoted"", value"');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("+919876543210")).toBe("+919876543210"); // phone numbers stay intact
    expect(csvField("+1 and more")).toBe("'+1 and more");
    expect(csvField(null)).toBe("");
    expect(csvField(12)).toBe("12");
    expect(csvLine(["a", "b\nc"])).toBe('a,"b\nc"\r\n');
  });
});
