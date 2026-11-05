import { z } from "zod";
import { SERVICE_OPTIONS } from "@/content/contact";

const singleLine = (max: number, message: string) =>
  z
    .string()
    .trim()
    .min(2, message)
    .max(max, `Please use ${max} characters or fewer.`)
    .refine(
      (value) => !/[\r\n\u0000-\u001f\u007f]/u.test(value),
      "Please use a single line of text.",
    );

export const contactSchema = z
  .object({
    name: singleLine(100, "Please enter your name."),
    businessName: singleLine(160, "Please enter your business name."),
    email: z
      .string()
      .trim()
      .max(254, "Please use a shorter email address.")
      .email("Please enter a valid email address.")
      .transform((value) => value.toLowerCase()),
    service: z.enum(
      SERVICE_OPTIONS.map((option) => option.value),
      {
        error: "Please choose a service interest.",
      },
    ),
    projectDescription: z
      .string()
      .trim()
      .min(30, "Please tell us a little more, using at least 30 characters.")
      .max(3000, "Please use 3000 characters or fewer.")
      .refine(
        (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
        "Please remove unsupported characters.",
      ),
    consent: z.boolean().refine((value) => value, "Please acknowledge the privacy notice."),
    website: z.string().max(200).optional().default(""),
    submissionToken: z.string().min(1, "Please wait for the form to be ready.").max(1024),
    turnstileToken: z.string().max(2048).optional().default(""),
  })
  .strict();

export type ContactInput = z.input<typeof contactSchema>;
export type ContactValues = z.output<typeof contactSchema>;
