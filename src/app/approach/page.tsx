import { Container, Section, PageIntro, Eyebrow, ClosingCta } from "@/components/layout/primitives";
import { ApproachTimeline } from "@/components/sections/approach-timeline";
import { approachPage as copy } from "@/content/approach";
import { shellContent } from "@/content/site";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "../editorial.module.css";

export const metadata = pageMetadata(copy.label, copy.description, "/approach");

export default function ApproachPage() {
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
        <Breadcrumbs
          items={[
            { name: shellContent.home, path: "/" },
            { name: copy.label, path: "/approach" },
          ]}
        />
      </PageIntro>
      <Section tone="light">
        <Container>
          <ApproachTimeline />
        </Container>
      </Section>
      <Section>
        <Container>
          <div className={styles.principlesHeader}>
            <Eyebrow>{copy.principlesEyebrow}</Eyebrow>
            <h2>{copy.principlesTitle}</h2>
          </div>
          <ol className={styles.principlesList}>
            {copy.principles.map((principle, index) => (
              <li key={principle.title}>
                <span className={styles.indexNumber}>{String(index + 1).padStart(2, "0")}</span>
                <h3>{principle.title}</h3>
                <p>{principle.text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </Section>
      <ClosingCta />
    </>
  );
}
