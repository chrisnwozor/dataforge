"use client";

import Link from "next/link";
import { fallbackContent } from "@/content/site";
import styles from "@/components/layout/shell.module.css";

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  const content = fallbackContent.error;
  return (
    <section className={styles.fallback}>
      <p className={styles.fallbackEyebrow}>{content.eyebrow}</p>
      <h1>{content.title}</h1>
      <p className={styles.fallbackDescription}>{content.description}</p>
      <div className={styles.fallbackActions}>
        <button type="button" onClick={retry} className={styles.fallbackButton}>
          {content.retry}
        </button>
        <Link href="/" className={styles.fallbackLink}>
          {content.home}
        </Link>
      </div>
    </section>
  );
}
