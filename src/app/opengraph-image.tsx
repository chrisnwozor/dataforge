import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { shellContent, siteConfig } from "@/content/site";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = shellContent.og.alt;

export default async function OpenGraphImage() {
  const fontPath = join(
    /* turbopackIgnore: true */ process.cwd(),
    "src/app/fonts/InstrumentSerif-Regular.ttf",
  );
  const displayFont = await readFile(/* turbopackIgnore: true */ fontPath);
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        padding: "58px 64px",
        background: "#070b14",
        color: "#f6f3ee",
        position: "relative",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 28, letterSpacing: -1 }}
      >
        <svg width="38" height="38" viewBox="0 0 32 32" fill="none">
          <path
            d="M5 6h7c6.1 0 10 3.7 10 10s-3.9 10-10 10H5V6Z"
            stroke="#c5d2e0"
            strokeWidth="1.4"
          />
          <path d="M15 26V6h12M15 16h9" stroke="#c5d2e0" strokeWidth="1.4" />
        </svg>
        {siteConfig.name}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 100,
          fontSize: 14,
          letterSpacing: 3,
          color: "#b0bdcc",
        }}
      >
        {shellContent.og.label}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontFamily: "Instrument Serif",
          fontSize: 112,
          lineHeight: 1,
          letterSpacing: -3,
        }}
      >
        {shellContent.og.headline}
      </div>
      <div style={{ display: "flex", marginTop: 32, fontSize: 24, color: "#b9c1cd" }}>
        {shellContent.og.description}
      </div>
      <div
        style={{
          position: "absolute",
          display: "flex",
          bottom: 42,
          left: 64,
          right: 64,
          height: 1,
          background: "#354150",
        }}
      />
      <svg
        width="150"
        height="150"
        viewBox="0 0 150 150"
        fill="none"
        style={{ position: "absolute", right: 64, top: 40 }}
      >
        <path d="M5 25H45L75 75H145M5 75H145M5 125H45L75 75" stroke="#687e94" strokeWidth="1" />
        <rect x="100" y="50" width="48" height="48" stroke="#a9bdcf" strokeWidth="1" />
        <rect x="112" y="62" width="24" height="24" stroke="#a9bdcf" strokeWidth="1" />
      </svg>
    </div>,
    {
      ...size,
      fonts: [{ name: "Instrument Serif", data: displayFont, style: "normal", weight: 400 }],
    },
  );
}
