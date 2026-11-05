import { bankflow } from "@/content/bankflow";
import styles from "./bankflow.module.css";

export function BankFlowPreview() {
  return (
    <div className={styles.preview}>
      <div className={styles.previewLabel}>
        <span>{bankflow.name}</span>
        <span>{bankflow.eyebrow}</span>
      </div>
      <svg viewBox="0 0 480 350" role="img" aria-label={bankflow.architecture.alternative}>
        <g fill="none" stroke="#70879d" strokeWidth="1.2">
          <path d="M40 28v34h200v30M120 28v20h120M200 28v34M280 28v20h-40M360 28v34H240M440 28v20h-80" />
          <path d="M240 150v24M240 232v24M240 314v14M354 203h66v48" />
          <path d="M420 270v28" strokeDasharray="3 4" />
          <rect x="126" y="92" width="228" height="58" fill="#101d2d" />
          <rect x="126" y="174" width="228" height="58" fill="#182b3e" stroke="#bed0e0" />
          <rect x="126" y="256" width="228" height="58" fill="#101d2d" />
          {[40, 120, 200, 280, 360, 440].map((x) => (
            <rect key={x} x={x - 4} y="18" width="8" height="8" fill="#aabfd2" stroke="none" />
          ))}
          <rect x="411" y="256" width="18" height="14" fill="#101d2d" />
          <path d="M218 338h44M224 345h32" />
        </g>
        <g
          className={styles.previewSvgLabels}
          fill="#e5edf4"
          fontSize="19"
          fontFamily="var(--font-body), sans-serif"
          textAnchor="middle"
        >
          <text x="240" y="128">
            Bronze · Raw
          </text>
          <text x="240" y="210">
            Silver · Validated
          </text>
          <text x="240" y="292">
            Gold · Analytical
          </text>
        </g>
      </svg>
      <ol className={styles.previewLegend}>
        {bankflow.layers.items.map((layer) => (
          <li key={layer.name}>
            <span>{layer.name}</span>
            <span>{layer.subtitle}</span>
          </li>
        ))}
      </ol>
      <div className={styles.previewFoot}>
        <span>{bankflow.architecture.previewInput}</span>
        <span>{bankflow.architecture.previewOutput}</span>
      </div>
    </div>
  );
}
