import type {
  Project,
  ColumnProfile,
  Model,
  Run,
  Activity,
  GeneratedFile,
} from "@/lib/types";
const projects: Project[] = [
  {
    id: "superstore-sales",
    name: "Superstore Sales",
    description: "The big picture, down to every order.",
    sourceName: "superstore_sales.csv",
    sourceType: "CSV",
    status: "Ready",
    lastRun: "2 hours ago",
    rows: 9994,
    columns: 21,
    tables: 5,
    updatedAt: "2 hours ago",
    stage: 4,
    activity: [
      12, 20, 15, 28, 22, 35, 30, 43, 33, 47, 40, 58, 52, 48, 62, 55, 73, 65,
      78, 72, 90, 83, 96, 88,
    ],
  },
  {
    id: "customer-analytics",
    name: "Customer Analytics",
    description: "Understand the people behind the numbers.",
    sourceName: "customers_q4.xlsx",
    sourceType: "XLSX",
    status: "Needs review",
    lastRun: "Yesterday",
    rows: 28450,
    columns: 14,
    tables: 4,
    updatedAt: "4 hours ago",
    stage: 2,
    activity: [
      10, 16, 13, 25, 22, 23, 35, 32, 41, 29, 34, 43, 39, 53, 47, 60, 55, 62,
      57, 68, 63, 72, 68, 81,
    ],
  },
  {
    id: "inventory-warehouse",
    name: "Inventory Warehouse",
    description: "A clearer view of what’s on the shelf.",
    sourceName: "inventory_export.csv",
    sourceType: "CSV",
    status: "Ready",
    lastRun: "Yesterday",
    rows: 15320,
    columns: 18,
    tables: 6,
    updatedAt: "Yesterday",
    stage: 4,
    activity: [
      32, 25, 38, 30, 47, 40, 35, 45, 56, 51, 44, 58, 53, 65, 60, 55, 72, 68,
      61, 75, 69, 82, 77, 89,
    ],
  },
  {
    id: "marketing-performance",
    name: "Marketing Performance",
    description: "Every campaign. One source of truth.",
    sourceName: "campaign_results.csv",
    sourceType: "CSV",
    status: "Draft",
    lastRun: "Not run yet",
    rows: 4200,
    columns: 12,
    tables: 0,
    updatedAt: "2 days ago",
    stage: 1,
    activity: [],
  },
  {
    id: "financial-reporting",
    name: "Financial Reporting",
    description: "From spreadsheets to a single picture.",
    sourceName: "financials_2025.xlsx",
    sourceType: "XLSX",
    status: "Ready",
    lastRun: "3 days ago",
    rows: 12864,
    columns: 16,
    tables: 5,
    updatedAt: "3 days ago",
    stage: 4,
    activity: [
      20, 30, 25, 38, 31, 44, 38, 52, 45, 61, 54, 67, 60, 72, 66, 75, 70, 83,
      77, 88, 83, 94, 90, 100,
    ],
  },
];
export async function getProjects(): Promise<Project[]> {
  return projects;
}
export async function getProject(id: string): Promise<Project | undefined> {
  if (id === "new-project")
    return {
      ...projects[0],
      id,
      name: "Untitled project",
      status: "Draft",
      stage: 1,
      lastRun: "Not run yet",
      updatedAt: "Just now",
    };
  return projects.find((p) => p.id === id);
}
export async function getColumnProfiles(
  _projectId: string,
): Promise<ColumnProfile[]> {
  void _projectId;
  return [
    {
      id: "order-id",
      name: "Order ID",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 5009,
      duplicates: 4985,
      min: "CA-2014-100006",
      max: "US-2017-169551",
      keyCandidate: true,
    },
    {
      id: "order-date",
      name: "Order Date",
      type: "DATE",
      nullPercent: 0,
      distinct: 1237,
      duplicates: 8757,
      min: "2014-01-03",
      max: "2017-12-30",
      keyCandidate: false,
    },
    {
      id: "customer-id",
      name: "Customer ID",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 793,
      duplicates: 9201,
      min: "AA-10315",
      max: "ZD-21925",
      keyCandidate: true,
    },
    {
      id: "customer-name",
      name: "Customer Name",
      type: "VARCHAR",
      nullPercent: 0.2,
      distinct: 793,
      duplicates: 9201,
      min: "Aaron Bergman",
      max: "Zuschuss Donatelli",
      keyCandidate: false,
    },
    {
      id: "segment",
      name: "Segment",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 3,
      duplicates: 9991,
      min: "Consumer",
      max: "Home Office",
      keyCandidate: false,
    },
    {
      id: "region",
      name: "Region",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 4,
      duplicates: 9990,
      min: "Central",
      max: "West",
      keyCandidate: false,
    },
    {
      id: "product-id",
      name: "Product ID",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 1862,
      duplicates: 8132,
      min: "FUR-BO-10000112",
      max: "TEC-PH-10004977",
      keyCandidate: true,
    },
    {
      id: "product",
      name: "Product",
      type: "VARCHAR",
      nullPercent: 0.1,
      distinct: 1850,
      duplicates: 8144,
      min: '"While you Were Out"',
      max: "Zipper Ring Binder",
      keyCandidate: false,
    },
    {
      id: "category",
      name: "Category",
      type: "VARCHAR",
      nullPercent: 0,
      distinct: 3,
      duplicates: 9991,
      min: "Furniture",
      max: "Technology",
      keyCandidate: false,
    },
    {
      id: "sales",
      name: "Sales",
      type: "DECIMAL",
      nullPercent: 0,
      distinct: 5825,
      duplicates: 4169,
      min: "0.44",
      max: "22,638.48",
      keyCandidate: false,
    },
    {
      id: "quantity",
      name: "Quantity",
      type: "INT",
      nullPercent: 0,
      distinct: 14,
      duplicates: 9980,
      min: "1",
      max: "14",
      keyCandidate: false,
    },
    {
      id: "discount",
      name: "Discount",
      type: "DECIMAL",
      nullPercent: 1.4,
      distinct: 12,
      duplicates: 9982,
      min: "0.00",
      max: "0.80",
      keyCandidate: false,
    },
    {
      id: "profit",
      name: "Profit",
      type: "DECIMAL",
      nullPercent: 0,
      distinct: 7287,
      duplicates: 2707,
      min: "-6,599.98",
      max: "8,399.98",
      keyCandidate: false,
    },
  ];
}
export async function getSuggestedModel(_projectId: string): Promise<Model> {
  void _projectId;
  return {
    fact: {
      name: "fact_sales",
      grain: "One row per order line",
      columnIds: ["order-id", "sales", "quantity", "discount", "profit"],
    },
    dimensions: [
      {
        id: "customer",
        name: "dim_customer",
        columnIds: ["customer-id", "customer-name", "segment"],
        businessKey: "customer-id",
      },
      {
        id: "product",
        name: "dim_product",
        columnIds: ["product-id", "product", "category"],
        businessKey: "product-id",
      },
      {
        id: "region",
        name: "dim_region",
        columnIds: ["region"],
        businessKey: "region",
      },
      {
        id: "date",
        name: "dim_date",
        columnIds: ["order-date"],
        businessKey: "order-date",
      },
    ],
    unassigned: [],
  };
}
export async function getInitialModel(_projectId: string): Promise<Model> {
  void _projectId;
  return {
    fact: {
      name: "fact_sales",
      grain: "One row per order line",
      columnIds: ["sales", "quantity", "discount", "profit"],
    },
    dimensions: [
      {
        id: "customer",
        name: "dim_customer",
        columnIds: ["customer-id", "customer-name", "segment"],
        businessKey: "customer-id",
      },
      {
        id: "product",
        name: "dim_product",
        columnIds: ["product-id", "product", "category"],
        businessKey: "product-id",
      },
    ],
    unassigned: ["order-id", "order-date", "region"],
  };
}
export async function getActivity(_projectId: string): Promise<Activity[]> {
  void _projectId;
  return [
    {
      title: "Load completed successfully",
      description: "9,994 rows loaded into 5 warehouse tables.",
      time: "2h ago",
      kind: "run",
    },
    {
      title: "Star schema generated",
      description: "1 fact table and 4 dimensions are ready.",
      time: "2h ago",
      kind: "model",
    },
    {
      title: "Data profile completed",
      description: "21 columns analyzed. 3 key candidates found.",
      time: "3h ago",
      kind: "profile",
    },
    {
      title: "Source file uploaded",
      description: "superstore_sales.csv · 2.3 MB",
      time: "3h ago",
      kind: "upload",
    },
  ];
}
export async function getRuns(_projectId: string): Promise<Run[]> {
  void _projectId;
  return [
    {
      id: "run_8f3a2c",
      status: "Success",
      started: "Oct 27, 2026 · 10:42 AM",
      duration: "12.4s",
      rowsLoaded: 9994,
      rowsRejected: 0,
    },
    {
      id: "run_7e2b1d",
      status: "Success",
      started: "Oct 26, 2026 · 09:15 AM",
      duration: "11.8s",
      rowsLoaded: 9991,
      rowsRejected: 3,
    },
    {
      id: "run_6d1a9e",
      status: "Failed",
      started: "Oct 25, 2026 · 04:32 PM",
      duration: "3.2s",
      rowsLoaded: 0,
      rowsRejected: 18,
    },
    {
      id: "run_5c0f8a",
      status: "Success",
      started: "Oct 24, 2026 · 11:06 AM",
      duration: "12.1s",
      rowsLoaded: 9994,
      rowsRejected: 0,
    },
  ].map((r) => ({
    ...r,
    status: r.status as Run["status"],
    logs: [
      {
        time: "10:42:00",
        level: "INFO",
        message: "Initializing simulated SQL Server load…",
      },
      {
        time: "10:42:01",
        level: "INFO",
        message: "Staging 9,994 rows from superstore_sales.csv",
      },
      {
        time: "10:42:02",
        level: "INFO",
        message: "Resolving dimension surrogate keys",
      },
      {
        time: "10:42:03",
        level: r.status === "Failed" ? "ERROR" : "INFO",
        message:
          r.status === "Failed"
            ? "Validation failed: invalid Order Date values"
            : "Loading fact_sales and 4 dimension tables",
      },
      {
        time: "10:42:12",
        level: r.status === "Failed" ? "ERROR" : "SUCCESS",
        message:
          r.status === "Failed"
            ? "Transaction rolled back. No rows loaded."
            : `Load complete. ${r.rowsLoaded.toLocaleString("en-US")} rows loaded.`,
      },
    ],
    rejected: r.rowsRejected
      ? [
          {
            row: 128,
            column: "Order Date",
            value: "32/01/2025",
            reason: "Invalid date",
          },
          {
            row: 241,
            column: "Sales",
            value: "N/A",
            reason: "Expected decimal",
          },
          {
            row: 602,
            column: "Customer ID",
            value: "",
            reason: "Business key is missing",
          },
        ]
      : [],
  }));
}
export async function getGeneratedFiles(
  _projectId: string,
): Promise<GeneratedFile[]> {
  void _projectId;
  return [
    {
      name: "01_staging.sql",
      content: `-- DataForge · Superstore Sales\n-- SQL Server · staging layer\n-- Preview only — no database connection is made.\n\nCREATE SCHEMA staging;\nGO\n\nCREATE TABLE staging.superstore_sales (\n    order_id        VARCHAR(50)    NOT NULL,\n    order_date      DATE           NOT NULL,\n    customer_id     VARCHAR(20)    NOT NULL,\n    customer_name   VARCHAR(100)   NULL,\n    segment         VARCHAR(50)    NULL,\n    region          VARCHAR(50)    NULL,\n    product_id      VARCHAR(50)    NOT NULL,\n    product_name    VARCHAR(255)   NULL,\n    category        VARCHAR(50)    NULL,\n    sales           DECIMAL(18, 2) NOT NULL,\n    quantity        INT            NOT NULL,\n    discount        DECIMAL(5, 2)  NULL,\n    profit          DECIMAL(18, 2) NULL,\n    loaded_at       DATETIME2      DEFAULT SYSUTCDATETIME()\n);\nGO`,
    },
    {
      name: "02_dimensions.sql",
      content: `-- Dimension tables · surrogate keys\nCREATE SCHEMA warehouse;\nGO\n\nCREATE TABLE warehouse.dim_customer (\n    customer_key   INT IDENTITY(1,1) PRIMARY KEY,\n    customer_id    VARCHAR(20) NOT NULL UNIQUE,\n    customer_name  VARCHAR(100),\n    segment        VARCHAR(50)\n);\n\nCREATE TABLE warehouse.dim_product (\n    product_key   INT IDENTITY(1,1) PRIMARY KEY,\n    product_id    VARCHAR(50) NOT NULL UNIQUE,\n    product_name  VARCHAR(255),\n    category      VARCHAR(50)\n);\n\nCREATE TABLE warehouse.dim_region (\n    region_key INT IDENTITY(1,1) PRIMARY KEY,\n    region     VARCHAR(50) NOT NULL UNIQUE\n);\nGO`,
    },
    {
      name: "03_fact.sql",
      content: `-- Sales fact · grain: one row per order line\nCREATE TABLE warehouse.fact_sales (\n    sales_key     BIGINT IDENTITY(1,1) PRIMARY KEY,\n    order_id      VARCHAR(50) NOT NULL,\n    customer_key  INT REFERENCES warehouse.dim_customer,\n    product_key   INT REFERENCES warehouse.dim_product,\n    region_key    INT REFERENCES warehouse.dim_region,\n    date_key      INT REFERENCES warehouse.dim_date,\n    sales         DECIMAL(18,2) NOT NULL,\n    quantity      INT NOT NULL,\n    discount      DECIMAL(5,2),\n    profit        DECIMAL(18,2)\n);\nGO`,
    },
    {
      name: "04_dim_date.sql",
      content: `-- Calendar dimension · 2014–2030\nCREATE TABLE warehouse.dim_date (\n    date_key      INT PRIMARY KEY,\n    full_date     DATE NOT NULL UNIQUE,\n    day_of_month  INT NOT NULL,\n    month_number  INT NOT NULL,\n    month_name    VARCHAR(12) NOT NULL,\n    quarter       INT NOT NULL,\n    year          INT NOT NULL\n);\nGO\n\n-- Populate with your calendar generator before loading facts.\n-- Example row:\nINSERT INTO warehouse.dim_date\nVALUES (20140103, '2014-01-03', 3, 1, 'January', 1, 2014);\nGO`,
    },
  ];
}
