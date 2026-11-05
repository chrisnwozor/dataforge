/** Presentation preferences stay in this browser; they never change project data. */
export const READABILITY_STORAGE_KEY = "dataforge.readability";
export const TEXT_SIZE_OPTIONS = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
] as const;
export type TextSize = (typeof TEXT_SIZE_OPTIONS)[number]["value"];
export interface ReadabilityPreferences {
  version: 1;
  textSize: TextSize;
  /** null follows the device until the user makes an explicit choice. */
  highContrast: boolean | null;
}
export const DEFAULT_READABILITY: Readonly<ReadabilityPreferences> = {
  version: 1,
  textSize: "default",
  highContrast: null,
};
export function parseReadability(value: string | null): ReadabilityPreferences {
  if (value === null) return { ...DEFAULT_READABILITY };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1
    )
      return { ...DEFAULT_READABILITY };
    const input = parsed as Record<string, unknown>;
    return {
      version: 1,
      textSize: TEXT_SIZE_OPTIONS.some(
        (option) => option.value === input.textSize,
      )
        ? (input.textSize as TextSize)
        : "default",
      highContrast:
        typeof input.highContrast === "boolean" ? input.highContrast : null,
    };
  } catch {
    return { ...DEFAULT_READABILITY };
  }
}
export function resolveReadability(
  preferences: ReadabilityPreferences,
  deviceContrast: boolean,
  reducedMotion: boolean,
) {
  return {
    textSize: preferences.textSize,
    highContrast: preferences.highContrast ?? deviceContrast,
    reducedMotion,
  };
}

/** Runs before paint. Only validated literals reach data attributes. No HTML is inserted. */
export const READABILITY_BOOTSTRAP = `(function(){var p={version:1,textSize:"default",highContrast:null};try{var v=JSON.parse(localStorage.getItem("${READABILITY_STORAGE_KEY}"));if(v&&v.version===1){if(["small","default","large","extra-large"].indexOf(v.textSize)!==-1)p.textSize=v.textSize;if(typeof v.highContrast==="boolean")p.highContrast=v.highContrast;}}catch(e){}var c=false,m=false;try{c=matchMedia("(prefers-contrast: more)").matches;m=matchMedia("(prefers-reduced-motion: reduce)").matches;}catch(e){}var r=document.documentElement;r.dataset.textSize=p.textSize;r.dataset.highContrast=String(p.highContrast===null?c:p.highContrast);r.dataset.reducedMotion=String(m);})();`;
