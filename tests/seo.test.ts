import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishedRoutes, siteConfig } from "@/content/site";
import {
  absoluteUrl,
  breadcrumbSchema,
  creativeWorkSchema,
  isPublicSite,
  organizationSchema,
  publicContactEmail,
  serializeJsonLd,
  siteUrl,
  websiteSchema,
} from "@/lib/seo-data";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import manifest from "@/app/manifest";

afterEach(() => vi.unstubAllEnvs());

describe("public site URL", () => {
  it("keeps an unconfigured checkout local and out of search indexes", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(siteUrl().toString()).toBe("http://localhost:3000/");
    expect(isPublicSite()).toBe(false);
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
  });

  it("accepts configured HTTPS origins and explicit HTTP local previews", () => {
    expect(siteUrl("https://example.org").toString()).toBe("https://example.org/");
    expect(siteUrl("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
    expect(isPublicSite(siteUrl("http://localhost:3000"))).toBe(false);
    expect(isPublicSite(siteUrl("https://localhost"))).toBe(false);
  });

  it.each([
    "not a URL",
    "http://example.org",
    "javascript:alert(1)",
    "https://user:password@example.org",
    "https://example.org/path",
    "https://example.org?x=1",
    "https://example.org#fragment",
  ])("rejects unsafe or ambiguous configured origin %s", (value) => {
    expect(() => siteUrl(value)).toThrow("NEXT_PUBLIC_SITE_URL");
  });

  it("does not permit relative or cross-origin canonical paths", () => {
    const origin = new URL("https://example.org");
    expect(absoluteUrl("/work/bankflow", origin)).toBe("https://example.org/work/bankflow");
    for (const path of ["work", "//external.example", "/\\external.example", "/path\n"]) {
      expect(() => absoluteUrl(path, origin)).toThrow();
    }
  });
});

describe("published route metadata", () => {
  it("includes every published page once, including privacy and BankFlow", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.org");
    const entries = sitemap();
    expect(entries.map(({ url }) => new URL(url).pathname)).toEqual([...publishedRoutes]);
    expect(new Set(entries.map(({ url }) => url)).size).toBe(entries.length);
    expect(entries.every((entry) => !entry.lastModified)).toBe(true);
    for (const path of publishedRoutes) {
      expect(existsSync(join(process.cwd(), "src/app", path, "page.tsx"))).toBe(true);
    }
    for (const link of siteConfig.navigation) {
      expect(publishedRoutes).toContain(link.href);
    }
  });

  it("advertises the configured sitemap and excludes API routes", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.org");
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/api/" },
      sitemap: "https://example.org/sitemap.xml",
    });
  });

  it("references the actual generated icon route conventions", () => {
    expect(manifest().icons?.map(({ src }) => src)).toEqual(["/icon", "/apple-icon"]);
    expect(manifest().display).toBe("browser");
  });
});

describe("honest and safe structured data", () => {
  const origin = new URL("https://example.org");

  it("emits valid JSON with only configured organization facts", () => {
    const organization = organizationSchema(origin);
    expect(Object.keys(organization).sort()).toEqual(
      ["@context", "@id", "@type", "description", "name", "url"].sort(),
    );
    expect(JSON.parse(serializeJsonLd([organization, websiteSchema(origin)]))).toEqual([
      organization,
      websiteSchema(origin),
    ]);
    expect(websiteSchema(origin).description).toBe(
      "We turn fragmented business data into reliable intelligence that supports better decisions.",
    );
  });

  it("escapes script boundaries without changing parsed content", () => {
    const data = { name: "</script><script>alert(1)</script>" };
    const serialized = serializeJsonLd(data);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(data);
  });

  it("reconciles breadcrumb positions and absolute URLs with their source order", () => {
    const items = [
      { name: "Home", path: "/" },
      { name: "Work", path: "/work" },
      { name: "BankFlow", path: "/work/bankflow" },
    ];
    const schema = breadcrumbSchema(items, origin);
    expect(schema.itemListElement.map(({ position }) => position)).toEqual([1, 2, 3]);
    expect(schema.itemListElement.map(({ item }) => item)).toEqual(
      items.map(({ path }) => `${origin.origin}${path}`),
    );
  });

  it("describes the demonstration without inventing a client or result", () => {
    const work = {
      name: "BankFlow",
      description: "A personal demonstration project built on sample banking transaction data.",
      path: "/work/bankflow",
    };
    const schema = creativeWorkSchema(work, origin);
    expect(schema).toEqual({
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: work.name,
      description: work.description,
      url: "https://example.org/work/bankflow",
    });
    expect(JSON.parse(serializeJsonLd(schema))).toEqual(schema);
  });
});

describe("optional public contact address", () => {
  it("omits absent and invalid addresses and accepts conventional configured email", () => {
    expect(publicContactEmail("")).toBeNull();
    expect(publicContactEmail("not-an-email")).toBeNull();
    expect(publicContactEmail("owner@example.org?subject=injected")).toBeNull();
    expect(publicContactEmail("owner@example.org\r\nBcc: other@example.org")).toBeNull();
    expect(publicContactEmail(" team+projects@example.org ")).toBe("team+projects@example.org");
  });
});
