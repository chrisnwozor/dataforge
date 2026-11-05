"use client";

import Image from "next/image";
import { ArrowLeft, ArrowRight, Expand, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { bankflow, type BankFlowScreenshot } from "@/content/bankflow";
import { trapDialogFocus, wrapScreenshotIndex } from "./gallery-keyboard";
import styles from "./bankflow.module.css";

export function BankFlowGallery({ screenshots }: { screenshots: readonly BankFlowScreenshot[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const captionId = useId();
  const isOpen = selected !== null;
  const current = selected === null ? null : screenshots[selected];
  const close = useCallback(() => setSelected(null), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [isOpen]);

  function navigate(direction: number) {
    setSelected((index) =>
      index === null ? null : wrapScreenshotIndex(index + direction, screenshots.length),
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      navigate(event.key === "ArrowLeft" ? -1 : 1);
    }
    trapDialogFocus(event, event.currentTarget, document.activeElement);
  }

  if (screenshots.length === 0) {
    if (process.env.NODE_ENV === "production") return null;
    return (
      <div className={styles.developmentFrame}>
        <strong>{bankflow.gallery.developmentLabel}</strong>
        <p>{bankflow.gallery.developmentNote}</p>
      </div>
    );
  }

  return (
    <>
      <div className={styles.galleryGrid}>
        {screenshots.map((screenshot, index) => (
          <figure className={styles.galleryFigure} key={screenshot.src}>
            <button
              className={styles.galleryButton}
              type="button"
              aria-label={`${bankflow.gallery.openLabel}: ${screenshot.caption}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                openerRef.current = event.currentTarget;
                setSelected(index);
              }}
            >
              <Image
                src={screenshot.src}
                alt={screenshot.alt}
                width={screenshot.width}
                height={screenshot.height}
                sizes="(max-width: 767px) 100vw, 50vw"
              />
              <span className={styles.galleryAction}>
                {bankflow.gallery.openLabel}
                <Expand size={16} aria-hidden="true" />
              </span>
            </button>
            <figcaption>{screenshot.caption}</figcaption>
          </figure>
        ))}
      </div>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={captionId}
        onCancel={close}
        onClose={close}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
      >
        <div className={styles.dialogHeader}>
          <span id={titleId}>{bankflow.gallery.viewerLabel}</span>
          <button
            ref={closeRef}
            className={styles.dialogIconButton}
            type="button"
            aria-label={bankflow.gallery.closeLabel}
            onClick={close}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {current && (
          <figure className={styles.dialogFigure}>
            <Image
              className={styles.dialogImage}
              src={current.src}
              alt={current.alt}
              width={current.width}
              height={current.height}
              sizes="100vw"
            />
            <figcaption className={styles.dialogFooter}>
              <p id={captionId} className={styles.dialogCaption} aria-live="polite">
                {current.caption}
                <span className={styles.keyboardHint}>{bankflow.gallery.keyboardHint}</span>
              </p>
              {screenshots.length > 1 && (
                <div className={styles.dialogControls}>
                  <button
                    className={styles.dialogIconButton}
                    type="button"
                    aria-label={bankflow.gallery.previousLabel}
                    onClick={() => navigate(-1)}
                  >
                    <ArrowLeft size={20} aria-hidden="true" />
                  </button>
                  <button
                    className={styles.dialogIconButton}
                    type="button"
                    aria-label={bankflow.gallery.nextLabel}
                    onClick={() => navigate(1)}
                  >
                    <ArrowRight size={20} aria-hidden="true" />
                  </button>
                </div>
              )}
            </figcaption>
          </figure>
        )}
      </dialog>
    </>
  );
}
