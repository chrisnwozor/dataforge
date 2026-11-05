import { SERVICE_OPTIONS } from "@/content/contact";
import type { ContactValues } from "@/lib/contact/schema";
import type { ContactEnvironment } from "@/lib/env";
import { escapeHtml, stripHeaderInjection } from "@/lib/contact/security";

export function buildContactEmail(values: ContactValues) {
  const service = SERVICE_OPTIONS.find((option) => option.value === values.service)!.label;
  const rows = [
    ["Name", values.name],
    ["Business", values.businessName],
    ["Email", values.email],
    ["Service interest", service],
    ["Project description", values.projectDescription],
    ["Privacy notice acknowledged", "Yes"],
  ];
  return {
    subject: stripHeaderInjection(`Consultation inquiry: ${values.businessName}`).slice(0, 200),
    reply_to: stripHeaderInjection(values.email),
    text: rows.map(([label, value]) => `${label}:\n${value}`).join("\n\n"),
    html: `<h1>DataForge consultation inquiry</h1>${rows.map(([label, value]) => `<h2>${escapeHtml(label)}</h2><p style="white-space:pre-wrap">${escapeHtml(value)}</p>`).join("")}`,
  };
}

export async function sendContactEmail(
  values: ContactValues,
  env: ContactEnvironment,
  nonce: string,
): Promise<"sent" | "development"> {
  if (!env.delivery) {
    if (env.mode === "production") throw new Error("Contact delivery unavailable.");
    console.info(
      "[contact] DEVELOPMENT ONLY: inquiry accepted locally; email delivery is not configured. No message content was logged.",
    );
    return "development";
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.delivery.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `contact-${nonce}`,
    },
    body: JSON.stringify({
      from: env.delivery.from,
      to: [env.delivery.to],
      ...buildContactEmail(values),
    }),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Contact delivery failed.");
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("id" in result) ||
    typeof result.id !== "string" ||
    !result.id
  )
    throw new Error("Contact delivery failed.");
  return "sent";
}
