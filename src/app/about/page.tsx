import {
  Container,
  Section,
  PageIntro,
  Eyebrow,
  ButtonLink,
  ClosingCta,
} from "@/components/layout/primitives";
import { aboutPage as copy } from "@/content/about";
import { shellContent, teamMembers } from "@/content/site";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "../editorial.module.css";

export const metadata = pageMetadata(copy.label, copy.description, "/about");

export default function AboutPage() {
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
        <Breadcrumbs
          items={[
            { name: shellContent.home, path: "/" },
            { name: copy.label, path: "/about" },
          ]}
        />
      </PageIntro>
      <Section tone="light">
        <Container>
          <div className={styles.mission}>
            <Eyebrow>{copy.missionEyebrow}</Eyebrow>
            <p>{copy.mission}</p>
          </div>
          <div className={styles.philosophy}>
            <h2>{copy.philosophyTitle}</h2>
            <div>
              {copy.philosophy.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </div>
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
      {teamMembers.length > 0 && (
        <Section tone="light">
          <Container>
            <div className={styles.principlesHeader}>
              <Eyebrow>{copy.teamEyebrow}</Eyebrow>
              <h2>{copy.teamTitle}</h2>
            </div>
            <div className={styles.teamList}>
              {teamMembers.map((person) => (
                <article key={person.name} className={styles.teamMember}>
                  <div>
                    <h3>{person.name}</h3>
                    <p className={styles.personRole}>{person.role}</p>
                  </div>
                  <div>
                    <p>{person.bio}</p>
                    {person.credentials && person.credentials.length > 0 && (
                      <ul className={styles.ruleList}>
                        {person.credentials.map((credential) => (
                          <li key={credential}>{credential}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </Container>
        </Section>
      )}
      <Section tone="light">
        <Container>
          <div className={styles.projectProof}>
            <div>
              <Eyebrow>{copy.proofEyebrow}</Eyebrow>
              <h2>{copy.proofTitle}</h2>
            </div>
            <div>
              <p className={styles.lead}>{copy.proofDescription}</p>
              <ButtonLink href="/work/bankflow" variant="text">
                {copy.proofCta}
              </ButtonLink>
            </div>
          </div>
        </Container>
      </Section>
      <ClosingCta />
    </>
  );
}
