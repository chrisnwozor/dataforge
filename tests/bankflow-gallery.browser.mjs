import { existsSync } from "node:fs";
/**
 * Run against a running development server:
 * TEST_BASE_URL=http://localhost:3000 node tests/bankflow-gallery.browser.mjs
 * The temporary fixture route is created exclusively for this test and removed.
 */
import assert from "node:assert/strict";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const fixtureDirectory = fileURLToPath(new URL("../src/app/work/gallery-review", import.meta.url));
const fixturePath = `${fixtureDirectory}/page.tsx`;
const baseUrl = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const fixture = `import { notFound } from "next/navigation";
import { BankFlowGallery } from "@/components/bankflow/BankFlowGallery";
const screenshots = [
  {src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='640' height='360' fill='%2324364a'/%3E%3C/svg%3E",alt:"First keyboard test image",caption:"First test fixture",width:640,height:360},
  {src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='640' height='360' fill='%233d536a'/%3E%3C/svg%3E",alt:"Second keyboard test image",caption:"Second test fixture",width:640,height:360},
];
export default function GalleryReview(){if(process.env.NODE_ENV === "production")notFound();return <section style={{padding:32}}><h1>Keyboard test fixture</h1><BankFlowGallery screenshots={screenshots}/></section>}
`;

let browser;
let fixtureCreated = false;
try {
  await mkdir(fixtureDirectory);
  fixtureCreated = true;
  await writeFile(fixturePath, fixture, { flag: "wx" });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${baseUrl}/work/gallery-review`, { waitUntil: "networkidle" });
  const firstOpener = page.getByRole("button", {
    name: "Open full-size image: First test fixture",
  });
  await firstOpener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor({ state: "visible" });
  const closeButton = page.getByRole("button", { name: "Close image viewer" });
  assert.equal(await closeButton.evaluate((element) => element === document.activeElement), true);

  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Next image", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(await closeButton.evaluate((element) => element === document.activeElement), true);

  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.getByRole("dialog").getByAltText("Second keyboard test image").isVisible(),
    true,
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.getByRole("dialog").getByAltText("First keyboard test image").isVisible(),
    true,
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal(
    await page.getByRole("dialog").getByAltText("Second keyboard test image").isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await firstOpener.evaluate((element) => element === document.activeElement), true);
  await firstOpener.click();
  await closeButton.click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await firstOpener.evaluate((element) => element === document.activeElement), true);
  console.log(
    "BankFlow gallery browser fixture passed: keyboard opening, initial focus, Tab trap, arrow navigation, wrapping, Escape, close control and focus return.",
  );
} finally {
  await browser?.close();
  if (fixtureCreated) {
    await rm(fixturePath, { force: true });
    await rmdir(fixtureDirectory);
  }
}
