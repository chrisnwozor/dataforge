"use client";

import { TEXT_SIZE_OPTIONS } from "@/lib/ui/readability";
import { useReadability } from "./provider";
import styles from "./readability.module.css";

export function ReadabilityControls() {
  const { preferences, highContrast, reducedMotion, persistence, update } =
    useReadability();
  return (
    <div className={styles.controls}>
      <fieldset className={styles.textSize} aria-describedby="text-size-help">
        <legend>Text size</legend>
        <p id="text-size-help" className={styles.caption}>
          Applies across DataForge. Browser zoom remains available.
        </p>
        <div className={styles.sizes}>
          {TEXT_SIZE_OPTIONS.map((option) => (
            <label key={option.value} className={styles.sizeChoice}>
              <input
                type="radio"
                name="dataforge-text-size"
                value={option.value}
                checked={preferences.textSize === option.value}
                onChange={() => update({ textSize: option.value })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.contrast}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={highContrast}
            onChange={(event) => update({ highContrast: event.target.checked })}
            aria-describedby="high-contrast-help"
          />
          <span>High contrast</span>
        </label>
        <p id="high-contrast-help" className={styles.caption}>
          Stronger text, borders and focus indicators in both themes.{" "}
          {preferences.highContrast === null
            ? "Following your device preference."
            : "Using your saved choice."}
        </p>
        {preferences.highContrast !== null && (
          <button
            type="button"
            className={styles.deviceButton}
            onClick={() => update({ highContrast: null })}
          >
            Use device contrast preference
          </button>
        )}
      </div>
      <p className={styles.caption} role="status">
        {persistence === "session"
          ? "Browser storage is unavailable. These choices apply for this visit."
          : "Changes are saved automatically in this browser."}{" "}
        {reducedMotion
          ? "Reduced motion is enabled by your device."
          : "Animations also follow your device’s reduced-motion preference."}
      </p>
    </div>
  );
}
