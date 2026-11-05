import { ContactForm } from "@/components/contact/contact-form";
import styles from "@/components/contact/contact.module.css";
import { ButtonLink, Container, Eyebrow, PageIntro, Section } from "@/components/layout/primitives";
import { SERVICE_OPTIONS } from "@/content/contact";
import { contactPage } from "@/content/contact-page";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import { ContactConfigurationError, getContactEnvironment } from "@/lib/env";

export const metadata = pageMetadata(
  contactPage.seo.title,
  contactPage.seo.description,
  "/contact",
);

type ContactPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ContactPage({ searchParams }: ContactPageProps) {
  const query = await searchParams;
  const initialService = SERVICE_OPTIONS.find((service) => service.value === query.service)?.value;
  const industry = contactPage.industries.find((item) => item.value === query.industry);
  const publicEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  const contactEmail =
    publicEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publicEmail) ? publicEmail : undefined;
  let contactAvailable = true;
  try {
    getContactEnvironment();
  } catch (error) {
    if (error instanceof ContactConfigurationError) contactAvailable = false;
    else throw error;
  }

  return (
    <>
      <PageIntro {...contactPage.intro}>
        <Breadcrumbs items={[...contactPage.breadcrumbs]} />
      </PageIntro>
      <Section tone="light" className={styles.contactSection}>
        <Container>
          <div className={styles.layout}>
            <aside className={styles.aside} aria-labelledby="contact-next-step">
              <Eyebrow>{contactPage.aside.eyebrow}</Eyebrow>
              <h2 id="contact-next-step" className={styles.asideTitle}>
                {contactPage.aside.title}
              </h2>
              <p className={styles.asideDescription}>{contactPage.aside.description}</p>
              <ol className={styles.steps}>
                {contactPage.aside.steps.map((step) => (
                  <li key={step.number}>
                    <span className={styles.stepNumber} aria-hidden="true">
                      {step.number}
                    </span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className={styles.privacyNote}>{contactPage.aside.privacy}</p>
              {contactEmail && (
                <p className={styles.email}>
                  {contactPage.aside.emailLabel}{" "}
                  <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
                </p>
              )}
            </aside>
            {contactAvailable ? (
              <ContactForm
                initialService={initialService}
                industry={industry}
                turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
              />
            ) : (
              <div className={styles.unavailable} aria-labelledby="contact-unavailable-title">
                <Eyebrow>{contactPage.unavailable.eyebrow}</Eyebrow>
                <h2 id="contact-unavailable-title">{contactPage.unavailable.title}</h2>
                <p>{contactPage.unavailable.description}</p>
                <div className={styles.unavailableActions}>
                  <a href="/contact" className={styles.reloadLink}>
                    {contactPage.unavailable.reload}
                  </a>
                  <ButtonLink href="/services" variant="text">
                    {contactPage.unavailable.services}
                  </ButtonLink>
                </div>
              </div>
            )}
          </div>
        </Container>
      </Section>
    </>
  );
}
