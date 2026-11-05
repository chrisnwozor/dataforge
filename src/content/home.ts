export const home = {
  metadata: {
    title: "Clarity from complexity.",
    description:
      "DataForge is a focused data engineering, Azure and business intelligence consultancy. Reliable foundations for better business decisions.",
  },
  hero: {
    eyebrow: "Data engineering & business intelligence consultancy",
    lineOne: "Clarity from",
    lineTwo: "complexity.",
    description:
      "DataForge designs and builds the data foundations, pipelines and reporting that growing businesses rely on. So decisions rest on numbers you can trust.",
    secondaryCta: "Explore BankFlow",
    note: "Thoughtful engineering. A clearer view of your business.",
    visual: {
      title: "Fragmented data becomes one structured foundation",
      description:
        "Separate data streams converge through a precise pipeline into an ordered, connected structure. An illustration of bringing disconnected business information together.",
      inputs: "Fragmented inputs",
      output: "A reliable foundation",
      caption: "From scattered sources to a shared understanding.",
      topLabel: "A considered path to clarity",
      bottomLabel: "Connect / structure / understand",
    },
  },
  statement: {
    eyebrow: "The reason behind the work",
    text: "We turn fragmented business data into reliable intelligence that supports better decisions.",
  },
  services: {
    eyebrow: "01 / Expertise",
    title: "Better decisions begin\nwith better foundations.",
    description:
      "From connecting your first systems to shaping the reports people use every day, we make the work behind your numbers more reliable.",
    link: "Explore our services",
  },
  problems: {
    eyebrow: "02 / Recognise the problem?",
    title: "The difficult part isn’t\nalways the data.",
    description:
      "It’s the time spent finding it, reconciling it, and wondering whether it tells the whole story.",
    items: [
      {
        problem: "Our reports don’t agree.",
        answer:
          "Trace the differences, define the numbers together, and create one organised home for reporting data.",
        service: "Data quality & warehousing",
      },
      {
        problem: "We spend hours moving data between spreadsheets.",
        answer:
          "Connect the systems behind the spreadsheets and build monitored, repeatable data movement.",
        service: "Integration & automation",
      },
      {
        problem: "We can’t see performance across the business.",
        answer:
          "Bring the right information together in a shared model and reports built around real decisions.",
        service: "Business intelligence",
      },
      {
        problem: "We have data, but no time to turn it into answers.",
        answer:
          "Clarify the questions, assess what is available, and choose a practical starting point.",
        service: "Analytics consulting",
      },
    ],
  },
  approach: {
    eyebrow: "03 / A deliberate approach",
    title: "Understand first.\nBuild with purpose.",
    description:
      "A clear path from the first question to a solution your business can understand, use and maintain.",
    link: "How we work",
  },
  work: {
    eyebrow: "04 / Selected work",
    projectType: "Personal demonstration project · Sample banking data",
    title: "BankFlow",
    description:
      "A considered path from raw transactions to analytical tables. An Azure data pipeline demonstrating layered architecture, validation and quarantine handling.",
    link: "Inside the project",
    architectureLabel: "Architecture, in brief",
  },
} as const;
