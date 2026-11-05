import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

// A real browser audit, deliberately separate from the unit test runner.
const baseUrl = process.env.SITE_QA_BASE_URL ?? "http://localhost:3000";
const round = Number(process.env.SITE_QA_ROUND ?? process.env.ROUND ?? "1");
const final = /^(1|true)$/i.test(process.env.SITE_QA_FINAL ?? process.env.FINAL ?? "false");
const statesOnly = /^(1|true)$/i.test(process.env.SITE_QA_STATES_ONLY ?? "false");
const outputDir = `/tmp/dataforge-qa/round-${round}`;
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
const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];
const result = {
  round,
  final,
  baseUrl,
  startedAt: new Date().toISOString(),
  cases: [],
  zoomChecks: [],
  states: [],
  links: [],
  failures: [],
};
const discoveredLinks = new Map();

await mkdir(outputDir, { recursive: true });
if (final) await mkdir("docs/screenshots", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ reducedMotion: "reduce" });

function slug(route) {
  return route === "/" ? "home" : route.slice(1).replaceAll("/", "-");
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function violationsForReport(violations) {
  return violations.map(({ id, impact, description, helpUrl, nodes }) => ({
    id,
    impact,
    description,
    helpUrl,
    nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
  }));
}
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Trigger viewport-based reveals before inspecting the complete page.
  await page.evaluate(async () => {
    const step = Math.max(window.innerHeight * 0.8, 400);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(180);
}
async function collectMetrics(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const headings = [...document.querySelectorAll("main h1,main h2,main h3,main h4")].map(
      (heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent.trim(),
      }),
    );
    const skips = headings.filter(
      (heading, index) => index > 0 && heading.level > headings[index - 1].level + 1,
    );
    const overflow = document.documentElement.scrollWidth > width + 1;
    const offenders = overflow
      ? [...document.querySelectorAll("main *")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < -1 || box.right > width + 1);
          })
          .slice(0, 12)
          .map((element) => ({
            tag: element.tagName,
            className: element.getAttribute("class"),
            text: element.textContent.slice(0, 80),
          }))
      : [];
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      overflow,
      offenders,
      h1Count: document.querySelectorAll("h1").length,
      headings,
      headingSkips: skips,
    };
  });
}
async function captureState(page, name, details = {}) {
  const screenshot = path.join(outputDir, `state-${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  const violations = violationsForReport(axe.violations);
  result.states.push({ name, screenshot, ...details, violations });
  if (violations.some((violation) => ["serious", "critical"].includes(violation.impact)))
    result.failures.push(`State ${name}: accessibility violation`);
}

try {
  for (const viewport of statesOnly ? [] : viewports) {
    for (const route of routes) {
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      const browserErrors = [];
      const consoleMessages = [];
      let contactApiRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/contact") contactApiRequests += 1;
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()))
          consoleMessages.push({ type: message.type(), text: message.text() });
      });
      const entry = { route, viewport, browserErrors, consoleMessages };
      try {
        const response = await page.goto(new URL(route, baseUrl).href, {
          waitUntil: "networkidle",
          timeout: 45000,
        });
        entry.status = response?.status();
        await settle(page);
        if (route === "/contact") {
          await page
            .locator('button[type="submit"], [aria-labelledby="contact-unavailable-title"]')
            .waitFor({ state: "visible" });
          entry.contactUnavailable = (await page.locator("#contact-unavailable-title").count()) > 0;
          entry.contactApiRequests = contactApiRequests;
          if (entry.contactUnavailable && contactApiRequests !== 0)
            result.failures.push("Unavailable contact page made an automatic API request");
        }
        entry.title = await page.title();
        Object.assign(entry, await collectMetrics(page));
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
          .analyze();
        entry.violations = violationsForReport(axe.violations);
        const prefix = `${slug(route)}-${viewport.width}x${viewport.height}`;
        entry.fullScreenshot = path.join(outputDir, `${prefix}-full.png`);
        entry.viewportScreenshot = path.join(outputDir, `${prefix}-viewport.png`);
        await page.screenshot({ path: entry.fullScreenshot, fullPage: true });
        await page.screenshot({ path: entry.viewportScreenshot, fullPage: false });
        if (final && [1440, 390].includes(viewport.width)) {
          entry.finalScreenshot = `docs/screenshots/${slug(route)}-${viewport.width === 1440 ? "desktop" : "mobile"}.png`;
          await page.screenshot({ path: entry.finalScreenshot, fullPage: true });
        }
        const anchors = await page.locator("a[href]").evaluateAll((elements) =>
          elements.map((element) => ({
            href: element.getAttribute("href"),
            rel: element.getAttribute("rel") ?? "",
            target: element.getAttribute("target"),
          })),
        );
        for (const anchor of anchors) {
          const key = `${route}::${anchor.href}`;
          if (!discoveredLinks.has(key)) discoveredLinks.set(key, { source: route, ...anchor });
        }
        if (entry.status !== 200)
          result.failures.push(`${route} at ${viewport.width}: HTTP ${entry.status}`);
        if (entry.overflow)
          result.failures.push(`${route} at ${viewport.width}: horizontal overflow`);
        if (entry.h1Count !== 1)
          result.failures.push(`${route} at ${viewport.width}: expected one h1`);
        if (browserErrors.length)
          result.failures.push(`${route} at ${viewport.width}: browser error`);
        if (consoleMessages.length)
          result.failures.push(`${route} at ${viewport.width}: browser console warning or error`);
        if (
          entry.violations.some((violation) => ["serious", "critical"].includes(violation.impact))
        )
          result.failures.push(`${route} at ${viewport.width}: accessibility violation`);
      } catch (error) {
        entry.error = error.message;
        result.failures.push(`${route} at ${viewport.width}: ${error.message}`);
      }
      result.cases.push(entry);
      console.log(
        `Round ${round}: ${route} ${viewport.width}×${viewport.height} ${entry.error ? "FAILED" : "captured"}`,
      );
      await page.close();
    }
  }

  if (final || /^(1|true)$/i.test(process.env.SITE_QA_ZOOM ?? "false")) {
    const supplementaryViewports = [
      { label: "380px", width: 380, height: 844, deviceScaleFactor: 1 },
      { label: "125-percent-equivalent", width: 1152, height: 720, deviceScaleFactor: 1.25 },
      { label: "200-percent-equivalent", width: 720, height: 450, deviceScaleFactor: 2 },
    ];
    for (const supplementary of supplementaryViewports) {
      const zoomContext = await browser.newContext({
        viewport: { width: supplementary.width, height: supplementary.height },
        deviceScaleFactor: supplementary.deviceScaleFactor,
        reducedMotion: "reduce",
      });
      for (const route of routes) {
        const zoomPage = await zoomContext.newPage();
        const entry = {
          route,
          ...supplementary,
          method:
            "CSS viewport and device scale preserve the desktop physical pixel dimensions; no browser chrome zoom was invoked.",
        };
        try {
          const response = await zoomPage.goto(new URL(route, baseUrl).href, {
            waitUntil: "networkidle",
            timeout: 45000,
          });
          await settle(zoomPage);
          entry.status = response?.status();
          Object.assign(entry, await collectMetrics(zoomPage));
          entry.screenshot = path.join(outputDir, `${slug(route)}-${supplementary.label}.png`);
          await zoomPage.screenshot({ path: entry.screenshot, fullPage: true });
          if (entry.overflow || entry.status !== 200)
            result.failures.push(`${route} at ${supplementary.label}: layout or HTTP failure`);
        } catch (error) {
          entry.error = error.message;
          result.failures.push(`${route} at ${supplementary.label}: ${error.message}`);
        }
        result.zoomChecks.push(entry);
        console.log(`Round ${round}: ${route} ${supplementary.label} checked`);
        await zoomPage.close();
      }
      await zoomContext.close();
    }
  }

  const page = await context.newPage();
  if (statesOnly) {
    for (const route of routes) {
      await page.goto(new URL(route, baseUrl).href, { waitUntil: "networkidle" });
      const anchors = await page.locator("a[href]").evaluateAll((elements) =>
        elements.map((element) => ({
          href: element.getAttribute("href"),
          rel: element.getAttribute("rel") ?? "",
          target: element.getAttribute("target"),
        })),
      );
      for (const anchor of anchors)
        discoveredLinks.set(`${route}::${anchor.href}`, { source: route, ...anchor });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const menuTrigger = page.getByRole("button", { name: "Open navigation menu" });
  await menuTrigger.focus();
  await page.keyboard.press("Enter");
  requireCondition(
    await page.locator("#mobile-navigation").evaluate((dialog) => dialog.open),
    "Mobile menu did not open with keyboard",
  );
  await page.waitForTimeout(250);
  const dialogFocus = await page
    .locator("#mobile-navigation")
    .evaluate((dialog) => dialog.contains(document.activeElement));
  requireCondition(dialogFocus, "Mobile menu did not receive focus");
  await captureState(page, "mobile-menu-open", {
    keyboardOpened: true,
    focusInsideDialog: dialogFocus,
  });
  await page.keyboard.press("Escape");
  requireCondition(
    await menuTrigger.evaluate((element) => element === document.activeElement),
    "Mobile menu did not restore trigger focus",
  );
  result.states.push({ name: "mobile-menu-escape", closed: true, restoredFocus: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const originalHeaderClass = await page.locator("header").getAttribute("class");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(250);
  const scrolledHeaderClass = await page.locator("header").getAttribute("class");
  requireCondition(originalHeaderClass !== scrolledHeaderClass, "Header did not change on scroll");
  await captureState(page, "header-scrolled", { changedClass: true });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const primaryCta = page.getByRole("link", { name: "Discuss Your Project" }).first();
  await primaryCta.focus();
  await captureState(page, "primary-cta-keyboard-focus");
  await primaryCta.evaluate((element) => element.blur());
  await primaryCta.hover();
  await captureState(page, "primary-cta-hover");
  await page.goto(new URL("/contact", baseUrl).href, { waitUntil: "networkidle" });
  if ((await page.locator("form").count()) > 0) {
    await page.waitForFunction(() => {
      const button = document.querySelector('button[type="submit"]');
      return button && !button.disabled;
    });
    await page.getByRole("button", { name: "Send inquiry" }).click();
    const summary = page.locator('[aria-labelledby="contact-error-title"]');
    await summary.waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector('[aria-labelledby="contact-error-title"]'),
    );
    requireCondition(
      await summary.evaluate((element) => element === document.activeElement),
      "Form error summary did not receive focus",
    );
    const invalidFieldCount = await page.locator('[aria-invalid="true"]').count();
    requireCondition(
      invalidFieldCount === 6,
      `Expected six invalid visible fields; saw ${invalidFieldCount}`,
    );
    await captureState(page, "form-validation-errors", { invalidFieldCount, focusedSummary: true });
    await summary.locator("a").first().click();
    await page.waitForFunction(() => document.activeElement?.id === "contact-name");
    requireCondition(
      await page.locator("#contact-name").evaluate((element) => element === document.activeElement),
      "Error summary did not focus its field",
    );

    await page.goto(
      new URL(
        "/contact?service=business-intelligence-and-power-bi&industry=retail-and-ecommerce",
        baseUrl,
      ).href,
      { waitUntil: "networkidle" },
    );
    requireCondition(
      (await page.locator("#contact-service").inputValue()) ===
        "business-intelligence-and-power-bi",
      "Valid service prefill was lost",
    );
    requireCondition(
      (await page.locator("#contact-projectDescription").inputValue()).includes(
        "Retail and E-commerce",
      ),
      "Industry prefill was lost",
    );
    await page.locator("#contact-name").fill("QA Review");
    await page.locator("#contact-businessName").fill("QA Demonstration");
    await page.locator("#contact-email").fill("review@example.test");
    const projectDescription =
      "We currently combine spreadsheet reports manually. We would like to understand how to build consistent reporting from our business systems.";
    await page.locator("#contact-projectDescription").fill(projectDescription);
    const actualLength = await page
      .locator("#contact-projectDescription")
      .evaluate((textarea) => textarea.value.length);
    const displayedLength = Number(
      (await page.locator("#contact-description-count").innerText()).split("/")[0].trim(),
    );
    requireCondition(
      actualLength === displayedLength && actualLength === projectDescription.length,
      "Description counter did not reconcile with native input length",
    );
    await page.locator("#contact-consent").check();
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    await page.route("**/api/contact", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            message: "The test delivery service is temporarily unavailable. Please try again.",
          }),
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Send inquiry" }).click();
    await page
      .getByText("The test delivery service is temporarily unavailable. Please try again.")
      .waitFor();
    requireCondition(
      (await page.locator("#contact-projectDescription").inputValue()) === projectDescription,
      "Recoverable failure lost the project description",
    );
    requireCondition(
      (await page.locator("#contact-name").inputValue()) === "QA Review",
      "Recoverable failure lost the name",
    );
    requireCondition(
      await page.locator("#contact-consent").isChecked(),
      "Recoverable failure lost consent",
    );
    await captureState(page, "form-recoverable-error", {
      inputsPreserved: true,
      counter: { nativeLength: actualLength, displayedLength },
    });
    await page.unroute("**/api/contact");
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    const deliveryResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/contact") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send inquiry" }).click();
    const deliveryResponse = await deliveryResponsePromise;
    const delivery = await deliveryResponse.json();
    requireCondition(
      deliveryResponse.status() === 200 &&
        delivery.ok === true &&
        (delivery.development === true || delivery.devMode === true),
      "Actual contact endpoint did not confirm the safe development delivery path",
    );
    await page.getByRole("heading", { name: "Development submission received." }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Development submission received.",
    );
    requireCondition(
      (await page.locator("form").count()) === 0,
      "Success did not replace the form",
    );
    requireCondition(
      await page
        .getByRole("heading", { name: "Development submission received." })
        .evaluate((element) => element === document.activeElement),
      "Success heading did not receive focus",
    );
    await captureState(page, "form-development-success", {
      actualHttpStatus: deliveryResponse.status(),
      development: true,
      formReplaced: true,
      emailSent: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("heading", { name: "Development submission received." })
      .scrollIntoViewIfNeeded();
    await captureState(page, "form-development-success-mobile");
    await page.goto(
      new URL("/contact?service=untrusted-value&industry=untrusted-value", baseUrl).href,
      { waitUntil: "networkidle" },
    );
    requireCondition(
      (await page.locator("#contact-service").inputValue()) === "",
      "Untrusted service query was accepted",
    );
    requireCondition(
      (await page.locator("#contact-projectDescription").inputValue()) === "",
      "Untrusted industry query was accepted",
    );
    result.states.push({
      name: "contact-query-allowlist",
      validPrefills: true,
      invalidPrefillsIgnored: true,
    });
  } else {
    const unavailable = page.locator('[aria-labelledby="contact-unavailable-title"]');
    requireCondition(
      await unavailable.isVisible(),
      "Contact page has neither a usable form nor an unavailable explanation",
    );
    requireCondition(
      (await unavailable.getByRole("link", { name: "Reload this page" }).getAttribute("href")) ===
        "/contact",
      "Unavailable panel reload link is not usable",
    );
    const getResponse = await context.request.get(new URL("/api/contact", baseUrl).href);
    const postResponse = await context.request.post(new URL("/api/contact", baseUrl).href, {
      headers: { Origin: new URL(baseUrl).origin },
      data: {},
    });
    requireCondition(
      getResponse.status() === 503 && postResponse.status() === 503,
      "Unconfigured API did not fail safely",
    );
    await unavailable.scrollIntoViewIfNeeded();
    await captureState(page, "contact-production-unavailable", {
      safeGetStatus: getResponse.status(),
      safePostStatus: postResponse.status(),
    });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(new URL("/work/bankflow", baseUrl).href, { waitUntil: "networkidle" });
  const gold = page
    .locator('svg g[role="button"]')
    .filter({ hasText: "Gold" })
    .filter({ visible: true })
    .first();
  await gold.scrollIntoViewIfNeeded();
  await gold.focus();
  await page.keyboard.press("Enter");
  requireCondition(
    (await gold.getAttribute("aria-pressed")) === "true",
    "Architecture Gold stage did not respond to keyboard focus",
  );
  await captureState(page, "bankflow-diagram-focus", { keyboardActivated: true, stage: "gold" });
  await page.close();

  // Read-only link crawling, with anchor checks against returned HTML.
  const responseCache = new Map();
  for (const anchor of discoveredLinks.values()) {
    const checked = { ...anchor };
    try {
      requireCondition(anchor.href && anchor.href !== "#", "Empty or dead hash link");
      if (/^(mailto:|tel:)/.test(anchor.href)) {
        checked.status = "non-http";
        result.links.push(checked);
        continue;
      }
      const target = new URL(anchor.href, new URL(anchor.source, baseUrl));
      checked.url = target.href;
      if (target.origin !== new URL(baseUrl).origin) {
        checked.external = true;
        const rel = anchor.rel.split(/\s+/);
        requireCondition(
          rel.includes("noopener") && rel.includes("noreferrer"),
          "External link lacks noopener noreferrer",
        );
      }
      const requestUrl = `${target.origin}${target.pathname}${target.search}`;
      if (!responseCache.has(requestUrl)) {
        const response = await context.request.get(requestUrl, {
          failOnStatusCode: false,
          timeout: 20000,
        });
        responseCache.set(requestUrl, { status: response.status(), body: await response.text() });
      }
      const response = responseCache.get(requestUrl);
      checked.status = response.status;
      requireCondition(response.status < 400, `HTTP ${response.status}`);
      if (target.hash) {
        const id = decodeURIComponent(target.hash.slice(1));
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        checked.anchorFound = new RegExp(`(?:id|name)=["']${escaped}["']`).test(response.body);
        requireCondition(checked.anchorFound, `Anchor ${target.hash} does not exist`);
      }
    } catch (error) {
      checked.error = error.message;
      result.failures.push(`Link ${anchor.source} → ${anchor.href}: ${error.message}`);
    }
    result.links.push(checked);
  }
} catch (error) {
  result.failures.push(`State verification: ${error.stack ?? error.message}`);
} finally {
  await browser.close();
  result.finishedAt = new Date().toISOString();
  result.summary = {
    viewportCases: result.cases.length,
    supplementaryZoomChecks: result.zoomChecks.length,
    screenshots:
      result.cases.reduce(
        (sum, entry) =>
          sum +
          Number(Boolean(entry.fullScreenshot)) +
          Number(Boolean(entry.viewportScreenshot)) +
          Number(Boolean(entry.finalScreenshot)),
        0,
      ) +
      result.states.filter((entry) => entry.screenshot).length +
      result.zoomChecks.filter((entry) => entry.screenshot).length,
    accessibilityViolations: result.cases.reduce(
      (sum, entry) => sum + (entry.violations?.length ?? 0),
      0,
    ),
    stateCount: result.states.length,
    checkedLinks: result.links.length,
    failureCount: result.failures.length,
  };
  const report = `/tmp/dataforge-qa-round-${round}${statesOnly ? "-states" : ""}.json`;
  await writeFile(report, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({ report, summary: result.summary, failures: result.failures }, null, 2),
  );
  process.exitCode = result.failures.length ? 1 : 0;
}
