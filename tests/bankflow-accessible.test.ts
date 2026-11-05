import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BankFlowArchitecture } from "@/components/bankflow/BankFlowArchitecture";

it("derives each diagram control's name from all its visible labels", () => {
  const markup = renderToStaticMarkup(createElement(BankFlowArchitecture));
  const controls = [
    ...markup.matchAll(/<g[^>]*role="button"[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g),
  ];
  expect(controls).toHaveLength(14); // seven stages, desktop and stacked mobile diagrams
  const decode = (value: string) =>
    value.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
  for (const [, name, contents] of controls) {
    // Strip tags without inserting separators, as DOM textContent and axe's
    // visible-text calculation do. SVG lines must supply their own whitespace.
    const visible = decode(contents.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    expect(visible.length).toBeGreaterThan(0);
    expect(decode(name)).toBe(visible);
  }
  expect(markup).toContain('aria-label="Source transactions Sample data"');
  expect(markup).toContain('aria-label="Quarantine Failed validation"');
  expect(markup).toContain('aria-label="Gold Facts and dimensions"');
});
