import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.SITE_QA_BASE_URL ?? "http://localhost:3000";
const routes = [
  "/",
  "/services",
  "/solutions",
  "/approach",
  "/work",
  "/work/bankflow",
  "/about",
  "/contact",
  "/privacy",
];
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const report = { pages: [], assets: [], retiredRoutes: [], noJavascript: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => {
  if (["warning", "error"].includes(message.type())) report.errors.push(message.text());
});
try {
  const titles = new Set();
  for (const route of routes) {
    const response = await page.goto(new URL(route, base).href);
    assert.equal(response.status(), 200);
    const csp = response.headers()["content-security-policy"];
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert(!csp.includes("'unsafe-eval'"));
    assert(csp.includes("frame-ancestors 'none'"));
    for (const header of [
      "x-content-type-options",
      "x-frame-options",
      "permissions-policy",
      "referrer-policy",
      "strict-transport-security",
    ])
      assert(response.headers()[header], header);
    const metadata = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content,
      canonical: document.querySelector('link[rel="canonical"]')?.href,
      og: document.querySelector('meta[property="og:image"]')?.content,
      lang: document.documentElement.lang,
      json: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => ({
        value: JSON.parse(node.textContent),
        nonce: node.nonce,
      })),
      inlineScripts: [...document.querySelectorAll("script:not([src])")].map((node) => node.nonce),
    }));
    assert.equal(metadata.lang, "en");
    assert(metadata.title.length > 5);
    assert(!titles.has(metadata.title));
    titles.add(metadata.title);
    assert(metadata.description.length > 50);
    assert.equal(metadata.canonical, new URL(route, base).href);
    assert(metadata.og);
    const objects = metadata.json.flatMap((j) =>
      Array.isArray(j.value) ? j.value : (j.value["@graph"] ?? [j.value]),
    );
    for (const type of [
      "Organization",
      "WebSite",
      ...(route !== "/" ? ["BreadcrumbList"] : []),
      ...(route === "/work/bankflow" ? ["CreativeWork"] : []),
    ])
      assert(
        objects.some((o) => o["@type"] === type),
        `${route} ${type}`,
      );
    assert(
      metadata.json.every((j) => j.nonce === nonce),
      "JSON-LD CSP nonce",
    );
    assert(
      metadata.inlineScripts.every((value) => value === nonce),
      "inline script CSP nonce",
    );
    report.pages.push({
      route,
      title: metadata.title,
      canonical: metadata.canonical,
      description: metadata.description,
      schemas: objects.map((o) => o["@type"]),
      nonceVerified: true,
      securityHeadersVerified: true,
    });
  }
  for (const route of [
    "/robots.txt",
    "/sitemap.xml",
    "/manifest.webmanifest",
    "/icon",
    "/apple-icon",
    "/opengraph-image",
  ]) {
    const response = await fetch(new URL(route, base));
    assert.equal(response.status, 200);
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength > 0);
    report.assets.push({
      route,
      status: response.status,
      type: response.headers.get("content-type"),
      bytes: bytes.byteLength,
    });
  }
  for (const route of [
    "/projects",
    "/settings",
    "/sign-in",
    "/api/projects",
    "/api/health",
    "/this-page-does-not-exist",
  ]) {
    const response = await fetch(new URL(route, base));
    assert.equal(response.status, 404, route);
    report.retiredRoutes.push({ route, status: response.status });
  }
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  for (const route of routes) {
    await plain.goto(new URL(route, base).href);
    assert.equal(await plain.locator("h1").count(), 1);
    assert(await plain.locator("h1").isVisible());
    report.noJavascript.push({ route, headingVisible: true });
  }
  await context.close();
  assert.deepEqual(report.errors, []);
  await writeFile("/tmp/dataforge-site-metadata.json", JSON.stringify(report, null, 2));
  console.log(
    `PASS ${routes.length} metadata/JSON-LD/nonce/security pages, ${report.assets.length} assets, ${report.retiredRoutes.length} 404s, ${report.noJavascript.length} no-JavaScript pages`,
  );
} finally {
  await browser.close();
}
