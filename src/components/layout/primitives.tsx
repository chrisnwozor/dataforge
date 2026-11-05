import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";
import { common } from "@/content/common";

export function Container({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} className={clsx("container", className)}>
      {children}
    </div>
  );
}
export function Section({
  children,
  tone = "dark",
  className,
  id,
  ariaLabel,
}: {
  children: ReactNode;
  tone?: "dark" | "light" | "ink";
  className?: string;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <section id={id} aria-label={ariaLabel} className={clsx("section", `tone-${tone}`, className)}>
      {children}
    </section>
  );
}
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx("eyebrow", className)}>{children}</p>;
}
export function ButtonLink({
  href,
  children,
  variant = "primary",
  className,
  arrow = true,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "text";
  className?: string;
  arrow?: boolean;
}) {
  return (
    <Link href={href} className={clsx("button-link", `button-${variant}`, className)}>
      <span>{children}</span>
      {arrow && <ArrowUpRight size={17} strokeWidth={1.4} aria-hidden="true" />}
    </Link>
  );
}
export function PageIntro({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="page-intro tone-dark">
      <Container>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        <p className="page-intro-description">{description}</p>
        {children}
      </Container>
    </section>
  );
}
export function ClosingCta({
  title = common.closing.title,
  description = common.closing.description,
  href = "/contact",
}: {
  title?: string;
  description?: string;
  href?: string;
}) {
  return (
    <Section className="closing-cta">
      <Container>
        <div className="closing-grid">
          <div>
            <Eyebrow>{common.closing.eyebrow}</Eyebrow>
            <h2>{title}</h2>
          </div>
          <div>
            <p>{description}</p>
            <ButtonLink href={href}>{common.projectCta}</ButtonLink>
          </div>
        </div>
      </Container>
    </Section>
  );
}
