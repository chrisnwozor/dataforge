"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExploreChart } from "@/components/charts";
import { formatMeasure } from "@/lib/explore/format";
import type { PaginatedReport, ReportElement, ReportPage } from "@/lib/reports/pagination";
import styles from "./reports.module.css";

function PageElement({ element }: { element: ReportElement }) {
  const placement = { left: element.x, top: element.y, width: element.width, height: element.height };
  if (element.kind === "chart") return <div className={styles.previewChart} style={placement}><ExploreChart title={element.title} kind={element.viz} data={element.data} series={element.series.map((series) => ({ ...series, format: (value) => formatMeasure(value, series.format) }))} fitToContainer showLegend /></div>;
  if (element.kind === "text") return <div className={styles.pageText} style={{ ...placement, fontSize: element.fontSize, fontWeight: element.bold ? 600 : 400, color: element.color, textAlign: element.align }}>{element.text}</div>;
  return <div className={`${styles.pageRow} ${element.kind === "tableHeader" ? styles.pageHeaderRow : element.rowKind !== "detail" ? styles.pageTotalRow : ""}`} style={placement} role="group" aria-label={`${element.kind === "tableHeader" ? "Columns" : element.rowKind === "detail" ? "Row" : "Total"}: ${element.cells.map((cell) => cell.text).join(", ")}`}>{element.cells.map((cell, index) => <span key={index} style={{ width: cell.width, textAlign: cell.align, color: cell.color, fontWeight: cell.bold ? 600 : undefined }} title={cell.text}>{cell.text}</span>)}</div>;
}

function LazyPage({ page, report, zoom, first }: { page: ReportPage; report: PaginatedReport; zoom: number; first: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(first);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "350px 0px" });
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  return <div ref={ref} id={`report-preview-page-${page.number}`} className={styles.pageSlot} style={{ width: report.width * zoom, height: report.height * zoom }} aria-label={`Page ${page.number} of ${report.pages.length}`}>
    {visible ? <div className={styles.paper} style={{ width: report.width, height: report.height, transform: `scale(${zoom})` }}>{page.elements.map((element, index) => <PageElement key={index} element={element} />)}</div> : <div className={styles.pagePlaceholder}>Page {page.number}</div>}
  </div>;
}

export function ReportPreview({ report }: { report: PaginatedReport | null }) {
  const [zoom, setZoom] = useState(0.85);
  const [page, setPage] = useState(1);
  const navigate = (next: number) => {
    const bounded = Math.max(1, Math.min(report?.pages.length ?? 1, next));
    setPage(bounded); document.getElementById(`report-preview-page-${bounded}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  if (!report) return <div className={styles.empty}><h2>Your report, page by page</h2><p>Choose parameter values and run the report to preview the same pages used for PDF export.</p></div>;
  return <section aria-label="Paginated report preview" className={styles.preview}>
    <div className={styles.previewToolbar}><span>{report.rowCount.toLocaleString()} rows · {report.pages.length.toLocaleString()} pages</span><div className={styles.actions}><Button size="icon" variant="ghost" aria-label="Previous report page" disabled={page <= 1} onClick={() => navigate(page - 1)}><ChevronLeft size={14} aria-hidden="true" /></Button><label>Page <input aria-label="Report page" type="number" min={1} max={report.pages.length} value={Math.min(page, report.pages.length)} onChange={(event) => navigate(Number(event.target.value))} /> of {report.pages.length}</label><Button size="icon" variant="ghost" aria-label="Next report page" disabled={page >= report.pages.length} onClick={() => navigate(page + 1)}><ChevronRight size={14} aria-hidden="true" /></Button><Button size="icon" variant="ghost" aria-label="Zoom out report" disabled={zoom <= 0.4} onClick={() => setZoom((value) => Math.max(0.4, value - 0.1))}><ZoomOut size={14} aria-hidden="true" /></Button><span>{Math.round(zoom * 100)}%</span><Button size="icon" variant="ghost" aria-label="Zoom in report" disabled={zoom >= 1.5} onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}><ZoomIn size={14} aria-hidden="true" /></Button></div></div>
    {report.warnings.map((warning, index) => <p className={styles.note} key={index} role="status">{warning}</p>)}
    <div className={styles.pages} tabIndex={0} role="region" aria-label="Report pages">{report.pages.map((entry, index) => <LazyPage key={`${report.runAt}:${entry.number}`} page={entry} report={report} zoom={zoom} first={index === 0} />)}</div>
  </section>;
}
