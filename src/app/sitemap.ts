import type { MetadataRoute } from "next";
import { publishedRoutes } from "@/content/site";
import { absoluteUrl } from "@/lib/seo-data";

export default function sitemap(): MetadataRoute.Sitemap {
  // Do not manufacture publication or modification dates.
  return publishedRoutes.map((path) => ({ url: absoluteUrl(path) }));
}
