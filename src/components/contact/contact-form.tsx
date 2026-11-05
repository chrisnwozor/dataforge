"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { SERVICE_OPTIONS } from "@/content/contact";
import { contactPage, type ContactIndustry } from "@/content/contact-page";
import { contactSchema, type ContactInput, type ContactValues } from "@/lib/contact/schema";
import { TurnstileChallenge } from "./turnstile-challenge";
import styles from "./contact.module.css";

type VisibleField =
  "name" | "businessName" | "email" | "service" | "projectDescription" | "consent";
const visibleFields: readonly VisibleField[] = [
  "name",
  "businessName",
  "email",
  "service",
  "projectDescription",
  "consent",
];

type ContactResponse = { ok?: boolean; message?: string; development?: boolean; devMode?: boolean };

export function ContactForm({
  initialService,
  industry,
  turnstileSiteKey,
}: {
  initialService?: ContactValues["service"];
  industry?: ContactIndustry;
  turnstileSiteKey?: string;
}) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const [preparationFailed, setPreparationFailed] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  const [success, setSuccess] = useState<{ development: boolean } | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [verificationRevision, setVerificationRevision] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const summaryFocusPending = useRef(false);
  const successRef = useRef<HTMLHeadingElement>(null);
  const tokenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenController = useRef<AbortController | undefined>(undefined);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<ContactInput, unknown, ContactValues>({
    resolver: zodResolver(contactSchema),
    mode: "onBlur",
    reValidateMode: "onChange",
    shouldFocusError: false,
    defaultValues: {
      name: "",
      businessName: "",
      email: "",
      service: initialService,
      projectDescription: industry ? `${contactPage.form.contextPrefix}${industry.label}.\n\n` : "",
      consent: false,
      website: "",
      submissionToken: "",
      turnstileToken: "",
    },
  });
  const description = useWatch({ control, name: "projectDescription" }) ?? "";
  const selectedService = useWatch({ control, name: "service" });
  const selectedServiceLabel = SERVICE_OPTIONS.find(
    (service) => service.value === selectedService,
  )?.label;

  const prepareForm = useCallback(async () => {
    tokenController.current?.abort();
    clearTimeout(tokenTimer.current);
    const controller = new AbortController();
    tokenController.current = controller;
    setTokenReady(false);
    setPreparationFailed(false);
    setValue("submissionToken", "");
    try {
      const response = await fetch("/api/contact", {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const data: { token?: unknown; minimumSubmitMs?: unknown } = await response.json();
      if (!response.ok || typeof data.token !== "string" || !data.token)
        throw new Error("Form preparation failed");
      if (controller.signal.aborted) return;
      setValue("submissionToken", data.token);
      const delay =
        typeof data.minimumSubmitMs === "number" && Number.isFinite(data.minimumSubmitMs)
          ? Math.min(Math.max(data.minimumSubmitMs, 0), 10000)
          : 3000;
      tokenTimer.current = setTimeout(() => setTokenReady(true), delay);
    } catch {
      if (controller.signal.aborted) return;
      setPreparationFailed(true);
      setRequestError(contactPage.form.preparationError);
    }
  }, [setValue]);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void prepareForm();
    });
    return () => {
      mounted = false;
      tokenController.current?.abort();
      clearTimeout(tokenTimer.current);
    };
  }, [prepareForm]);

  useEffect(() => {
    if (focusRevision > 0 && summaryFocusPending.current && summaryRef.current) {
      summaryRef.current.focus();
      summaryFocusPending.current = false;
    }
  }, [errors, focusRevision, requestError]);

  useEffect(() => {
    if (success) successRef.current?.focus();
  }, [success]);

  const onVerification = useCallback(
    (token: string) => {
      setValue("turnstileToken", token);
    },
    [setValue],
  );

  const focusSummary = () => {
    summaryFocusPending.current = true;
    setFocusRevision((revision) => revision + 1);
  };

  const submit = async (values: ContactValues) => {
    setRequestError(null);
    if (!tokenReady) {
      setRequestError(contactPage.form.preparationError);
      focusSummary();
      return;
    }
    if (turnstileSiteKey && !values.turnstileToken) {
      setRequestError(contactPage.form.verificationRequired);
      focusSummary();
      return;
    }
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(values),
      });
      const result: ContactResponse = await response.json();
      if (!response.ok || !result.ok) {
        setRequestError(
          typeof result.message === "string" ? result.message : contactPage.form.submitError,
        );
        focusSummary();
        setVerificationRevision((revision) => revision + 1);
        setValue("turnstileToken", "");
        void prepareForm();
        return;
      }
      setSuccess({ development: result.development === true || result.devMode === true });
    } catch {
      setRequestError(contactPage.form.submitError);
      focusSummary();
      setVerificationRevision((revision) => revision + 1);
      setValue("turnstileToken", "");
      void prepareForm();
    }
  };

  const onInvalid = () => {
    setRequestError(null);
    focusSummary();
  };

  const fieldError = (field: VisibleField) => errors[field]?.message;
  const errorId = (field: VisibleField) =>
    fieldError(field) ? `contact-${field}-error` : undefined;
  const fieldsWithErrors = visibleFields.filter((field) => fieldError(field));
  const hasErrors = fieldsWithErrors.length > 0 || requestError !== null;

  if (success) {
    return (
      <div className={styles.success} role="status">
        <span className={styles.successMark} aria-hidden="true">
          <Check size={24} strokeWidth={1.5} />
        </span>
        <p className={styles.formEyebrow}>{contactPage.form.successEyebrow}</p>
        <h2 ref={successRef} tabIndex={-1}>
          {success.development ? contactPage.form.developmentTitle : contactPage.form.successTitle}
        </h2>
        <p>
          {success.development
            ? contactPage.form.developmentDescription
            : contactPage.form.successDescription}
        </p>
        <Link href="/services" className={styles.successLink}>
          {contactPage.form.successLink}
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        void handleSubmit(submit, onInvalid)(event);
      }}
      noValidate
      aria-labelledby="contact-form-title"
      aria-busy={isSubmitting}
    >
      <div className={styles.formHeading}>
        <h2 id="contact-form-title">{contactPage.form.title}</h2>
        <p>{contactPage.form.requiredNote}</p>
      </div>
      {industry && (
        <p className={styles.context}>
          <span>{contactPage.form.contextLabel}</span>
          {industry.label}
        </p>
      )}
      {hasErrors && (
        <div
          ref={summaryRef}
          className={styles.errorSummary}
          tabIndex={-1}
          role="alert"
          aria-labelledby="contact-error-title"
        >
          <h3 id="contact-error-title">{contactPage.form.summaryTitle}</h3>
          {requestError && <p>{requestError}</p>}
          {fieldsWithErrors.length > 0 && (
            <ul>
              {fieldsWithErrors.map((field) => (
                <li key={field}>
                  <a
                    href={`#contact-${field}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setFocus(field);
                    }}
                  >
                    {fieldError(field)}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {preparationFailed && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => {
                setRequestError(null);
                void prepareForm();
              }}
            >
              {contactPage.form.retry}
            </button>
          )}
        </div>
      )}
      <fieldset className={styles.fields} disabled={isSubmitting}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="contact-name">{contactPage.form.labels.name}</label>
            <input
              id="contact-name"
              type="text"
              autoComplete="name"
              maxLength={100}
              required
              aria-invalid={Boolean(fieldError("name"))}
              aria-describedby={errorId("name")}
              {...register("name")}
            />
            {fieldError("name") && (
              <p id="contact-name-error" className={styles.fieldError}>
                {fieldError("name")}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor="contact-businessName">{contactPage.form.labels.businessName}</label>
            <input
              id="contact-businessName"
              type="text"
              autoComplete="organization"
              maxLength={160}
              required
              aria-invalid={Boolean(fieldError("businessName"))}
              aria-describedby={errorId("businessName")}
              {...register("businessName")}
            />
            {fieldError("businessName") && (
              <p id="contact-businessName-error" className={styles.fieldError}>
                {fieldError("businessName")}
              </p>
            )}
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor="contact-email">{contactPage.form.labels.email}</label>
          <input
            id="contact-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            maxLength={254}
            required
            aria-invalid={Boolean(fieldError("email"))}
            aria-describedby={errorId("email")}
            {...register("email")}
          />
          {fieldError("email") && (
            <p id="contact-email-error" className={styles.fieldError}>
              {fieldError("email")}
            </p>
          )}
        </div>
        <div className={styles.field}>
          <label htmlFor="contact-service">{contactPage.form.labels.service}</label>
          <select
            id="contact-service"
            required
            title={selectedServiceLabel}
            aria-invalid={Boolean(fieldError("service"))}
            aria-describedby={errorId("service")}
            {...register("service")}
          >
            <option value="">{contactPage.form.servicePlaceholder}</option>
            {SERVICE_OPTIONS.map((service) => (
              <option key={service.value} value={service.value}>
                {service.label}
              </option>
            ))}
          </select>
          {selectedServiceLabel && (
            <p className={styles.selectedService} aria-hidden="true">
              {selectedServiceLabel}
            </p>
          )}
          {fieldError("service") && (
            <p id="contact-service-error" className={styles.fieldError}>
              {fieldError("service")}
            </p>
          )}
        </div>
        <div className={styles.field}>
          <label htmlFor="contact-projectDescription">
            {contactPage.form.labels.projectDescription}
          </label>
          <textarea
            id="contact-projectDescription"
            rows={6}
            minLength={30}
            maxLength={3000}
            required
            placeholder={contactPage.form.descriptionPlaceholder}
            aria-invalid={Boolean(fieldError("projectDescription"))}
            aria-describedby={[
              "contact-description-hint",
              "contact-description-count",
              errorId("projectDescription"),
            ]
              .filter(Boolean)
              .join(" ")}
            {...register("projectDescription")}
          />
          <div className={styles.descriptionHelp}>
            <p id="contact-description-hint" className={styles.hint}>
              {contactPage.form.descriptionHint}
            </p>
            <span id="contact-description-count" className={styles.counter}>
              {description.length} {contactPage.form.counterSuffix}
            </span>
          </div>
          {fieldError("projectDescription") && (
            <p id="contact-projectDescription-error" className={styles.fieldError}>
              {fieldError("projectDescription")}
            </p>
          )}
        </div>
        <div className={styles.consentField}>
          <div className={styles.consentRow}>
            <input
              id="contact-consent"
              type="checkbox"
              required
              aria-invalid={Boolean(fieldError("consent"))}
              aria-describedby={errorId("consent")}
              {...register("consent")}
            />
            <label htmlFor="contact-consent">
              {contactPage.form.consentStart}
              <Link href="/privacy">{contactPage.form.consentLink}</Link>
              {contactPage.form.consentEnd}
            </label>
          </div>
          {fieldError("consent") && (
            <p id="contact-consent-error" className={styles.fieldError}>
              {fieldError("consent")}
            </p>
          )}
        </div>
        <div className={styles.honeypot} aria-hidden="true">
          <label htmlFor="contact-website">{contactPage.form.labels.website}</label>
          <input
            id="contact-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            {...register("website")}
          />
        </div>
        <input type="hidden" {...register("submissionToken")} />
        <input type="hidden" {...register("turnstileToken")} />
        {turnstileSiteKey && (
          <TurnstileChallenge
            key={verificationRevision}
            siteKey={turnstileSiteKey}
            onToken={onVerification}
          />
        )}
        <div className={styles.submitRow}>
          <button
            type="submit"
            className={styles.submitButton}
            disabled={isSubmitting || !tokenReady}
          >
            <span>
              {isSubmitting
                ? contactPage.form.submitting
                : !tokenReady && !preparationFailed
                  ? contactPage.form.preparing
                  : contactPage.form.submit}
            </span>
            <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <p>{contactPage.form.submitNote}</p>
        </div>
      </fieldset>
      <noscript>
        <p className={styles.fieldError}>{contactPage.form.noJavaScript}</p>
      </noscript>
    </form>
  );
}
