import type { MetadataRoute } from "next";
import { absoluteUrl, isPublicSite } from "@/lib/seo-data";

export default function robots(): MetadataRoute.Robots {
  if (!isPublicSite()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
