import { ImageResponse } from "next/og";
import { shellContent } from "@/content/site";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";
export const alt = shellContent.iconAlt;

export default function Icon() {
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
      <svg width="340" height="340" viewBox="0 0 32 32" fill="none">
        <path d="M5 6h7c6.1 0 10 3.7 10 10s-3.9 10-10 10H5V6Z" stroke="#c5d2e0" strokeWidth="1.1" />
        <path d="M15 26V6h12M15 16h9" stroke="#c5d2e0" strokeWidth="1.1" />
      </svg>
    </div>,
    size,
  );
}
