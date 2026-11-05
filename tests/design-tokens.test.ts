import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const css = readFileSync("src/app/globals.css", "utf8");
function declarations(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing palette ${selector}`);
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map((m) => [m[1], m[2]]),
  );
}
function brightness(hex: string) {
  const v = hex
    .slice(1)
    .match(/../g)!
    .map((n) => parseInt(n, 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a: string, b: string) {
  const x = brightness(a),
    y = brightness(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe.each([":root", ".tone-light"])("AA semantic palette %s", (selector) => {
  const colors = { ...declarations(":root"), ...declarations(selector) };
  for (const foreground of [
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--accent",
    "--accent-muted",
    "--error",
    "--success",
  ])
    for (const background of ["--background", "--surface", "--surface-elevated"])
      it(`${foreground} on ${background} passes normal text`, () => {
        expect(contrast(colors[foreground], colors[background])).toBeGreaterThanOrEqual(4.5);
      });
  for (const foreground of ["--border-control", "--focus-ring"])
    for (const background of ["--background", "--surface", "--surface-elevated"])
      it(`${foreground} on ${background} identifies controls`, () => {
        expect(contrast(colors[foreground], colors[background])).toBeGreaterThanOrEqual(3);
      });
  it("inverse primary button is legible", () =>
    expect(contrast(colors["--background"], colors["--text-primary"])).toBeGreaterThanOrEqual(4.5));
});
it("defines readable minimum type sizes independently of the CSS component usage", () => {
  const caption = Number(css.match(/--type-caption:\s*([\d.]+)rem/)?.[1]) * 16,
    body = Number(css.match(/--type-body:\s*([\d.]+)rem/)?.[1]) * 16;
  expect(caption).toBeGreaterThanOrEqual(12);
  expect(body).toBeGreaterThanOrEqual(17);
  expect(body).toBeLessThanOrEqual(19);
});
