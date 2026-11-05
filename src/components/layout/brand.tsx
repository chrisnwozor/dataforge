import { siteConfig } from "@/content/site";
import styles from "./shell.module.css";

export function Monogram({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 6h7c6.1 0 10 3.7 10 10s-3.9 10-10 10H5V6Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M15 26V6h12M15 16h9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`${styles.brand} ${compact ? styles.brandCompact : ""}`}>
      <Monogram className={styles.monogram} />
      <span>{siteConfig.name}</span>
    </span>
  );
}
