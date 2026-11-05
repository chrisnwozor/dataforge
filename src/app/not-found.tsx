import Link from "next/link";
import { fallbackContent } from "@/content/site";
import { pageMetadata } from "@/lib/seo";
import styles from "@/components/layout/shell.module.css";

const content = fallbackContent.notFound;

export const metadata = {
  ...pageMetadata(content.metadataTitle, content.metadataDescription, "/"),
  alternates: { canonical: null },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <section className={styles.fallback}>
      <p className={styles.fallbackEyebrow}>{content.eyebrow}</p>
      <h1>{content.title}</h1>
      <p className={styles.fallbackDescription}>{content.description}</p>
      <div className={styles.fallbackActions}>
        <Link href="/" className={styles.fallbackButton}>
          {content.home}
        </Link>
        <Link href="/services" className={styles.fallbackLink}>
          {content.services}
        </Link>
      </div>
    </section>
  );
}
