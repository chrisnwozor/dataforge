"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { architectureStages, bankflow, type ArchitectureStageId } from "@/content/bankflow";
import { BankFlowPreview } from "./BankFlowPreview";
import styles from "./bankflow.module.css";

type StageProps = {
  id: ArchitectureStageId;
  x: number;
  y: number;
  width: number;
  height: number;
  active: ArchitectureStageId;
  select: (id: ArchitectureStageId) => void;
  children: ReactNode;
};

function Stage({ id, x, y, width, height, active, select, children }: StageProps) {
  const stage = architectureStages.find((item) => item.id === id)!;
  function onKeyDown(event: KeyboardEvent<SVGGElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id);
    }
  }
  return (
    <g
      className={styles.stage}
      role="button"
      tabIndex={0}
      aria-label={`${stage.label}: ${stage.detail}`}
      aria-pressed={active === id}
      data-active={active === id}
      onMouseEnter={() => select(id)}
      onFocus={() => select(id)}
      onClick={() => select(id)}
      onKeyDown={onKeyDown}
    >
      <rect x={x} y={y} width={width} height={height} />
      {children}
    </g>
  );
}

export function BankFlowArchitecture({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<ArchitectureStageId>("silver");
  const instance = useId().replaceAll(":", "");
  const arrowId = `pipeline-arrow-${instance}`;
  const captionId = `pipeline-caption-${instance}`;
  const selected = architectureStages.find((stage) => stage.id === active)!;
  const shared = { active, select: setActive };
  const labels = bankflow.architecture.labels;

  if (compact) return <BankFlowPreview />;

  return (
    <figure className={styles.architecture}>
      <div className={styles.diagramTopline}>{bankflow.architecture.interactionHint}</div>
      <div className={styles.diagramCanvas}>
        <svg
          className={`${styles.diagram} ${styles.diagramDesktop}`}
          viewBox="0 0 1160 430"
          role="group"
          aria-label={bankflow.architecture.accessibleName}
          aria-describedby={captionId}
        >
          <defs>
            <marker id={arrowId} markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
              <path d="M0 0 6 3 0 6" fill="none" stroke="#8fa6bc" strokeWidth="1" />
            </marker>
            <pattern
              id={`pipeline-grid-${instance}`}
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="1" cy="1" r="0.7" fill="#42546a" opacity="0.5" />
            </pattern>
          </defs>
          <rect width="1160" height="430" fill={`url(#pipeline-grid-${instance})`} />
          <rect x="354" y="52" width="620" height="348" fill="#0b1421" stroke="#42546a" />
          <text x="378" y="83" className={styles.stageLabel}>
            {bankflow.architecture.storageLabel}
          </text>
          <text x="378" y="108" className={styles.stageCode}>
            {bankflow.architecture.storageDetail}
          </text>
          <g className={styles.connector} markerEnd={`url(#${arrowId})`}>
            <path d="M145 212h34" />
            <path d="M326 212h50" />
            <path d="M534 212h31" />
            <path d="M735 212h31" />
            <path d="M952 212h42" />
            <path d="M650 267v46" className={styles.branch} />
          </g>
          <Stage id="source" x={14} y={157} width={131} height={110} {...shared}>
            <text x="79" y="192" className={styles.stageLabel} textAnchor="middle">
              <tspan x="79">{labels.sourceLines[0]}</tspan>
              <tspan x="79" dy="23">
                {labels.sourceLines[1]}
              </tspan>
            </text>
            <text x="79" y="244" className={styles.stageDetail} textAnchor="middle">
              {labels.sample}
            </text>
          </Stage>
          <Stage id="orchestration" x={180} y={157} width={146} height={110} {...shared}>
            <text x="253" y="192" className={styles.stageLabel} textAnchor="middle">
              <tspan x="253">{labels.factoryLines[0]}</tspan>
              <tspan x="253" dy="23">
                {labels.factoryLines[1]}
              </tspan>
            </text>
            <text x="253" y="244" className={styles.stageDetail} textAnchor="middle">
              {labels.orchestration}
            </text>
          </Stage>
          <Stage id="bronze" x={378} y={157} width={156} height={110} {...shared}>
            <text x="400" y="186" className={styles.stageCode}>
              {labels.raw}
            </text>
            <text x="400" y="218" className={styles.stageLabel}>
              {labels.bronze}
            </text>
            <text x="400" y="244" className={styles.stageDetail}>
              {labels.sourceRecords}
            </text>
          </Stage>
          <Stage id="silver" x={565} y={157} width={170} height={110} {...shared}>
            <text x="585" y="186" className={styles.stageCode}>
              {labels.prepared}
            </text>
            <text x="585" y="218" className={styles.stageLabel}>
              {labels.silver}
            </text>
            <text x="585" y="243" className={styles.stageDetail}>
              {labels.silverLines[0]}
            </text>
            <text x="585" y="258" className={styles.stageDetail}>
              {labels.silverLines[1]}
            </text>
          </Stage>
          <Stage id="quarantine" x={565} y={315} width={170} height={66} {...shared}>
            <text x="585" y="342" className={styles.stageLabel}>
              {labels.quarantine}
            </text>
            <text x="585" y="365" className={styles.stageDetail}>
              {labels.failed}
            </text>
          </Stage>
          <Stage id="gold" x={767} y={157} width={185} height={110} {...shared}>
            <text x="787" y="186" className={styles.stageCode}>
              {labels.analytical}
            </text>
            <text x="787" y="218" className={styles.stageLabel}>
              {labels.gold}
            </text>
            <text x="787" y="243" className={styles.stageDetail}>
              {labels.factsDimensions}
            </text>
          </Stage>
          <Stage id="reporting" x={996} y={157} width={150} height={110} {...shared}>
            <text x="1071" y="205" className={styles.stageLabel} textAnchor="middle">
              {labels.reporting}
            </text>
            <text x="1071" y="234" className={styles.stageDetail} textAnchor="middle">
              {labels.reportingDetail}
            </text>
          </Stage>
        </svg>
        <svg
          className={`${styles.diagram} ${styles.diagramMobile}`}
          viewBox="0 0 340 990"
          role="group"
          aria-label={bankflow.architecture.accessibleName}
          aria-describedby={captionId}
        >
          <defs>
            <marker
              id={`${arrowId}-mobile`}
              markerWidth="7"
              markerHeight="7"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0 0 6 3 0 6" fill="none" stroke="#8fa6bc" strokeWidth="1" />
            </marker>
          </defs>
          <rect x="12" y="278" width="316" height="536" fill="#0b1421" stroke="#42546a" />
          <text x="30" y="309" className={styles.stageLabel}>
            <tspan x="30">{labels.storageLines[0]}</tspan>
            <tspan x="30" dy="23">
              {labels.storageLines[1]}
            </tspan>
          </text>
          <g className={styles.connector} markerEnd={`url(#${arrowId}-mobile)`}>
            <path d="M170 124v34" />
            <path d="M170 250v105" />
            <path d="M170 443v36" />
            <path d="M170 595v24h73v34" />
            <path d="M170 595v24H92v34" className={styles.branch} />
            <path d="M243 784v56H170v33" />
          </g>
          <Stage id="source" x={30} y={30} width={280} height={94} {...shared}>
            <text x="50" y="68" className={styles.stageLabel}>
              {labels.source}
            </text>
            <text x="50" y="96" className={styles.stageDetail}>
              {labels.sampleBanking}
            </text>
          </Stage>
          <Stage id="orchestration" x={30} y={160} width={280} height={90} {...shared}>
            <text x="50" y="198" className={styles.stageLabel}>
              {labels.factory}
            </text>
            <text x="50" y="226" className={styles.stageDetail}>
              {labels.orchestration}
            </text>
          </Stage>
          <Stage id="bronze" x={30} y={357} width={280} height={86} {...shared}>
            <text x="50" y="394" className={styles.stageLabel}>
              {labels.bronze}
            </text>
            <text x="50" y="420" className={styles.stageDetail}>
              {labels.rawSource}
            </text>
          </Stage>
          <Stage id="silver" x={30} y={481} width={280} height={114} {...shared}>
            <text x="50" y="516" className={styles.stageLabel}>
              {labels.silver}
            </text>
            <text x="50" y="542" className={styles.stageDetail}>
              {labels.silverMobileLines[0]}
            </text>
            <text x="50" y="567" className={styles.stageDetail}>
              {labels.silverMobileLines[1]}
            </text>
          </Stage>
          <Stage id="quarantine" x={30} y={655} width={128} height={129} {...shared}>
            <text x="45" y="689" className={styles.stageLabel}>
              {labels.quarantine}
            </text>
            <text x="45" y="721" className={styles.stageDetail}>
              <tspan x="45">{labels.failedLines[0]}</tspan>
              <tspan x="45" dy="22">
                {labels.failedLines[1]}
              </tspan>
            </text>
          </Stage>
          <Stage id="gold" x={178} y={655} width={132} height={129} {...shared}>
            <text x="195" y="689" className={styles.stageLabel}>
              {labels.gold}
            </text>
            <text x="195" y="721" className={styles.stageDetail}>
              <tspan x="195">{labels.factsDimensionLines[0]}</tspan>
              <tspan x="195" dy="22">
                {labels.factsDimensionLines[1]}
              </tspan>
            </text>
          </Stage>
          <Stage id="reporting" x={30} y={875} width={280} height={90} {...shared}>
            <text x="50" y="913" className={styles.stageLabel}>
              {labels.reporting}
            </text>
            <text x="50" y="941" className={styles.stageDetail}>
              {labels.reportingIntegration}
            </text>
          </Stage>
        </svg>
      </div>
      <figcaption id={captionId}>
        <div className={styles.stageCaption}>
          <div>
            <span className={styles.micro}>{bankflow.architecture.captionLabel}</span>
            <h3>{selected.label}</h3>
          </div>
          <p aria-live="polite" aria-atomic="true">
            {selected.description}
          </p>
        </div>
        <details className={styles.diagramAlternative}>
          <summary>{bankflow.architecture.readAlternative}</summary>
          <p>{bankflow.architecture.alternative}</p>
          <ol>
            {architectureStages.map((stage) => (
              <li key={stage.id}>
                <strong>{stage.label}.</strong> {stage.description}
              </li>
            ))}
          </ol>
        </details>
      </figcaption>
    </figure>
  );
}

export default BankFlowArchitecture;
