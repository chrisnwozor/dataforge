import type { Metadata } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "@/components/auth/provider";
import { ThemeProvider } from "@/components/theme-provider";
import { ReadabilityProvider } from "@/components/readability/provider";
import { READABILITY_BOOTSTRAP } from "@/lib/ui/readability";
import { Navbar, Footer } from "@/components/navbar";
import "./globals.css";
// Committed Latin subsets generated from the geist package; see scripts/subset-fonts.py.
const GeistSans = localFont({
  src: "./fonts/geist-sans-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});
const GeistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
});
export const metadata: Metadata = {
  title: {
    default: "DataForge — Your data, warehouse-ready.",
    template: "%s · DataForge",
  },
  description:
    "Turn raw CSV and Excel data into a thoughtfully modeled SQL Server warehouse.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <script dangerouslySetInnerHTML={{ __html: READABILITY_BOOTSTRAP }} />
        <ThemeProvider>
          <ReadabilityProvider>
            <AuthProvider>
              <a href="#main-content" className="skip-link">
                Skip to main content
              </a>
              <Navbar />
              <div id="main-content" tabIndex={-1}>
                {children}
              </div>
              <Footer />
            </AuthProvider>
          </ReadabilityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
