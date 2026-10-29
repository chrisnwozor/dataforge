import type { NextConfig } from "next";

const config: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [
      {key: "X-Content-Type-Options", value: "nosniff"},
      {key: "X-Frame-Options", value: "DENY"},
      {key: "Referrer-Policy", value: "no-referrer"},
    ] }];
  },
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
