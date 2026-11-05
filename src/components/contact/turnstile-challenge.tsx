"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { contactPage } from "@/content/contact-page";
import styles from "./contact.module.css";

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: "contact";
      theme: "light";
      size: "flexible";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

function turnstileApi(): TurnstileApi | undefined {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

export function TurnstileChallenge({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [scriptAttempt, setScriptAttempt] = useState(0);

  const renderWidget = useCallback(() => {
    const api = turnstileApi();
    if (!api || !elementRef.current || widgetRef.current !== undefined) return;
    try {
      widgetRef.current = api.render(elementRef.current, {
        sitekey: siteKey,
        action: "contact",
        theme: "light",
        size: "flexible",
        callback: (token) => {
          setFailed(false);
          onToken(token);
        },
        "error-callback": () => {
          setFailed(true);
          onToken("");
        },
        "expired-callback": () => onToken(""),
      });
    } catch {
      queueMicrotask(() => {
        setFailed(true);
        onToken("");
      });
    }
  }, [onToken, siteKey]);

  useEffect(() => {
    renderWidget();
    return () => {
      const api = turnstileApi();
      if (api && widgetRef.current !== undefined) api.remove(widgetRef.current);
      widgetRef.current = undefined;
    };
  }, [renderWidget]);

  const retry = () => {
    setFailed(false);
    onToken("");
    const api = turnstileApi();
    if (api && widgetRef.current !== undefined) {
      api.reset(widgetRef.current);
    } else if (api) {
      renderWidget();
    } else {
      setScriptAttempt((attempt) => attempt + 1);
    }
  };

  return (
    <div className={styles.verification} aria-labelledby="contact-verification-label">
      <p id="contact-verification-label" className={styles.label}>
        {contactPage.form.verificationLabel}
      </p>
      <Script
        key={scriptAttempt}
        id={`contact-turnstile-${scriptAttempt}`}
        src={`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit${scriptAttempt ? `&retry=${scriptAttempt}` : ""}`}
        strategy="afterInteractive"
        onReady={renderWidget}
        onError={() => {
          setFailed(true);
          onToken("");
        }}
      />
      <div ref={elementRef} className={styles.verificationWidget} />
      {failed && (
        <div role="alert">
          <p className={styles.fieldError}>{contactPage.form.verificationError}</p>
          <button type="button" className={styles.retryButton} onClick={retry}>
            {contactPage.form.verificationRetry}
          </button>
        </div>
      )}
    </div>
  );
}
