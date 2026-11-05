import { describe, expect, it } from "vitest";
import { services } from "@/content/services";
import { industryScenarios } from "@/content/solutions";
import { SERVICE_OPTIONS, isServiceInterest } from "@/content/contact";

describe("editorial links into the consultation form", () => {
  it("keeps service anchors unique and every service preselection accepted", () => {
    expect(new Set(services.map((service) => service.id)).size).toBe(services.length);
    for (const service of services) {
      expect(isServiceInterest(service.id)).toBe(true);
      expect(SERVICE_OPTIONS.find((option) => option.value === service.id)?.label).toBe(
        service.name,
      );
    }
  });

  it("links every industry example to an existing service and distinct industry context", () => {
    expect(new Set(industryScenarios.map((industry) => industry.id)).size).toBe(
      industryScenarios.length,
    );
    for (const industry of industryScenarios) {
      expect(services.some((service) => service.id === industry.serviceId)).toBe(true);
      const link = new URL(
        `/contact?service=${industry.serviceId}&industry=${industry.id}`,
        "https://example.test",
      );
      expect(isServiceInterest(link.searchParams.get("service") ?? "")).toBe(true);
      expect(link.searchParams.get("industry")).toBe(industry.id);
    }
  });
});
