import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";
const config: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  outputFileTracingIncludes: {
    "/opengraph-image": ["./src/app/fonts/InstrumentSerif-Regular.ttf"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...staticSecurityHeaders,
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};
export default config;
