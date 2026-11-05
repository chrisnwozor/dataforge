import {
  ButtonLink,
  ClosingCta,
  Container,
  Eyebrow,
  PageIntro,
  Section,
} from "@/components/layout/primitives";
import { BankFlowMetrics } from "@/components/bankflow/BankFlowMetrics";
import { BankFlowPreview } from "@/components/bankflow/BankFlowPreview";
import { bankflow } from "@/content/bankflow";
import { workContent } from "@/content/work";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "@/components/bankflow/bankflow.module.css";

export const metadata = pageMetadata(
  workContent.pageTitle,
  workContent.metadataDescription,
  "/work",
);

export default function WorkPage() {
  return (
    <>
      <PageIntro
        eyebrow={workContent.eyebrow}
        title={workContent.title}
        description={workContent.description}
      >
        <Breadcrumbs items={workContent.breadcrumbs} />
      </PageIntro>
      <Section tone="light">
        <Container>
          <article className={styles.workFeature} aria-labelledby="bankflow-project-title">
            <div>
              <Eyebrow>{workContent.featuredLabel}</Eyebrow>
              <h2 id="bankflow-project-title" className={styles.projectTitle}>
                {bankflow.name}
              </h2>
              <p className={styles.description}>{bankflow.summary}</p>
              <p className={styles.demoLabel}>{bankflow.demonstrationLabel}</p>
              <ul className={styles.tags} aria-label={bankflow.technologiesLabel}>
                {bankflow.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
              <ButtonLink href="/work/bankflow" variant="secondary">
                {workContent.projectLink}
              </ButtonLink>
            </div>
            <BankFlowPreview />
          </article>
          <div className={styles.projectMetrics}>
            <BankFlowMetrics />
          </div>
          <p className={styles.publicationNote}>{workContent.publicationNote}</p>
        </Container>
      </Section>
      <ClosingCta title={workContent.cta.title} description={workContent.cta.description} />
    </>
  );
}
