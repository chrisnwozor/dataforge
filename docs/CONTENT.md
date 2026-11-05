# Content and evidence

Public copy is in typed `src/content/` modules. Keep the central promise verbatim: **We turn fragmented business data into reliable intelligence that supports better decisions.**

| Module                          | Edit here                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `site.ts`                       | Company descriptor, navigation, footer, SEO, optional real team/social links |
| `common.ts`, `home.ts`          | Shared consultation invitation, homepage and hero labels                     |
| `services.ts`                   | Six services, deliverables, technologies, ideal situations                   |
| `solutions.ts`                  | Four explicitly hypothetical industry situations                             |
| `approach.ts`, `about.ts`       | Six stages, client inputs, mission and principles                            |
| `work.ts`, `bankflow.ts`        | Portfolio, supplied project facts, diagrams and assets                       |
| `contact.ts`, `contact-page.ts` | Shared service options/API messages and form copy                            |
| `privacy.ts`                    | Contact collection and configured-provider notice                            |

Service IDs are stable anchors/form values. Keep the contact allowlist aligned when changing IDs; content-link tests catch discrepancies. Industry links prefill validated service/industry context.

## BankFlow facts

BankFlow is prominently labelled a **personal demonstration project built on sample banking transaction data**, never a client engagement. Supplied facts: Azure Data Factory; ADLS Gen2; Bronze/Silver/Gold; cleaning, validation, duplicate detection and quarantine; 385 source/378 validated/7 quarantined; seven Gold analytical tables; fact/dimension modelling; Power BI integration. Independent tests reconcile385=378+7.

Do not invent throughput, savings, client results, failure reasons, source-system names or exact Gold table names. `goldTableNames` is an empty, commented owner hook. Verify the actual seven names before publishing. The architecture is a conceptual diagram of supplied facts, not a production screenshot.

## Genuine screenshots

Place real, appropriately redacted WebP/AVIF screenshots in `public/case-studies/bankflow/`. Register each in the typed `screenshots` array in `src/content/bankflow.ts` with `src`, accurate `alt`, factual `caption`, and actual intrinsic `width`/`height`.

```ts
{
  src: "/case-studies/bankflow/your-real-file.webp",
  alt: "An accurate description of what is visible.",
  caption: "A factual caption for this project image.",
  width: 1600,
  height: 1000,
}
```

These dimensions illustrate the contract, not an existing image. `next/image` reserves space and optimises real assets. The viewer supports arrows, focus trapping, Escape and return focus. Empty configuration hides the gallery in production; development may display an explicitly labelled review frame. Never present the browser-test fixture or a fabricated image as project evidence.

## Owner hooks

`siteConfig.team` and `socialLinks` are empty. A real team entry takes name,role,bio, optional verifiable credentials. Add only approved, truthful information. Do not invent founders, employers, certifications, awards or team size. `NEXT_PUBLIC_CONTACT_EMAIL` reveals a public mailto only when configured validly. No address/phone is invented. Review all claims before publication; timelines, prices and guaranteed outcomes are deliberately absent.
