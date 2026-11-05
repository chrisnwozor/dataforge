type ContactPageContent = {
  readonly breadcrumbs: readonly { readonly name: string; readonly path: string }[];
  readonly seo: { readonly title: string; readonly description: string };
  readonly intro: {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
  };
  readonly aside: {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
    readonly steps: readonly {
      readonly number: string;
      readonly title: string;
      readonly description: string;
    }[];
    readonly privacy: string;
    readonly emailLabel: string;
  };
  readonly industries: readonly { readonly value: string; readonly label: string }[];
  readonly unavailable: {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
    readonly reload: string;
    readonly services: string;
  };
  readonly form: {
    readonly title: string;
    readonly requiredNote: string;
    readonly labels: {
      readonly name: string;
      readonly businessName: string;
      readonly email: string;
      readonly service: string;
      readonly projectDescription: string;
      readonly website: string;
    };
    readonly servicePlaceholder: string;
    readonly descriptionHint: string;
    readonly descriptionPlaceholder: string;
    readonly counterSuffix: string;
    readonly consentStart: string;
    readonly consentLink: string;
    readonly consentEnd: string;
    readonly submit: string;
    readonly submitting: string;
    readonly preparing: string;
    readonly submitNote: string;
    readonly contextLabel: string;
    readonly contextPrefix: string;
    readonly summaryTitle: string;
    readonly preparationError: string;
    readonly submitError: string;
    readonly retry: string;
    readonly verificationLabel: string;
    readonly verificationError: string;
    readonly verificationRequired: string;
    readonly verificationRetry: string;
    readonly noJavaScript: string;
    readonly successEyebrow: string;
    readonly successTitle: string;
    readonly successDescription: string;
    readonly developmentTitle: string;
    readonly developmentDescription: string;
    readonly successLink: string;
  };
};

export const contactPage = {
  breadcrumbs: [
    { name: "Home", path: "/" },
    { name: "Contact", path: "/contact" },
  ],
  seo: {
    title: "Discuss your data project",
    description:
      "Tell DataForge about your data challenges. Discuss data engineering, Microsoft Azure, integration, warehousing, Power BI and analytics consulting.",
  },
  intro: {
    eyebrow: "Start a conversation",
    title: "Better decisions start with a clearer picture.",
    description:
      "Tell us what your business needs from its data. We can work through the technical questions together.",
  },
  aside: {
    eyebrow: "Your next step",
    title: "A problem to solve. A place to begin.",
    description:
      "You do not need a finished brief. A little context about your business, your current systems and what you want to improve is enough to begin.",
    steps: [
      {
        number: "01",
        title: "We review your inquiry.",
        description: "We read about your goals and the data challenges behind them.",
      },
      {
        number: "02",
        title: "We reply by email.",
        description:
          "We follow up with relevant questions and discuss whether a consultation would be useful.",
      },
      {
        number: "03",
        title: "We agree a practical next step.",
        description:
          "If there is a fit, we clarify requirements before preparing a scoped proposal.",
      },
    ],
    privacy:
      "Please describe the challenge without sharing confidential records, passwords or personal data about your customers.",
    emailLabel: "Prefer email?",
  },
  industries: [
    { value: "retail-and-ecommerce", label: "Retail and E-commerce" },
    { value: "logistics-and-operations", label: "Logistics and Operations" },
    { value: "financial-services", label: "Financial Services" },
    { value: "professional-services", label: "Professional Services" },
  ],
  unavailable: {
    eyebrow: "Contact",
    title: "Contact is temporarily unavailable.",
    description: "We cannot accept inquiries through this form right now. Please try again later.",
    reload: "Reload this page",
    services: "Explore our services",
  },
  form: {
    title: "Tell us about your project",
    requiredNote: "All fields are required.",
    labels: {
      name: "Your name",
      businessName: "Business name",
      email: "Email address",
      service: "Service interest",
      projectDescription: "What would you like to improve?",
      website: "Leave this field empty",
    },
    servicePlaceholder: "Choose a service",
    descriptionHint:
      "30–3000 characters. Helpful details include your current systems, the problem and the decision you want to support.",
    descriptionPlaceholder: "Our data currently lives in… We would like to…",
    counterSuffix: "/ 3000",
    consentStart: "I have read the ",
    consentLink: "privacy notice",
    consentEnd: " and agree that DataForge may use these details to respond to my inquiry.",
    submit: "Send inquiry",
    submitting: "Sending inquiry…",
    preparing: "Preparing form…",
    submitNote: "We use your details to respond to this inquiry.",
    contextLabel: "Your industry context",
    contextPrefix: "Industry context: ",
    summaryTitle: "Please check your inquiry.",
    preparationError:
      "The form could not be prepared. Your details are still here. Please try again.",
    submitError: "Your inquiry could not be sent. Your details are still here. Please try again.",
    retry: "Try again",
    verificationLabel: "Spam verification",
    verificationError:
      "Verification could not load. Please retry verification before sending your inquiry.",
    verificationRequired: "Please complete the verification before sending your inquiry.",
    verificationRetry: "Retry verification",
    noJavaScript: "Please enable JavaScript to use this form and its spam protection.",
    successEyebrow: "Inquiry received",
    successTitle: "Thank you for the context.",
    successDescription:
      "Your inquiry has been sent to DataForge. We will review your message and reply to the email address you provided.",
    developmentTitle: "Development submission received.",
    developmentDescription:
      "The form accepted your inquiry in this development environment. Email delivery is not configured, so no email was sent.",
    successLink: "Explore our services",
  },
} as const satisfies ContactPageContent;

export type ContactIndustry = (typeof contactPage.industries)[number];
