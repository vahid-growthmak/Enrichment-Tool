import { describe, expect, it } from "vitest";
import { canonicalizeLinkedInUrl, looksLikeLinkedInUrl } from "../../src/lib/linkedin-url.js";

const ok = (input: string) => {
  const r = canonicalizeLinkedInUrl(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.reason}`);
  return r.value;
};
const bad = (input: string | null | undefined) => {
  const r = canonicalizeLinkedInUrl(input);
  if (r.ok) throw new Error(`expected invalid for ${input}`);
  return r.reason;
};

describe("canonicalizeLinkedInUrl", () => {
  it("collapses every variant of the same profile to one key", () => {
    const expected = "https://www.linkedin.com/in/john-doe";
    for (const v of [
      "https://www.linkedin.com/in/john-doe",
      "http://linkedin.com/in/John-Doe/",
      "linkedin.com/in/john-doe?utm_source=share&trk=x",
      "https://fr.linkedin.com/in/john-doe/details/experience/",
      "https://www.linkedin.com/in/john-doe#about",
      "  https://www.linkedin.com/in/john-doe/  ",
      "https://www.linkedin.com/mwlite/in/john-doe",
      "https://in.linkedin.com/in/JOHN-DOE",
      "<https://www.linkedin.com/in/john-doe>",
    ]) {
      expect(ok(v).url, v).toBe(expected);
      expect(ok(v).slug).toBe("john-doe");
      expect(ok(v).kind).toBe("profile");
    }
  });

  it("handles percent-encoded and unicode slugs", () => {
    expect(ok("https://www.linkedin.com/in/%E5%BC%A0%E4%B8%89").url).toBe("https://www.linkedin.com/in/%E5%BC%A0%E4%B8%89");
    expect(ok("https://www.linkedin.com/in/张三").url).toBe("https://www.linkedin.com/in/%E5%BC%A0%E4%B8%89");
    expect(ok("https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa").slug).toBe("josé-garcía");
  });

  it("supports Sales Navigator lead URLs", () => {
    const r = ok("https://www.linkedin.com/sales/lead/ACwAAAb1234XYZ,NAME,abc?x=1");
    expect(r.kind).toBe("sales_navigator");
    expect(r.url).toBe("https://www.linkedin.com/sales/lead/ACwAAAb1234XYZ");
    expect(ok("https://www.linkedin.com/sales/people/ACwAAAb1234XYZ,NAME").url).toBe("https://www.linkedin.com/sales/lead/ACwAAAb1234XYZ");
  });

  it("rejects things that are not person profiles", () => {
    expect(bad("https://www.linkedin.com/company/acme")).toMatch(/company page/);
    expect(bad("https://www.linkedin.com/school/mit")).toMatch(/school/);
    expect(bad("https://www.linkedin.com/posts/john-doe_x-activity-1")).toMatch(/post/);
    expect(bad("https://www.linkedin.com/pub/john-doe/1/2/3")).toMatch(/legacy/);
    expect(bad("https://www.linkedin.com/in/")).toMatch(/slug/);
    expect(bad("https://www.linkedin.com/")).toMatch(/not a LinkedIn profile/);
    expect(bad("https://twitter.com/in/john")).toMatch(/not a linkedin/);
    expect(bad("https://notlinkedin.com/in/john")).toMatch(/not a linkedin/);
    expect(bad("https://linkedin.com.evil.com/in/john")).toMatch(/not a linkedin/);
    expect(bad("")).toBe("empty");
    expect(bad(null)).toBe("empty");
    expect(bad("john doe")).toMatch(/not a linkedin|valid URL/);
    expect(bad("https://www.linkedin.com/in/a")).toMatch(/slug/);
  });

  it("detects linkedin-looking values", () => {
    expect(looksLikeLinkedInUrl("https://www.linkedin.com/in/x")).toBe(true);
    expect(looksLikeLinkedInUrl("linkedin.com/sales/lead/abc")).toBe(true);
    expect(looksLikeLinkedInUrl("john@example.com")).toBe(false);
    expect(looksLikeLinkedInUrl(42)).toBe(false);
  });
});
