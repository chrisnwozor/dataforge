import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { shellContent, siteConfig } from "@/content/site";
import {
  absoluteUrl,
  breadcrumbSchema,
  creativeWorkSchema,
  isPublicSite,
  organizationSchema,
  serializeJsonLd,
  siteUrl,
  websiteSchema,
  type BreadcrumbItem,
} from "@/lib/seo-data";
import styles from "@/components/layout/shell.module.css";

export function rootMetadata(): Metadata {
  const origin = siteUrl();
  return {
    metadataBase: origin,
    title: {
      default: siteConfig.title,
      template: "%s — DataForge",
    },
    description: siteConfig.description,
    applicationName: siteConfig.name,
    manifest: "/manifest.webmanifest",
    robots: { index: isPublicSite(origin), follow: isPublicSite(origin) },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: siteConfig.name,
      title: siteConfig.title,
      description: siteConfig.description,
      url: origin.toString(),
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: shellContent.og.alt }],
    },
    twitter: {
      card: "summary_large_image",
      title: siteConfig.title,
      description: siteConfig.description,
      images: ["/opengraph-image"],
    },
  };
}

export function pageMetadata(title: string, description: string, path: string): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: siteConfig.name,
      title: `${title} — ${siteConfig.name}`,
      description,
      url,
      images: [
        {
          url: absoluteUrl("/opengraph-image"),
          width: 1200,
          height: 630,
          alt: shellContent.og.alt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} — ${siteConfig.name}`,
      description,
      images: [absoluteUrl("/opengraph-image")],
    },
  };
}

async function JsonLd({ data }: { data: unknown }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}

export async function SiteStructuredData() {
  return <JsonLd data={[organizationSchema(), websiteSchema()]} />;
}

export async function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }) {
  return (
    <>
      <nav aria-label={shellContent.breadcrumbLabel} className={styles.breadcrumbs}>
        <ol>
          {items.map((item, index) => (
            <li key={item.path}>
              {index < items.length - 1 ? (
                <Link href={item.path}>{item.name}</Link>
              ) : (
                <span aria-current="page">{item.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <JsonLd data={breadcrumbSchema(items)} />
    </>
  );
}

export async function CreativeWorkStructuredData({
  name,
  description,
  path,
}: {
  name: string;
  description: string;
  path: string;
}) {
  return <JsonLd data={creativeWorkSchema({ name, description, path })} />;
}
