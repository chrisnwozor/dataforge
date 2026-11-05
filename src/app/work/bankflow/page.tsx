import { ClosingCta, Container, Eyebrow, PageIntro, Section } from "@/components/layout/primitives";
import { BankFlowArchitecture } from "@/components/bankflow/BankFlowArchitecture";
import { BankFlowGallery } from "@/components/bankflow/BankFlowGallery";
import { BankFlowMetrics } from "@/components/bankflow/BankFlowMetrics";
import { bankflow, goldTableNames, screenshots } from "@/content/bankflow";
import { workContent } from "@/content/work";
import { Breadcrumbs, CreativeWorkStructuredData, pageMetadata } from "@/lib/seo";
import styles from "@/components/bankflow/bankflow.module.css";

export const metadata = pageMetadata(bankflow.pageTitle, bankflow.description, "/work/bankflow");

export default function BankFlowPage() {
  const showGallery = screenshots.length > 0 || process.env.NODE_ENV !== "production";

  return (
    <>
      <CreativeWorkStructuredData
        name={bankflow.name}
        description={bankflow.description}
        path="/work/bankflow"
      />
      <PageIntro eyebrow={bankflow.eyebrow} title={bankflow.name} description={bankflow.summary}>
        <Breadcrumbs
          items={[...workContent.breadcrumbs, { name: bankflow.name, path: "/work/bankflow" }]}
        />
        <div className={styles.heroBottom}>
          <p className={styles.demoLabel}>{bankflow.demonstrationLabel}</p>
          <ul className={styles.tags} aria-label={bankflow.technologiesLabel}>
            {bankflow.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        </div>
      </PageIntro>

      <Section tone="light" className={styles.metricsSection} ariaLabel={bankflow.metricsLabel}>
        <Container>
          <BankFlowMetrics />
        </Container>
      </Section>

      <Section tone="light">
        <Container>
          <div className={styles.split}>
            <div>
              <Eyebrow>{bankflow.challenge.eyebrow}</Eyebrow>
              <h2 className={styles.sectionTitle}>{bankflow.challenge.title}</h2>
            </div>
            <div className={styles.prose}>
              {bankflow.challenge.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      <Section>
        <Container>
          <Eyebrow>{bankflow.architecture.eyebrow}</Eyebrow>
          <h2 className={styles.sectionTitle}>{bankflow.architecture.title}</h2>
          <p className={styles.description}>{bankflow.architecture.introduction}</p>
          <BankFlowArchitecture />
        </Container>
      </Section>

      <Section tone="light">
        <Container>
          <Eyebrow>{bankflow.layers.eyebrow}</Eyebrow>
          <h2 className={styles.sectionTitle}>{bankflow.layers.title}</h2>
          <p className={styles.description}>{bankflow.layers.introduction}</p>
          <div className={styles.layerList}>
            {bankflow.layers.items.map((layer) => (
              <div className={styles.layerRow} key={layer.name}>
                <h3 className={styles.layerName}>{layer.name}</h3>
                <p className={styles.layerSubtitle}>{layer.subtitle}</p>
                <p className={styles.layerDescription}>{layer.description}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section>
        <Container>
          <div className={styles.split}>
            <div>
              <Eyebrow>{bankflow.quality.eyebrow}</Eyebrow>
              <h2 className={styles.sectionTitle}>{bankflow.quality.title}</h2>
              <p className={styles.description}>{bankflow.quality.introduction}</p>
              <p className={styles.note}>{bankflow.quality.note}</p>
            </div>
            <ul className={styles.qualityList}>
              {bankflow.quality.items.map((item) => (
                <li key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </Section>

      <Section tone="light">
        <Container>
          <Eyebrow>{bankflow.model.eyebrow}</Eyebrow>
          <h2 className={styles.sectionTitle}>{bankflow.model.title}</h2>
          <p className={styles.description}>{bankflow.model.description}</p>
          <div className={styles.model}>
            <div className={styles.modelBlock}>
              <h3>{bankflow.model.facts.title}</h3>
              <p>{bankflow.model.facts.description}</p>
            </div>
            <div className={styles.modelConnection} aria-hidden="true" />
            <div className={styles.modelBlock}>
              <h3>{bankflow.model.dimensions.title}</h3>
              <p>{bankflow.model.dimensions.description}</p>
            </div>
          </div>
          {goldTableNames.length > 0 && (
            <ul className={styles.tags}>
              {goldTableNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
          <div className={styles.reportingBlock}>
            <Eyebrow>{bankflow.reporting.eyebrow}</Eyebrow>
            <h2 className={styles.sectionTitle}>{bankflow.reporting.title}</h2>
            <p className={styles.description}>{bankflow.reporting.description}</p>
          </div>
        </Container>
      </Section>

      {showGallery && (
        <Section>
          <Container>
            <Eyebrow>{bankflow.gallery.eyebrow}</Eyebrow>
            <h2 className={styles.sectionTitle}>{bankflow.gallery.title}</h2>
            {screenshots.length > 0 && (
              <p className={styles.description}>{bankflow.gallery.description}</p>
            )}
            <BankFlowGallery screenshots={screenshots} />
          </Container>
        </Section>
      )}

      <Section tone="light">
        <Container>
          <div className={styles.split}>
            <div>
              <Eyebrow>{bankflow.demonstrates.eyebrow}</Eyebrow>
              <h2 className={styles.sectionTitle}>{bankflow.demonstrates.title}</h2>
            </div>
            <ul className={styles.capabilities}>
              {bankflow.demonstrates.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <p className={styles.limitation}>{bankflow.demonstrates.limitation}</p>
        </Container>
      </Section>

      <ClosingCta
        title={bankflow.cta.title}
        description={bankflow.cta.description}
        href={bankflow.cta.href}
      />
    </>
  );
}
