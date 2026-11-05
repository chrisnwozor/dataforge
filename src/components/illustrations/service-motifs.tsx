import type { ReactNode } from "react";

type MotifProps = { kind: string; className?: string };

function Linework({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="120"
      height="96"
      viewBox="0 0 120 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ServiceMotif({ kind, className }: MotifProps) {
  let lines: ReactNode;
  switch (kind) {
    case "cloud-data-engineering":
      lines = (
        <>
          <path d="M16 24h18l18 24h20M16 72h18l18-24M16 48h36" opacity=".55" />
          <path d="M72 32h30v32H72zM79 41h16M79 48h16M79 55h9" />
          <path d="M20 19v10M20 43v10M20 67v10" />
          <circle cx="54" cy="48" r="3" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case "microsoft-azure-data-solutions":
      lines = (
        <>
          <path d="m20 61 40-20 40 20-40 20-40-20ZM20 49l40-20 40 20M20 37l40-20 40 20" />
          <path d="M20 37v24M100 37v24M60 57v24" opacity=".4" />
          <path d="M60 17v-7M100 61v13M20 61v13" strokeDasharray="2 4" />
        </>
      );
      break;
    case "data-integration-and-automation":
      lines = (
        <>
          <path d="M13 29h26v38H13zM81 29h26v38H81zM20 38h12M20 46h12M20 54h7M88 38h12M88 46h12M88 54h7" />
          <path d="M39 40h18c9 0 8-15 17-15h7M81 56H63c-9 0-8 15-17 15h-7" opacity=".65" />
          <path d="m74 20 7 5-7 5M46 66l-7 5 7 5" />
          <path d="M50 48h20" strokeDasharray="2 5" opacity=".4" />
        </>
      );
      break;
    case "data-warehousing-and-architecture":
      lines = (
        <>
          <path d="M43 31h34v34H43zM17 16h16v16H17zM87 16h16v16H87zM17 64h16v16H17zM87 64h16v16H87z" />
          <path
            d="m33 24 10 13M87 24 77 37M33 72l10-13M87 72 77 59M49 41h22M49 48h22M49 55h13"
            opacity=".55"
          />
        </>
      );
      break;
    case "business-intelligence-and-power-bi":
      lines = (
        <>
          <path d="M18 19v58h88M33 67V53h13v14M55 67V39h13v28M77 67V27h13v40" />
          <path d="m28 42 27-16 24 3 22-16" opacity=".55" />
          <circle cx="55" cy="26" r="2.5" fill="currentColor" stroke="none" />
          <path d="M18 19h88" strokeDasharray="2 5" opacity=".25" />
        </>
      );
      break;
    default:
      lines = (
        <>
          <path d="M15 27h29l16 21h41M15 48h45M15 69h29l16-21" opacity=".55" />
          <path d="M77 34h26v28H77zM84 48l5 5 8-10M60 48v31h18" />
          <path d="M85 74v10M81 79h8" opacity=".55" />
          <circle cx="29" cy="27" r="2" fill="currentColor" stroke="none" />
          <circle cx="29" cy="48" r="2" fill="currentColor" stroke="none" />
          <circle cx="29" cy="69" r="2" fill="currentColor" stroke="none" />
        </>
      );
  }
  return <Linework className={className}>{lines}</Linework>;
}

export function IndustryMotif({ kind, className }: MotifProps) {
  let lines: ReactNode;
  switch (kind) {
    case "retail-and-ecommerce":
      lines = (
        <>
          <path d="M18 24h22v22H18zM49 24h22v22H49zM80 24h22v22H80zM49 57h22v22H49z" />
          <path d="M29 46v22h20M91 46v22H71M60 46v11" opacity=".5" />
          <path d="M24 33h10M55 33h10M86 33h10M55 66h10" opacity=".5" />
        </>
      );
      break;
    case "logistics-and-operations":
      lines = (
        <>
          <path d="M16 26h30v44h30V26h28M16 48h88" opacity=".5" />
          <path
            d="M11 21h10v10H11zM41 65h10v10H41zM71 43h10v10H71zM99 21h10v10H99z"
            fill="var(--surface)"
          />
          <path d="m95 43 9 5-9 5" />
        </>
      );
      break;
    case "financial-services":
      lines = (
        <>
          <path d="M22 17h76v62H22zM22 34h76M46 34v45M72 34v45" />
          <path
            d="M30 45h8M54 45h10M80 45h10M30 56h8M54 56h10M80 56h10M30 67h8M54 67h10M80 67h10"
            opacity=".5"
          />
          <path d="M31 25h22" />
        </>
      );
      break;
    default:
      lines = (
        <>
          <path d="M16 24h27c22 0 15 24 37 24h23M16 48h87M16 72h27c22 0 15-24 37-24" opacity=".6" />
          <path d="M12 19h10v10H12zM12 43h10v10H12zM12 67h10v10H12zM91 37h17v22H91z" />
          <path d="M51 18v60" strokeDasharray="2 5" opacity=".3" />
        </>
      );
  }
  return <Linework className={className}>{lines}</Linework>;
}
