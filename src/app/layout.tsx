import localFont from "next/font/local";
import { headers } from "next/headers";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { rootMetadata, SiteStructuredData } from "@/lib/seo";
import { common } from "@/content/common";
import "./globals.css";
const body = localFont({
  src: "./fonts/geist-sans-latin.woff2",
  variable: "--font-body",
  weight: "100 900",
  display: "swap",
});
const mono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
});
const display = localFont({
  src: [
    { path: "./fonts/InstrumentSerif-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/InstrumentSerif-Italic.ttf", weight: "400", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia"],
});
export const metadata = rootMetadata();
export const dynamic = "force-dynamic";
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="en">
      <body className={`${body.variable} ${mono.variable} ${display.variable}`}>
        <a className="skip-link" href="#main-content">
          {common.skipLink}
        </a>
        <Header />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
        <Footer />
        <SiteStructuredData />
      </body>
    </html>
  );
}
