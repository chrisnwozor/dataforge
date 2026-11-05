import { siteConfig } from "@/content/site";

export type BreadcrumbItem = Readonly<{ name: string; path: string }>;

/** No guessed production domain: an unconfigured checkout stays a local preview. */
export function siteUrl(value = process.env.NEXT_PUBLIC_SITE_URL): URL {
  if (!value?.trim()) return new URL("http://localhost:3000");

  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Invalid site origin");
    }
    return new URL(url.origin);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be an HTTPS origin, or an HTTP localhost origin for local previews.",
    );
  }
}

export function isPublicSite(url = siteUrl()): boolean {
  return url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function absoluteUrl(path: string, origin = siteUrl()): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Site paths must begin with a single slash.");
  }
  const resolved = new URL(path, origin);
  if (resolved.origin !== origin.origin || /[\\\u0000-\u001f]/.test(path)) {
    throw new Error("Site paths must stay on the configured origin.");
  }
  return resolved.toString();
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function organizationSchema(origin = siteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": absoluteUrl("/#organization", origin),
    name: siteConfig.name,
    url: origin.toString(),
    description: siteConfig.description,
  };
}

export function websiteSchema(origin = siteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": absoluteUrl("/#website", origin),
    name: siteConfig.name,
    url: origin.toString(),
    description: siteConfig.promise,
  };
}

export function breadcrumbSchema(items: readonly BreadcrumbItem[], origin = siteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path, origin),
    })),
  };
}

export function creativeWorkSchema(
  work: Readonly<{ name: string; description: string; path: string }>,
  origin = siteUrl(),
) {
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: work.name,
    description: work.description,
    url: absoluteUrl(work.path, origin),
  };
}

export function publicContactEmail(value = process.env.NEXT_PUBLIC_CONTACT_EMAIL): string | null {
  const email = value?.trim();
  if (
    !email ||
    email.length > 254 ||
    !/^[a-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(email)
  ) {
    return null;
  }
  return email;
}
