import type { NextConfig } from "next";

const config: NextConfig = {
  // PDF exports embed the existing Geist fonts through a runtime file read.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf",
      "./node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf",
      "./lib/prepare/regex-worker.js",
    ],
  },
};

export default config;
