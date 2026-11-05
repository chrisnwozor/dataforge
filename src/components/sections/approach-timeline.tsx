"use client";

import { useEffect, useRef } from "react";
import { approachStages, approachPage } from "@/content/approach";
import styles from "./approach-timeline.module.css";

export function ApproachTimeline() {
  const timeline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = timeline.current;
    if (!element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    function update() {
      frame = 0;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const progress = preference.matches
        ? 1
        : Math.min(1, Math.max(0, (window.innerHeight * 0.72 - bounds.top) / bounds.height));
      element.style.setProperty("--timeline-progress", String(progress));
    }

    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    preference.addEventListener("change", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      preference.removeEventListener("change", schedule);
    };
  }, []);

  return (
    <div ref={timeline} className={styles.timeline}>
      <div className={styles.rail} aria-hidden="true">
        <svg width="24" height="1000" viewBox="0 0 24 1000" preserveAspectRatio="none" fill="none">
          <path d="M12 0v1000" className={styles.track} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className={styles.progress} />
      </div>
      <ol className={styles.stages} aria-label={approachPage.timelineLabel}>
        {approachStages.map((stage, index) => (
          <li className={styles.stage} key={stage.id} id={stage.id}>
            <span className={styles.marker} aria-hidden="true" />
            <div className={styles.stageHeading}>
              <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
              <h2>{stage.name}</h2>
            </div>
            <p className={styles.purpose}>{stage.purpose}</p>
            <dl className={styles.details}>
              <div>
                <dt>{approachPage.labels.work}</dt>
                <dd>{stage.whatWeDo}</dd>
              </div>
              <div>
                <dt>{approachPage.labels.deliverable}</dt>
                <dd>{stage.whatYouGet}</dd>
              </div>
              <div>
                <dt>{approachPage.labels.input}</dt>
                <dd>{stage.whatWeNeed}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}
