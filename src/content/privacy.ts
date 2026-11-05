export type PrivacySection = {
  id: string;
  title: string;
  paragraphs: readonly string[];
};

export const privacyPage = {
  label: "Privacy",
  eyebrow: "Privacy",
  title: "A clear note on your information.",
  description:
    "This notice explains how this website handles consultation inquiries and the technical information needed to deliver the site and protect the form.",
  sections: [
    {
      id: "inquiry-information",
      title: "Information you send",
      paragraphs: [
        "The consultation form asks for your name, business name, email address, service interest and project description. It also records your acknowledgement of this privacy notice. If you arrive from an industry example, that context may be included with your inquiry.",
        "We use this information to understand your request, assess whether there is suitable work to discuss and reply by email. Sending an inquiry does not subscribe you to a mailing list. Please keep the description to the information needed for an initial conversation.",
      ],
    },
    {
      id: "technical-information",
      title: "Information used to operate and protect the site",
      paragraphs: [
        "The hosting service processes ordinary request information, such as an IP address, browser information and the page requested, to deliver the website and maintain operational logs.",
        "The contact form uses a signed timing token and automated checks to reduce spam. A rate limit uses an identifier derived from the request's IP address to restrict repeated submissions. The form does not need an account, and this website does not include advertising or analytics trackers.",
      ],
    },
    {
      id: "service-providers",
      title: "Services involved in an inquiry",
      paragraphs: [
        "When email delivery is configured, Resend processes the form information to send the inquiry to the DataForge inbox. The inquiry then remains part of the email correspondence used to respond to you.",
        "When configured, Upstash stores rate-limit identifiers and counters used to protect the form. It does not receive your project description for that purpose. When Cloudflare Turnstile is enabled, Cloudflare processes technical browser and interaction information to assess whether a submission may be automated.",
        "These providers and the website's hosting service process information under their own service terms and privacy notices. Their infrastructure may process information in more than one country.",
      ],
    },
    {
      id: "retention",
      title: "Keeping your information",
      paragraphs: [
        "Inquiry correspondence is kept as needed to respond to the request, discuss potential work and maintain relevant business records. Email, hosting and abuse-prevention providers also apply their own retention settings to the records they process. This website does not maintain a separate customer account or project-data database.",
        "If you would like to know what inquiry information is held, correct it or request its deletion, contact us through the consultation form and identify the email address used for your original inquiry. We may need to confirm your identity before acting on a request.",
      ],
    },
    {
      id: "your-choices",
      title: "Your choices and questions",
      paragraphs: [
        "You choose whether to send an inquiry. The required fields provide the context and contact details needed to respond. Rights relating to personal information depend on the law that applies to you; you can use the contact form to ask how your information has been handled.",
      ],
    },
  ] satisfies readonly PrivacySection[],
  questionCta: "Contact DataForge about privacy",
} as const;
