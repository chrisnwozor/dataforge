export type IndustryScenario = {
  id: string;
  name: string;
  serviceId: string;
  question: string;
  challenge: string;
  sources: readonly string[];
  approach: string;
  outcomes: readonly string[];
};

export const industryScenarios = [
  {
    id: "retail-and-ecommerce",
    name: "Retail and E-commerce",
    serviceId: "data-integration-and-automation",
    question: "Which products are selling, and what is left after the costs?",
    challenge:
      "A retailer might hold order data in its online store, stock in another system and costs in spreadsheets. Sales totals can look healthy while returns, stock availability and product margins remain difficult to see together.",
    sources: [
      "Online store orders",
      "Inventory records",
      "Returns and refunds",
      "Product and cost files",
    ],
    approach:
      "We would connect the relevant exports or supported APIs, keep a traceable copy of source data and prepare a shared product and order model. Agreed sales, return and margin definitions could then feed a Power BI report, with refresh and quality checks designed around the available sources.",
    outcomes: [
      "A consistent view of sales and returns across the connected channels",
      "More informed stock and product decisions",
      "Less repeated preparation of the same trading figures",
    ],
  },
  {
    id: "logistics-and-operations",
    name: "Logistics and Operations",
    serviceId: "cloud-data-engineering",
    question: "Where does the work slow down between order and delivery?",
    challenge:
      "An operations business might track orders, warehouse events and deliveries in separate systems. Teams may spend more time assembling a status report than investigating delayed work or understanding recurring exceptions.",
    sources: [
      "Order records",
      "Warehouse events",
      "Transport and delivery updates",
      "Operational reference files",
    ],
    approach:
      "We would map the available events to an agreed operational journey, then build scheduled data movement into an organised reporting store. Clear definitions for milestones and exceptions could support a report that shows where work waits and which records need investigation.",
    outcomes: [
      "A clearer picture of progress across the connected operation",
      "More useful investigation of delays and exceptions",
      "Repeatable reporting with traceable milestone definitions",
    ],
  },
  {
    id: "financial-services",
    name: "Financial Services",
    serviceId: "data-quality-and-analytics-consulting",
    question: "Can we trace the reported figure back to its source?",
    challenge:
      "A financial services team might need to reconcile transaction extracts with internal reports. Duplicate records, incomplete reference data or inconsistent definitions could make it hard to explain why figures differ.",
    sources: [
      "Transaction extracts",
      "Account reference data",
      "Internal reporting files",
      "Reconciliation reference figures",
    ],
    approach:
      "We would agree the measures and validation rules first, then design a traceable flow from source records to prepared reporting data. Records that fail agreed checks could be isolated for review, with reconciliation evidence and documented definitions alongside the reporting model. Security and any regulatory requirements would need explicit assessment in scope.",
    outcomes: [
      "A clearer explanation of how an agreed reporting figure is produced",
      "Visible exceptions for review before reporting",
      "More consistent definitions and reconciliation checks",
    ],
  },
  {
    id: "professional-services",
    name: "Professional Services",
    serviceId: "business-intelligence-and-power-bi",
    question: "How do time, delivery and billing connect across our projects?",
    challenge:
      "A professional services business might keep time entries, project plans and invoices in different tools. Project reviews can become a manual exercise, and teams may use different definitions of utilisation or project performance.",
    sources: [
      "Time entries",
      "Project and resourcing records",
      "Invoice data",
      "Client and project reference data",
    ],
    approach:
      "We would establish common project identifiers and agree the measures that matter to the business. A prepared reporting model could connect time, project and billing information, with Power BI views for reviewing delivery and capacity at the appropriate level of access.",
    outcomes: [
      "A shared view of project activity and the related billing data",
      "More consistent conversations about capacity and delivery",
      "Less manual preparation for recurring project reviews",
    ],
  },
] as const satisfies readonly IndustryScenario[];

export const solutionsPage = {
  label: "Solutions",
  eyebrow: "Problems in context",
  title: "Your industry. A clearer view.",
  description:
    "The systems and measures change from one industry to another. The starting point stays the same: understand the question, connect the right information and check that it can support the answer.",
  illustrativeNote:
    "These scenarios are illustrative, hypothetical examples of how we could approach a challenge. They are not client engagements or claims of delivered results. Scope and outcomes depend on the available data and agreed requirements.",
  labels: {
    challenge: "Typical challenge",
    sources: "Data sources might include",
    approach: "How we would approach it",
    outcomes: "What this could enable",
    cta: "Discuss a similar challenge",
  },
  closing: {
    eyebrow: "Your context matters",
    title: "Your business does not need to fit an example.",
    description:
      "Tell us where your information lives, what is difficult today and which decision you need to make. That is enough to start a useful conversation.",
  },
} as const;
