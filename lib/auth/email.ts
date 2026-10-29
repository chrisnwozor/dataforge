import { HttpError } from "@/lib/server/http";
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (v) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        v
      ]!,
  );
export function appOrigin(): string {
  const origin =
    process.env.DATAFORGE_APP_URL ||
    (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  try {
    const url = new URL(origin);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(
      503,
      "Set DATAFORGE_APP_URL to the application's public HTTPS origin.",
    );
  }
}
export function emailTemplate(
  to: string,
  purpose: "verify" | "reset" | "invite",
  token: string,
  workspaceName?: string,
): EmailMessage {
  const titles = {
    verify: "Verify your email",
    reset: "Reset your password",
    invite: "Join your workspace",
  };
  const lifetimes = { verify: "24 hours", reset: "1 hour", invite: "7 days" };
  const path = {
    verify: "/verify",
    reset: "/reset-password",
    invite: "/invite",
  }[purpose];
  const url = `${appOrigin()}${path}?token=${encodeURIComponent(token)}`;
  const intro =
    purpose === "invite"
      ? `You have been invited to ${workspaceName || "a DataForge workspace"}.`
      : `Use the link below to ${titles[purpose].toLowerCase()}.`;
  const text = `DataForge\n\n${intro}\n${url}\n\nThis single-use link expires in ${lifetimes[purpose]}. If you did not request this, you can ignore this email.`;
  return {
    to,
    subject: `${titles[purpose]} · DataForge`,
    text,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:40px auto;color:#171717"><h1>DataForge<span style="color:#6366f1">.</span></h1><h2>${titles[purpose]}</h2><p>${escapeHtml(intro)}</p><p><a style="display:inline-block;padding:12px 18px;background:#6366f1;color:white;border-radius:8px" href="${escapeHtml(url)}">${titles[purpose]}</a></p><p>This single-use link expires in ${lifetimes[purpose]}. If you did not request this, you can ignore this email.</p></div>`,
  };
}
export const defaultEmailSender: EmailSender = {
  async send(message) {
    if (process.env.DATAFORGE_SMTP_HOST) {
      const { default: nodemailer } = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: process.env.DATAFORGE_SMTP_HOST,
        port: Number(process.env.DATAFORGE_SMTP_PORT || 587),
        secure: process.env.DATAFORGE_SMTP_SECURE === "true",
        requireTLS: process.env.DATAFORGE_SMTP_SECURE !== "true",
        auth: process.env.DATAFORGE_SMTP_USER
          ? {
              user: process.env.DATAFORGE_SMTP_USER,
              pass: process.env.DATAFORGE_SMTP_PASSWORD,
            }
          : undefined,
        connectionTimeout: 10000,
        socketTimeout: 15000,
      });
      try {
        await transport.sendMail({
          from:
            process.env.DATAFORGE_EMAIL_FROM ||
            "DataForge <no-reply@localhost>",
          ...message,
        });
      } catch {
        throw new HttpError(
          503,
          "Email delivery is unavailable. Please try again later.",
        );
      } finally {
        transport.close();
      }
    } else if (process.env.NODE_ENV !== "production") {
      console.info("[DataForge development email]", message.to, message.text);
    } else
      throw new HttpError(503, "Configure SMTP before sending account emails.");
  },
};

export function assertEmailConfiguration(): void {
  appOrigin();
  if (process.env.NODE_ENV === "production" && !process.env.DATAFORGE_SMTP_HOST)
    throw new HttpError(503, "Configure SMTP before sending account emails.");
}
const deliveryState = globalThis as typeof globalThis & {
  dataforgeAccountEmails?: { pending: number };
};
const deliveries = (deliveryState.dataforgeAccountEmails ??= { pending: 0 });
/** SMTP latency/failure must not reveal whether a signup/recovery address exists.
 * Delivery stays behind the same interface; injected test senders are awaited. */
export async function sendAccountEmail(
  message: EmailMessage,
  sender: EmailSender,
): Promise<void> {
  if (sender !== defaultEmailSender) {
    await sender.send(message);
    return;
  }
  if (deliveries.pending >= 64) {
    console.warn(
      "[DataForge] Account email queue is full; the user can request another link.",
    );
    return;
  }
  deliveries.pending++;
  setImmediate(() => {
    void sender
      .send(message)
      .catch(() => {
        console.warn(
          "[DataForge] Account email delivery failed; check SMTP settings. The user can request another link.",
        );
      })
      .finally(() => {
        deliveries.pending--;
      });
  });
}
