import { Container, Section, PageIntro, ButtonLink } from "@/components/layout/primitives";
import { privacyPage as copy } from "@/content/privacy";
import { shellContent } from "@/content/site";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "../editorial.module.css";

export const metadata = pageMetadata(copy.label, copy.description, "/privacy");

export default function PrivacyPage() {
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
        <Breadcrumbs
          items={[
            { name: shellContent.home, path: "/" },
            { name: copy.label, path: "/privacy" },
          ]}
        />
      </PageIntro>
      <Section tone="light">
        <Container>
          <div className={styles.privacyContent}>
            {copy.sections.map((section) => (
              <section key={section.id} id={section.id}>
                <h2>{section.title}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
            <ButtonLink href="/contact" variant="text">
              {copy.questionCta}
            </ButtonLink>
          </div>
        </Container>
      </Section>
    </>
  );
}
