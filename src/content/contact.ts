export const SERVICE_OPTIONS = [
  { value: "cloud-data-engineering", label: "Cloud Data Engineering" },
  { value: "microsoft-azure-data-solutions", label: "Microsoft Azure Data Solutions" },
  { value: "data-integration-and-automation", label: "Data Integration and Automation" },
  { value: "data-warehousing-and-architecture", label: "Data Warehousing and Architecture" },
  { value: "business-intelligence-and-power-bi", label: "Business Intelligence and Power BI" },
  {
    value: "data-quality-and-analytics-consulting",
    label: "Data Quality and Analytics Consulting",
  },
  { value: "not-sure-yet", label: "Not sure yet" },
] as const;

export const CONTACT_MESSAGES = {
  success: "Your inquiry has been sent. We will review your message and reply by email.",
  development:
    "Your inquiry passed the local development checks. No email was sent because delivery is not configured in this development environment.",
  invalid: "Please check your details and try again.",
  unavailable:
    "Your inquiry could not be sent. Please try again later. Your details have been kept in the form.",
  rateLimited:
    "There have been several attempts from this connection. Please wait before trying again.",
} as const;

export type ServiceInterest = (typeof SERVICE_OPTIONS)[number]["value"];

export function isServiceInterest(value: string): value is ServiceInterest {
  return SERVICE_OPTIONS.some((option) => option.value === value);
}
