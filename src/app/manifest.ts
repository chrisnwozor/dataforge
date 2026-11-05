import type { MetadataRoute } from "next";
import { shellContent, siteConfig } from "@/content/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: shellContent.manifest.name,
    short_name: shellContent.manifest.shortName,
    description: siteConfig.description,
    start_url: "/",
    display: "browser",
    background_color: "#070b14",
    theme_color: "#070b14",
    lang: "en",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
