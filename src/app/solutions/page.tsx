import {
  Container,
  Section,
  PageIntro,
  Eyebrow,
  ButtonLink,
  ClosingCta,
} from "@/components/layout/primitives";
import { IndustryMotif } from "@/components/illustrations/service-motifs";
import { industryScenarios, solutionsPage as copy } from "@/content/solutions";
import { shellContent } from "@/content/site";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "../editorial.module.css";

export const metadata = pageMetadata(copy.label, copy.description, "/solutions");

export default function SolutionsPage() {
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
        <Breadcrumbs
          items={[
            { name: shellContent.home, path: "/" },
            { name: copy.label, path: "/solutions" },
          ]}
        />
      </PageIntro>
      <Section tone="light">
        <Container>
          <p className={styles.scenarioNotice}>{copy.illustrativeNote}</p>
          <div>
            {industryScenarios.map((industry, index) => (
              <article key={industry.id} id={industry.id} className={styles.industryArticle}>
                <div className={styles.industryHeader}>
                  <span className={styles.indexNumber}>{String(index + 1).padStart(2, "0")}</span>
                  <Eyebrow>{industry.name}</Eyebrow>
                  <IndustryMotif kind={industry.id} className={styles.industryMotif} />
                </div>
                <div className={styles.industryGrid}>
                  <h2>{industry.question}</h2>
                  <div className={styles.industryBody}>
                    <div>
                      <h3 className={styles.smallHeading}>{copy.labels.challenge}</h3>
                      <p>{industry.challenge}</p>
                    </div>
                    <div>
                      <h3 className={styles.smallHeading}>{copy.labels.sources}</h3>
                      <ul className={styles.sourceList}>
                        {industry.sources.map((source) => (
                          <li key={source}>{source}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3 className={styles.smallHeading}>{copy.labels.approach}</h3>
                      <p>{industry.approach}</p>
                    </div>
                    <div>
                      <h3 className={styles.smallHeading}>{copy.labels.outcomes}</h3>
                      <ul className={styles.ruleList}>
                        {industry.outcomes.map((outcome) => (
                          <li key={outcome}>{outcome}</li>
                        ))}
                      </ul>
                    </div>
                    <ButtonLink
                      href={`/contact?service=${industry.serviceId}&industry=${industry.id}`}
                      variant="text"
                    >
                      {copy.labels.cta}
                    </ButtonLink>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </Container>
      </Section>
      <ClosingCta title={copy.closing.title} description={copy.closing.description} />
    </>
  );
}
