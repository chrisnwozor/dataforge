import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Container, Section, PageIntro, Eyebrow, ButtonLink } from "@/components/layout/primitives";
import { ServiceMotif } from "@/components/illustrations/service-motifs";
import { services, servicesPage as copy } from "@/content/services";
import { shellContent } from "@/content/site";
import { Breadcrumbs, pageMetadata } from "@/lib/seo";
import styles from "../editorial.module.css";

export const metadata = pageMetadata(copy.label, copy.description, "/services");

export default function ServicesPage() {
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
        <Breadcrumbs
          items={[
            { name: shellContent.home, path: "/" },
            { name: copy.label, path: "/services" },
          ]}
        />
      </PageIntro>
      <Section tone="light" className={styles.servicesSection}>
        <Container>
          <nav aria-label={copy.indexLabel} className={styles.serviceIndex}>
            <ol>
              {services.map((service, index) => (
                <li key={service.id}>
                  <Link href={`#${service.id}`}>
                    <span className={styles.indexNumber}>{String(index + 1).padStart(2, "0")}</span>
                    <span>{service.name}</span>
                    <ArrowUpRight size={16} strokeWidth={1.4} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ol>
          </nav>
          <div className={styles.serviceArticles}>
            {services.map((service, index) => (
              <article key={service.id} id={service.id} className={styles.serviceArticle}>
                <div className={styles.serviceIdentity}>
                  <span className={styles.indexNumber}>{String(index + 1).padStart(2, "0")}</span>
                  <p>{service.name}</p>
                  <ServiceMotif kind={service.id} className={styles.serviceMotif} />
                </div>
                <div className={styles.serviceBody}>
                  <h2>{service.outcome}</h2>
                  <p className={styles.lead}>{service.description}</p>
                  <div className={styles.deliverables}>
                    <h3 className={styles.smallHeading}>{copy.deliverablesLabel}</h3>
                    <ul className={styles.ruleList}>
                      {service.deliverables.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={styles.technologyBlock}>
                    <h3 className={styles.smallHeading}>{copy.technologyLabel}</h3>
                    <ul className={styles.technologyList}>
                      {service.technologies.map((technology) => (
                        <li key={technology}>{technology}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={styles.idealWhen}>
                    <h3 className={styles.smallHeading}>{copy.idealWhenLabel}</h3>
                    <p>{service.idealWhen}</p>
                    <ButtonLink href={`/contact?service=${service.id}`} variant="text">
                      {copy.serviceCta}
                    </ButtonLink>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <p className={styles.technologyNote}>{copy.technologyNote}</p>
        </Container>
      </Section>
      <Section>
        <Container>
          <div className={styles.engagement}>
            <div>
              <Eyebrow>{copy.engagement.eyebrow}</Eyebrow>
              <h2>{copy.engagement.title}</h2>
            </div>
            <div>
              <p className={styles.lead}>{copy.engagement.description}</p>
              <ButtonLink href="/contact">{copy.engagement.cta}</ButtonLink>
            </div>
          </div>
        </Container>
      </Section>
    </>
  );
}
