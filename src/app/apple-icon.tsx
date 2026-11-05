import { ImageResponse } from "next/og";
import { shellContent } from "@/content/site";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";
export const alt = shellContent.iconAlt;

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        background: "#070b14",
      }}
    >
      <svg width="112" height="112" viewBox="0 0 32 32" fill="none">
        <path d="M5 6h7c6.1 0 10 3.7 10 10s-3.9 10-10 10H5V6Z" stroke="#c5d2e0" strokeWidth="1.2" />
        <path d="M15 26V6h12M15 16h9" stroke="#c5d2e0" strokeWidth="1.2" />
      </svg>
    </div>,
    size,
  );
}
