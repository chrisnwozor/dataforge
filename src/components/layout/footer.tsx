import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { shellContent, siteConfig } from "@/content/site";
import { publicContactEmail } from "@/lib/seo-data";
import { Brand } from "./brand";
import styles from "./shell.module.css";

export function Footer() {
  const email = publicContactEmail();
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerMain}>
          <div className={styles.footerBrandBlock}>
            <Link href="/" aria-label={shellContent.homeLabel} className={styles.brandLink}>
              <Brand />
            </Link>
            <p className={styles.footerPromise}>{siteConfig.promise}</p>
            <p className={styles.footerDescriptor}>{shellContent.footerDescriptor}</p>
          </div>
          <div className={styles.footerLinks}>
            <p className={styles.footerLabel}>{shellContent.footerNavigation}</p>
            <nav aria-label={shellContent.footerNavigationLabel}>
              {siteConfig.navigation.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className={styles.footerConversation}>
            <p className={styles.footerLabel}>{shellContent.footerContact}</p>
            <Link href={siteConfig.defaultCTA.href} className={styles.footerCTA}>
              {siteConfig.defaultCTA.label}
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
            {email && (
              <a href={`mailto:${email}`} className={styles.footerEmail}>
                {email}
              </a>
            )}
            {siteConfig.socialLinks.length > 0 && (
              <ul className={styles.socialLinks}>
                {siteConfig.socialLinks.map((link) => (
                  <li key={link.url}>
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.label}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className={styles.footerBottom}>
          <p>
            © {new Date().getFullYear()} {shellContent.copyright}
          </p>
          <span className={styles.footerSignature}>{shellContent.footerEyebrow}</span>
          <Link href="/privacy">{shellContent.privacy}</Link>
        </div>
      </div>
    </footer>
  );
}
