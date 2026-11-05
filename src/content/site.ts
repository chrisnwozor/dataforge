export type SiteLink = Readonly<{ label: string; href: string }>;

export type TeamMember = Readonly<{
  name: string;
  role: string;
  bio: string;
  credentials?: readonly string[];
}>;

export type SocialLink = Readonly<{
  label: string;
  url: `https://${string}`;
}>;

export const siteConfig = {
  name: "DataForge",
  title: "DataForge — Clarity from complexity",
  promise:
    "We turn fragmented business data into reliable intelligence that supports better decisions.",
  description:
    "A focused data consultancy. Cloud data engineering, Microsoft Azure solutions, business intelligence and analytics for small and medium-sized companies.",
  shortDescription: "Data engineering. Clearer decisions.",
  navigation: [
    { label: "Services", href: "/services" },
    { label: "Solutions", href: "/solutions" },
    { label: "Approach", href: "/approach" },
    { label: "Work", href: "/work" },
    { label: "About", href: "/about" },
  ] as readonly SiteLink[],
  defaultCTA: { label: "Discuss Your Project", href: "/contact" } as SiteLink,
  // Add only real people and verifiable credentials. An empty array hides the block.
  team: [] as readonly TeamMember[],
  // Add only genuine, publicly accessible company profiles. Empty by default.
  socialLinks: [] as readonly SocialLink[],
} as const;

export const teamMembers = siteConfig.team;

export const shellContent = {
  homeLabel: "DataForge home",
  primaryNavigation: "Main navigation",
  mobileNavigation: "Explore DataForge",
  openMenu: "Open navigation menu",
  closeMenu: "Close navigation menu",
  menuEyebrow: "Explore",
  menuNote: "A clearer view of what comes next.",
  footerEyebrow: "A considered approach to data.",
  footerNavigation: "Explore",
  footerNavigationLabel: "Footer navigation",
  footerContact: "Start a conversation",
  footerDescriptor:
    "A boutique consultancy for data engineering, Azure cloud solutions and business intelligence.",
  copyright: "DataForge. All rights reserved.",
  privacy: "Privacy",
  breadcrumbLabel: "Breadcrumb",
  home: "Home",
  iconAlt: "DataForge monogram",
  og: {
    label: "DATA ENGINEERING / AZURE / BUSINESS INTELLIGENCE",
    headline: "Clarity from complexity.",
    description: "Considered data solutions. Built around your business.",
    alt: "DataForge. Clarity from complexity. Data engineering, Azure and business intelligence.",
  },
  manifest: {
    name: "DataForge — Data Consulting",
    shortName: "DataForge",
  },
} as const;

export const fallbackContent = {
  notFound: {
    eyebrow: "404 / A different direction",
    title: "This page is out of the picture.",
    description:
      "The link may have changed. Explore our expertise, or tell us what you are trying to solve.",
    home: "Back to home",
    services: "Explore our services",
    metadataTitle: "Page not found",
    metadataDescription:
      "Find your way back to DataForge services, project work and consultation inquiries.",
  },
  error: {
    eyebrow: "A moment to reconnect",
    title: "We could not load this page.",
    description: "Please try again. You can also return to the home page and explore from there.",
    retry: "Try again",
    home: "Back to home",
  },
} as const;

export const publishedRoutes = [
  "/",
  "/services",
  "/solutions",
  "/approach",
  "/work",
  "/work/bankflow",
  "/about",
  "/contact",
  "/privacy",
] as const;
