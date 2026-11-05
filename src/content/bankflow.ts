export type BankFlowScreenshot = {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
};

export type ArchitectureStageId =
  "source" | "orchestration" | "bronze" | "silver" | "quarantine" | "gold" | "reporting";

export type ArchitectureStage = {
  id: ArchitectureStageId;
  label: string;
  detail: string;
  description: string;
};

export const architectureStages: readonly ArchitectureStage[] = [
  {
    id: "source",
    label: "Source transactions",
    detail: "Sample banking data",
    description:
      "The project begins with sample banking transaction records. The sample is a demonstration dataset, not live client data.",
  },
  {
    id: "orchestration",
    label: "Azure Data Factory",
    detail: "Orchestration",
    description:
      "Azure Data Factory coordinates the pipeline: the movement of source data through the storage and preparation stages.",
  },
  {
    id: "bronze",
    label: "Bronze",
    detail: "Raw source data",
    description:
      "The Bronze layer holds the raw source data in Azure Data Lake Storage Gen2, preserving a starting point for the preparation process.",
  },
  {
    id: "silver",
    label: "Silver",
    detail: "Cleaned and validated",
    description:
      "The Silver layer applies cleaning, validation and duplicate detection. Validated records can continue toward the analytical model.",
  },
  {
    id: "quarantine",
    label: "Quarantine",
    detail: "Failed validation",
    description:
      "Records that fail validation are isolated for review. Keeping them outside the reporting path makes the quality boundary explicit.",
  },
  {
    id: "gold",
    label: "Gold",
    detail: "Facts and dimensions",
    description:
      "Seven Gold analytical tables organize the prepared data using fact and dimension modelling, giving reporting a structured foundation.",
  },
  {
    id: "reporting",
    label: "Power BI",
    detail: "Reporting integration",
    description:
      "Power BI connects to the analytical model for reporting. This demonstrates the connection between data engineering and business intelligence.",
  },
];

export const bankflow = {
  name: "BankFlow",
  pageTitle: "BankFlow — Azure data engineering demonstration",
  eyebrow: "Demonstration project",
  technologiesLabel: "Project technologies",
  metricsLabel: "Verified project figures",
  demonstrationLabel: "A personal demonstration project built on sample banking transaction data.",
  summary:
    "From raw transactions to a structured reporting model, with a clear quality boundary at every stage.",
  description:
    "An Azure data engineering demonstration combining orchestration, layered storage, data quality and Power BI reporting integration.",
  tags: ["Azure Data Factory", "ADLS Gen2", "Medallion Architecture", "Power BI"],
  metrics: [
    { id: "source", value: 385, label: "Source records" },
    { id: "validated", value: 378, label: "Validated records" },
    { id: "quarantined", value: 7, label: "Quarantined records" },
    { id: "goldTables", value: 7, label: "Gold analytical tables" },
  ],
  metricsNote:
    "The 385 source records reconcile to 378 validated records and 7 quarantined records. Quarantine isolates invalid or suspect records from the reporting path.",
  challenge: {
    eyebrow: "The scenario",
    title: "Before a report can be useful, its data needs to be understood.",
    paragraphs: [
      "Banking transaction data provides a useful setting for demonstrating a common data problem: raw records need preparation before they can support reporting.",
      "BankFlow explores that preparation end to end. It shows how to retain source data, clean and validate records, separate records that need review, and organize the accepted data for analysis.",
    ],
  },
  architecture: {
    eyebrow: "Solution architecture",
    title: "A traceable path from source to report.",
    introduction:
      "Azure Data Factory orchestrates the flow. Azure Data Lake Storage Gen2 holds the Bronze, Silver and Gold layers: raw data, prepared data and reporting data, respectively.",
    interactionHint: "Select a stage, or use the keyboard, to explore its role.",
    alternative:
      "Sample source transactions flow through Azure Data Factory orchestration into Azure Data Lake Storage Gen2. Bronze retains raw data. Silver cleans and validates it and detects duplicates. Failed records branch into quarantine. Validated data continues to seven Gold analytical tables modelled as facts and dimensions, with Power BI reporting integration.",
    storageLabel: "Azure Data Lake Storage Gen2",
    storageDetail: "Medallion layers",
    captionLabel: "Inside the pipeline",
    accessibleName: "BankFlow solution architecture",
    readAlternative: "Read the complete architecture",
    labels: {
      sourceLines: ["Source", "transactions"],
      source: "Source transactions",
      sample: "Sample data",
      sampleBanking: "Sample banking data",
      factoryLines: ["Azure", "Data Factory"],
      factory: "Azure Data Factory",
      orchestration: "Orchestration",
      storageLines: ["Azure Data Lake", "Storage Gen2"],
      bronze: "Bronze",
      raw: "Raw",
      rawSource: "Raw source data",
      sourceRecords: "Source records",
      silver: "Silver",
      prepared: "Prepared",
      silverLines: ["Clean · Validate", "Detect duplicates"],
      silverMobileLines: ["Cleaning · Validation", "Duplicate detection"],
      quarantine: "Quarantine",
      failed: "Failed validation",
      failedLines: ["Failed", "validation"],
      gold: "Gold",
      analytical: "Analytical",
      factsDimensions: "Facts · Dimensions",
      factsDimensionLines: ["Facts and", "dimensions"],
      reporting: "Power BI",
      reportingDetail: "Reporting",
      reportingIntegration: "Reporting integration",
    },
    previewLabels: ["Bronze · Raw", "Silver · Validated", "Gold · Analytical"],
    previewInput: "Azure Data Factory → ADLS Gen2",
    previewOutput: "→ Power BI",
  },
  layers: {
    eyebrow: "The medallion pattern",
    title: "Different layers. A clear purpose for each.",
    introduction:
      "Medallion architecture separates data by how ready it is to use. The Bronze, Silver and Gold names describe those stages, not different products.",
    items: [
      {
        name: "Bronze",
        subtitle: "Keep the source",
        description:
          "Raw source records land in storage. Retaining this starting point keeps the original input separate from later preparation.",
      },
      {
        name: "Silver",
        subtitle: "Prepare and check",
        description:
          "Cleaning, validation and duplicate detection prepare records for analysis. Records that fail validation take a separate quarantine path.",
      },
      {
        name: "Gold",
        subtitle: "Organize for analysis",
        description:
          "Seven analytical tables use fact and dimension modelling to give reporting an organized data structure.",
      },
    ],
  },
  quality: {
    eyebrow: "Data quality",
    title: "Make the boundary of trust visible.",
    introduction:
      "A quality process needs to explain which records can proceed and which need attention. BankFlow demonstrates that distinction explicitly.",
    items: [
      {
        title: "Cleaning",
        description: "Prepare the raw data before it enters the analytical model.",
      },
      {
        title: "Validation",
        description:
          "Check records against the pipeline’s quality requirements before accepting them for reporting.",
      },
      {
        title: "Duplicate detection",
        description: "Identify repeated records as part of the preparation process.",
      },
      {
        title: "Quarantine",
        description:
          "Isolate records that fail validation so they can be reviewed separately from the validated dataset.",
      },
    ],
    note: "The sample contains 7 quarantined records. Their individual failure reasons are not presented here.",
  },
  model: {
    eyebrow: "Dimensional modelling",
    title: "Give transactions a reporting context.",
    description:
      "A fact and dimension model separates the events being analyzed from the context used to understand them. BankFlow applies this approach across seven Gold analytical tables.",
    facts: {
      title: "Facts",
      description:
        "The events or measurements a report examines. In this project, the analytical subject is banking transactions.",
    },
    dimensions: {
      title: "Dimensions",
      description:
        "The descriptive context that helps people group, filter and interpret those facts.",
    },
  },
  reporting: {
    eyebrow: "Power BI integration",
    title: "Bring the prepared model into the reporting layer.",
    description:
      "Power BI reporting integration connects the analytical tables to business intelligence. The project demonstrates the engineering foundation behind a report: prepared records, a quality boundary and a structured model.",
  },
  gallery: {
    eyebrow: "Project views",
    title: "A closer look at the implementation.",
    description:
      "Project screenshots document the implementation. Open an image to inspect it at full size.",
    developmentLabel: "Screenshot to be added",
    developmentNote:
      "Development preview only. This illustrative frame is not a project screenshot.",
    openLabel: "Open full-size image",
    closeLabel: "Close image viewer",
    previousLabel: "Previous image",
    nextLabel: "Next image",
    viewerLabel: "BankFlow project screenshot viewer",
    keyboardHint: "Use the left and right arrow keys to change images. Press Escape to close.",
  },
  demonstrates: {
    eyebrow: "What this demonstrates",
    title: "The connections matter as much as the components.",
    items: [
      "Orchestrating data movement with Azure Data Factory.",
      "Structuring a data lake using Bronze, Silver and Gold layers.",
      "Applying cleaning, validation, duplicate detection and quarantine handling.",
      "Designing an analytical model with facts and dimensions.",
      "Connecting prepared data to Power BI reporting.",
    ],
    limitation:
      "BankFlow is a personal demonstration using sample data. It is not a client engagement, a live banking system or evidence of client business results.",
  },
  cta: {
    title: "Discuss a similar project.",
    description:
      "Tell us about your data sources, your reporting needs and what gets in the way today.",
    label: "Discuss your project",
    href: "/contact?service=Cloud%20Data%20Engineering",
  },
} as const;

// Owner content hook: add the exact seven Gold table names only after verifying
// them against the real project. No table names are inferred by the website.
export const goldTableNames: readonly string[] = [];

// Add genuine project images under public/case-studies/bankflow/, then register
// their public paths, accurate alt text, captions and intrinsic dimensions here.
// Empty galleries are hidden in production; development shows a labelled frame.
export const screenshots: readonly BankFlowScreenshot[] = [];
