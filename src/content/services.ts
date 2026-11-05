export type Service = {
  id: string;
  name: string;
  short: string;
  outcome: string;
  description: string;
  deliverables: readonly string[];
  technologies: readonly string[];
  idealWhen: string;
};

export const services = [
  {
    id: "cloud-data-engineering",
    name: "Cloud Data Engineering",
    short: "A dependable route from source data to useful information.",
    outcome: "Make your data dependable, from the first connection.",
    description:
      "When reporting depends on fragile exports and one-off scripts, every change creates more work. We design and build cloud pipelines that collect, organise and prepare data, with clear checks and a practical way to keep them running.",
    deliverables: [
      "Documented source connections and data ingestion pipelines",
      "Cloud storage organised for raw and prepared data",
      "Repeatable processing and transformation logic",
      "Scheduled runs, monitoring and failure handling",
      "Deployment instructions and an operating handover",
    ],
    technologies: ["Azure Data Factory", "ADLS Gen2", "SQL", "Python", "Git-based deployment"],
    idealWhen:
      "Important reports depend on manual data preparation, or an existing pipeline has become difficult to trust and maintain.",
  },
  {
    id: "microsoft-azure-data-solutions",
    name: "Microsoft Azure Data Solutions",
    short: "An Azure foundation shaped around your business.",
    outcome: "Choose an Azure setup that fits the work.",
    description:
      "A cloud platform should reflect your data, your security requirements and the people who will operate it. We translate those needs into an Azure design, then implement the services the agreed scope calls for.",
    deliverables: [
      "An architecture diagram with clear service responsibilities",
      "Configured data storage and processing services",
      "Access controls and environment separation appropriate to scope",
      "A deployment approach with configuration documented",
      "Operational guidance and cost considerations for the design",
    ],
    technologies: [
      "Azure Data Factory",
      "ADLS Gen2",
      "Azure SQL",
      "Azure Synapse",
      "Microsoft Fabric, where appropriate",
    ],
    idealWhen:
      "You are starting on Azure, consolidating disconnected cloud services, or need a considered design before committing to a build.",
  },
  {
    id: "data-integration-and-automation",
    name: "Data Integration and Automation",
    short: "Connected systems. Less repetitive spreadsheet work.",
    outcome: "Let your systems do the copying.",
    description:
      "Moving information between sales, finance and operational systems by hand takes attention away from the work itself. We connect the relevant sources and automate repeatable data movement, with checks that make exceptions visible.",
    deliverables: [
      "A source-to-destination mapping of the data you need",
      "Connections to supported APIs, databases and file sources",
      "Scheduled transfers and repeatable transformations",
      "Reconciliation checks between source and destination",
      "Failure notifications and documented recovery steps",
    ],
    technologies: ["Azure Data Factory", "REST APIs", "SQL", "Python"],
    idealWhen:
      "Someone regularly copies, merges or reconciles the same information across systems and spreadsheets.",
  },
  {
    id: "data-warehousing-and-architecture",
    name: "Data Warehousing and Architecture",
    short: "One organised foundation for consistent reporting.",
    outcome: "Give your reporting a shared foundation.",
    description:
      "Different reports often disagree because they organise and interpret the same data differently. We design a data warehouse: an organised home for reporting data, with consistent definitions and a structure that people can understand.",
    deliverables: [
      "A documented target architecture and data flow",
      "Fact and dimension models: business events linked to descriptive context",
      "Transformation rules and source-to-model mappings",
      "Layered raw, prepared and reporting data using medallion or lakehouse patterns where appropriate",
      "A data dictionary with agreed business definitions",
      "A practical plan for ownership and future changes",
    ],
    technologies: [
      "Azure SQL",
      "Azure Synapse",
      "ADLS Gen2",
      "SQL",
      "Microsoft Fabric, where appropriate",
    ],
    idealWhen:
      "Reports disagree, data is hard to combine, or the business needs a structure that can support more than the next report.",
  },
  {
    id: "business-intelligence-and-power-bi",
    name: "Business Intelligence and Power BI",
    short: "Clear measures and reports that support real decisions.",
    outcome: "Make the numbers easier to use.",
    description:
      "A report is useful when it answers a real question and its numbers mean the same thing to everyone. We define the measures, build the shared reporting model and create Power BI reports around the decisions your business needs to make.",
    deliverables: [
      "Reporting requirements tied to business decisions",
      "A semantic model: shared data relationships and measure definitions",
      "Documented calculations and agreed key performance indicators",
      "Power BI report pages with clear navigation and context",
      "Refresh configuration and access arrangements within scope",
      "Report guidance and a handover for the people using it",
    ],
    technologies: ["Power BI", "DAX", "Power Query", "SQL"],
    idealWhen:
      "Your reports take too long to prepare, leave key questions unanswered, or use inconsistent definitions of performance.",
  },
  {
    id: "data-quality-and-analytics-consulting",
    name: "Data Quality and Analytics Consulting",
    short: "Know what your data can tell you, and where it needs work.",
    outcome: "Build confidence before drawing conclusions.",
    description:
      "Unexplained gaps, duplicates and conflicting definitions make even a polished report difficult to trust. We assess the information behind the numbers, agree meaningful checks and help you decide what to address first.",
    deliverables: [
      "A focused assessment of relevant data and reporting issues",
      "Validation rules and a documented record of exceptions",
      "Reconciliation checks for agreed measures and sources",
      "Clear KPI definitions and data ownership responsibilities",
      "Prioritised recommendations and practical analytical guidance",
    ],
    technologies: ["SQL", "Python", "Power BI"],
    idealWhen:
      "The business has data but cannot explain discrepancies, agree on its measures, or decide which improvements matter most.",
  },
] as const satisfies readonly Service[];

export const servicesPage = {
  label: "Services",
  eyebrow: "Our expertise",
  title: "Good decisions start with dependable data.",
  description:
    "From the first source connection to the report on your desk, we design and build the foundations that make business data useful. Azure first. Always shaped around the problem.",
  indexLabel: "Explore our services",
  deliverablesLabel: "What we deliver",
  technologyLabel: "Typical technologies",
  technologyNote:
    "The technology is a design decision. We agree the stack after understanding your data, requirements and operating constraints.",
  idealWhenLabel: "A good fit when",
  serviceCta: "Discuss this service",
  engagement: {
    eyebrow: "How an engagement begins",
    title: "Start with the problem you need to solve.",
    description:
      "An initial consultation gives us a shared view of your goals, current systems and constraints. If there is a suitable piece of work, we prepare a proposal with a defined scope, deliverables and responsibilities. The solution is designed and built as part of that engagement.",
    cta: "Discuss Your Project",
  },
} as const;
