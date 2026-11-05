"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shellContent, siteConfig } from "@/content/site";
import { Brand } from "./brand";
import styles from "./shell.module.css";

export function Header() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    const frame = requestAnimationFrame(update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!menuOpen) {
      if (dialog.open) dialog.close();
      return;
    }

    dialog.showModal();
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 1050px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", closeOnDesktop);
      if (dialog.open) dialog.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [menuOpen]);

  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <header className={`${styles.header} ${scrolled ? styles.scrolled : ""}`}>
        <div className={styles.headerInner}>
          <Link href="/" aria-label={shellContent.homeLabel} className={styles.brandLink}>
            <Brand />
          </Link>
          <nav className={styles.desktopNav} aria-label={shellContent.primaryNavigation}>
            {siteConfig.navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.navLink}
                aria-current={active(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <Link href={siteConfig.defaultCTA.href} className={styles.headerCTA}>
            {siteConfig.defaultCTA.label}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <button
            ref={triggerRef}
            type="button"
            className={styles.menuTrigger}
            aria-label={shellContent.openMenu}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={25} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>

      <dialog
        ref={dialogRef}
        id="mobile-navigation"
        className={styles.mobileDialog}
        aria-labelledby="mobile-navigation-title"
        onCancel={closeMenu}
        onClose={closeMenu}
      >
        <div className={styles.mobileInner}>
          <div className={styles.mobileTop}>
            <Link
              href="/"
              aria-label={shellContent.homeLabel}
              className={styles.brandLink}
              onClick={closeMenu}
            >
              <Brand />
            </Link>
            <button
              type="button"
              className={styles.menuClose}
              aria-label={shellContent.closeMenu}
              onClick={closeMenu}
              autoFocus
            >
              <X size={26} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.mobileMenuBody}>
            <p className={styles.menuEyebrow} id="mobile-navigation-title">
              {shellContent.menuEyebrow}
            </p>
            <nav aria-label={shellContent.mobileNavigation} className={styles.mobileNav}>
              {siteConfig.navigation.map((item, index) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active(item.href) ? "page" : undefined}
                  onClick={closeMenu}
                  style={{ animationDelay: `${index * 45}ms` }}
                >
                  <span className={styles.menuNumber} aria-hidden="true">
                    0{index + 1}
                  </span>
                  {item.label}
                  <ArrowUpRight size={24} strokeWidth={1.3} aria-hidden="true" />
                </Link>
              ))}
            </nav>
          </div>
          <div className={styles.mobileBottom}>
            <p>{shellContent.menuNote}</p>
            <Link
              href={siteConfig.defaultCTA.href}
              onClick={closeMenu}
              className={styles.mobileCTA}
            >
              {siteConfig.defaultCTA.label}
              <ArrowUpRight size={20} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </dialog>
    </>
  );
}
