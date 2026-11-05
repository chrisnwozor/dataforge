import { home } from "@/content/home";
import { common } from "@/content/common";
import { services } from "@/content/services";
import { approachStages } from "@/content/approach";
import { bankflow } from "@/content/bankflow";
import {
  Container,
  Section,
  Eyebrow,
  ButtonLink,
  ClosingCta,
} from "@/components/layout/primitives";
import { ClarityIllustration } from "@/components/illustrations/clarity";
import { ServiceMotif } from "@/components/illustrations/service-motifs";
import { BankFlowPreview } from "@/components/bankflow/BankFlowPreview";
import { Reveal } from "@/components/motion/reveal";
import { pageMetadata } from "@/lib/seo";
import { ArrowDown, ArrowUpRight } from "lucide-react";
export const metadata = pageMetadata(home.metadata.title, home.metadata.description, "/");
export default function Home() {
  return (
    <>
      <section className="home-hero tone-dark">
        <Container>
          <div className="hero-grid">
            <div className="hero-copy">
              <Reveal>
                <Eyebrow>{home.hero.eyebrow}</Eyebrow>
              </Reveal>
              <Reveal delay={0.08}>
                <h1>
                  {home.hero.lineOne} <br />
                  <em>{home.hero.lineTwo}</em>
                </h1>
              </Reveal>
              <Reveal delay={0.16}>
                <p className="hero-description">{home.hero.description}</p>
                <div className="hero-actions">
                  <ButtonLink href="/contact">{common.projectCta}</ButtonLink>
                  <ButtonLink variant="text" href="/work/bankflow">
                    {home.hero.secondaryCta}
                  </ButtonLink>
                </div>
              </Reveal>
            </div>
            <Reveal className="hero-art" delay={0.2}>
              <ClarityIllustration />
            </Reveal>
          </div>
          <div className="hero-footnote">
            <span className="hairline" />
            <p>{home.hero.note}</p>
            <span className="hero-scroll" aria-hidden="true">
              <ArrowDown size={18} strokeWidth={1.2} />
            </span>
          </div>
        </Container>
      </section>
      <Section tone="light" className="promise-section">
        <Container>
          <Reveal>
            <Eyebrow>{home.statement.eyebrow}</Eyebrow>
            <p className="promise-text">{home.statement.text}</p>
          </Reveal>
        </Container>
      </Section>
      <Section tone="light" className="home-services">
        <Container>
          <div className="section-heading">
            <div>
              <Eyebrow>{home.services.eyebrow}</Eyebrow>
              <h2 className="display-heading">{home.services.title}</h2>
            </div>
            <p>{home.services.description}</p>
          </div>
          <div className="service-index">
            {services.map((service, index) => (
              <Reveal key={service.id}>
                <a className="service-index-row" href={`/services#${service.id}`}>
                  <span className="index-number">{String(index + 1).padStart(2, "0")}</span>
                  <ServiceMotif kind={service.id} />
                  <h3>{service.name}</h3>
                  <p>{service.short}</p>
                  <span className="index-arrow" aria-hidden="true">
                    <ArrowUpRight size={20} strokeWidth={1.3} />
                  </span>
                </a>
              </Reveal>
            ))}
          </div>
          <ButtonLink href="/services" variant="text">
            {home.services.link}
          </ButtonLink>
        </Container>
      </Section>
      <Section className="problems-section">
        <Container>
          <div className="split-section">
            <div className="sticky-heading">
              <Eyebrow>{home.problems.eyebrow}</Eyebrow>
              <h2 className="display-heading">{home.problems.title}</h2>
              <p className="section-description">{home.problems.description}</p>
            </div>
            <div className="problem-list">
              {home.problems.items.map((item) => (
                <Reveal key={item.problem}>
                  <article>
                    <h3>“{item.problem}”</h3>
                    <p>{item.answer}</p>
                    <span className="small-label">{item.service}</span>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </Container>
      </Section>
      <Section className="home-approach">
        <Container>
          <div className="section-heading">
            <div>
              <Eyebrow>{home.approach.eyebrow}</Eyebrow>
              <h2 className="display-heading">{home.approach.title}</h2>
            </div>
            <div>
              <p>{home.approach.description}</p>
              <ButtonLink href="/approach" variant="text">
                {home.approach.link}
              </ButtonLink>
            </div>
          </div>
          <ol className="approach-strip">
            {approachStages.map((stage, index) => (
              <li key={stage.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{stage.name}</h3>
                <p>{stage.purpose}</p>
              </li>
            ))}
          </ol>
        </Container>
      </Section>
      <Section tone="light" className="home-work">
        <Container>
          <Eyebrow>{home.work.eyebrow}</Eyebrow>
          <div className="featured-work">
            <div className="featured-work-copy">
              <span className="small-label">{home.work.projectType}</span>
              <h2>{home.work.title}</h2>
              <p>{home.work.description}</p>
              <ButtonLink href="/work/bankflow" variant="text">
                {home.work.link}
              </ButtonLink>
            </div>
            <div className="featured-work-art">
              <span className="small-label">{home.work.architectureLabel}</span>
              <BankFlowPreview />
            </div>
          </div>
          <dl className="home-project-metrics">
            {bankflow.metrics.map((metric) => (
              <div key={metric.id}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </Section>
      <ClosingCta />
    </>
  );
}
