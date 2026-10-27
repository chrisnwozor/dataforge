import Link from "next/link";
import {
  ArrowRight,
  Upload,
  Workflow,
  Terminal,
  FileSpreadsheet,
  Database,
  ChevronRight,
  ShieldCheck,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-tag">
          <span className="status-dot success" />
          YOUR NEXT WAREHOUSE STARTS HERE <ChevronRight size={12} />
        </div>
        <h1>
          Raw data to a warehouse,
          <br />
          <span style={{ color: "var(--muted)" }}>automated.</span>
        </h1>
        <p>
          From scattered spreadsheets to a structured star schema.
          <br />
          Less wrangling. More understanding.
        </p>
        <div className="hero-actions">
          <Link href="/projects" className={buttonVariants()}>
            Open dashboard <ArrowRight size={14} />
          </Link>
          <a
            href="#how-it-works"
            className={buttonVariants({ variant: "outline" })}
          >
            See how it works
          </a>
        </div>
        <div className="hero-note">CSV or Excel in. SQL Server ready.</div>
        <div
          className="hero-preview"
          aria-label="A CSV source transformed into a sales star schema"
        >
          <div className="preview-chrome">
            <i />
            <i />
            <i />
            <span>superstore-sales / model</span>
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span className="status-dot success" /> Model ready
            </span>
          </div>
          <div className="preview-content">
            <div className="preview-file">
              <h2>
                <FileSpreadsheet size={15} /> superstore_sales.csv
              </h2>
              <p>9,994 rows · 21 columns</p>
              {[
                ["Order ID", "VARCHAR"],
                ["Customer Name", "VARCHAR"],
                ["Sales", "DECIMAL"],
                ["Order Date", "DATE"],
              ].map(([k, v]) => (
                <div key={k} className="preview-field mono">
                  <span>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
            <ArrowRight
              size={20}
              className="muted"
              style={{ justifySelf: "center" }}
            />
            <div className="preview-file">
              <h2>
                <Database size={15} /> Your warehouse
              </h2>
              <p>A model built around your data</p>
              {[
                ["fact_sales", "4 measures"],
                ["dim_customer", "3 attributes"],
                ["dim_product", "3 attributes"],
                ["dim_date", "Calendar"],
              ].map(([k, v]) => (
                <div key={k} className="preview-field mono">
                  <span>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section id="how-it-works" className="landing-steps">
        <header>
          <div className="eyebrow">FROM FILE TO FOUNDATION</div>
          <h2>Three steps. A better starting point.</h2>
          <p>You bring the data. DataForge brings the structure.</p>
        </header>
        <div className="steps-grid">
          {[
            {
              n: "01",
              Icon: Upload,
              title: "Upload your source",
              text: "Start with the files you already have. Drop in a CSV or Excel workbook and give your project a home.",
            },
            {
              n: "02",
              Icon: Workflow,
              title: "Make the model yours",
              text: "Review column profiles, find your keys, and shape your fact and dimension tables with a simple drag and drop.",
            },
            {
              n: "03",
              Icon: Terminal,
              title: "Generate. Then go.",
              text: "Get readable, organized SQL Server scripts. Review every statement before taking it to your warehouse.",
            },
          ].map(({ n, Icon, title, text }) => (
            <article className="step-item" key={n}>
              <span>
                {n}
                <Icon size={17} />
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <div className="info-banner">
          <ShieldCheck size={16} />
          <span>
            <strong>Built to be transparent.</strong> This demo uses sample
            data. No files are parsed, and no database is connected.
          </span>
          <Link href="/projects">
            Explore the demo <ArrowRight size={13} />
          </Link>
        </div>
      </section>
    </main>
  );
}
