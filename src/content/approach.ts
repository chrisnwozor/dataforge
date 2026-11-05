export type ApproachStage = {
  id: string;
  name: string;
  purpose: string;
  whatWeDo: string;
  whatYouGet: string;
  whatWeNeed: string;
};

export const approachStages = [
  {
    id: "discovery",
    name: "Discovery",
    purpose: "Understand the decision before designing the data solution.",
    whatWeDo:
      "Talk through the business problem, the people affected and the questions a useful solution needs to answer. Establish priorities, constraints and the boundaries of the work.",
    whatYouGet:
      "A shared problem statement, an outline of the scope and a clear view of what success would mean.",
    whatWeNeed:
      "Time with the people who use the data, examples of current reports and an honest account of what is difficult today.",
  },
  {
    id: "data-assessment",
    name: "Data Assessment",
    purpose: "Find out what the available data can reliably support.",
    whatWeDo:
      "Review relevant sources, access arrangements, data structure and quality. Trace important measures back to their source and identify gaps or assumptions that need resolving.",
    whatYouGet:
      "A source inventory, initial quality findings and a record of dependencies and risks that inform the design.",
    whatWeNeed:
      "Appropriate access to agreed sources or representative samples, plus a contact who can explain how those systems are used.",
  },
  {
    id: "architecture-and-solution-design",
    name: "Architecture and Solution Design",
    purpose: "Agree how the pieces fit, and why each one is needed.",
    whatWeDo:
      "Design the data flow, storage, transformations and reporting model. Consider security, operation and cost alongside the business requirements. Explain the tradeoffs in plain language.",
    whatYouGet:
      "An agreed architecture, defined deliverables and a delivery plan with responsibilities and acceptance criteria.",
    whatWeNeed:
      "Feedback on the design, decisions about access and ownership, and agreement on the scope before implementation begins.",
  },
  {
    id: "implementation",
    name: "Implementation",
    purpose: "Build in understandable pieces that can be reviewed along the way.",
    whatWeDo:
      "Configure the agreed services, build connections and transformations, and develop the reporting model. Use version control and document the decisions that matter to future maintenance.",
    whatYouGet:
      "Working components within the agreed scope, progress reviews and implementation documentation that develops with the build.",
    whatWeNeed:
      "The agreed environment and permissions, timely answers to source-system questions and feedback at review points.",
  },
  {
    id: "validation-and-delivery",
    name: "Validation and Delivery",
    purpose: "Check the numbers and make the handover practical.",
    whatWeDo:
      "Reconcile results against agreed sources, test validation and exception handling, and review reporting with its users. Walk through operation, limitations and the handover materials.",
    whatYouGet:
      "Validation evidence, an agreed record of any remaining limitations, documented operating steps and a considered handover.",
    whatWeNeed:
      "Business users who can verify the results, agreed reference figures and a named owner for the delivered solution.",
  },
  {
    id: "support-and-improvement",
    name: "Support and Improvement",
    purpose: "Keep the solution useful as the business changes.",
    whatWeDo:
      "Where included in the engagement, review operation, investigate issues and assess changes to sources or reporting needs. Agree further work before extending the scope.",
    whatYouGet:
      "Support within the agreed arrangement and a prioritised view of potential improvements. Ongoing support is scoped explicitly.",
    whatWeNeed:
      "An owner for questions and decisions, examples of issues and a clear view of changing business priorities.",
  },
] as const satisfies readonly ApproachStage[];

export const approachPage = {
  label: "Approach",
  eyebrow: "Our approach",
  title: "A clear path from question to working solution.",
  description:
    "Good data work begins with understanding. Our process makes the decisions, responsibilities and deliverables visible, so you can follow the work from the first conversation to handover.",
  timelineLabel: "Six stages of a DataForge engagement",
  labels: {
    work: "What we do",
    deliverable: "What you get",
    input: "What we need from you",
  },
  principlesEyebrow: "Working principles",
  principlesTitle: "The thinking behind the process.",
  principles: [
    {
      title: "Speak plainly.",
      text: "Explain the decision and its consequences in language the people involved can use.",
    },
    {
      title: "Leave a clear record.",
      text: "Document the important logic, assumptions and operating steps as part of the work.",
    },
    {
      title: "Validate before trusting.",
      text: "Check results against their sources and make exceptions visible before relying on a report.",
    },
    {
      title: "Allow for change.",
      text: "Build understandable foundations that can adapt without adding unnecessary complexity today.",
    },
  ],
} as const;
