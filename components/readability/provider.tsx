"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  READABILITY_STORAGE_KEY,
  type ReadabilityPreferences,
} from "@/lib/ui/readability";
import {
  createReadabilityStore,
  SERVER_READABILITY,
  type ReadabilityState,
} from "./store";

type Store = ReturnType<typeof createReadabilityStore>;
let browserStore: Store | undefined;
function media(query: string): MediaQueryList | null {
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}
function store() {
  if (typeof window === "undefined") return null;
  if (!browserStore) {
    const contrast = media("(prefers-contrast: more)"),
      motion = media("(prefers-reduced-motion: reduce)");
    browserStore = createReadabilityStore({
      read: () => window.localStorage.getItem(READABILITY_STORAGE_KEY),
      write: (value) =>
        window.localStorage.setItem(READABILITY_STORAGE_KEY, value),
      deviceContrast: () => contrast?.matches ?? false,
      reducedMotion: () => motion?.matches ?? false,
      apply: (state) => {
        const root = document.documentElement;
        root.dataset.textSize = state.preferences.textSize;
        root.dataset.highContrast = String(state.highContrast);
        root.dataset.reducedMotion = String(state.reducedMotion);
      },
      subscribe: (listener) => {
        const storage = (event: StorageEvent) => {
          if (event.key === READABILITY_STORAGE_KEY || event.key === null)
            listener("storage");
        };
        const mediaChange = () => listener("media");
        window.addEventListener("storage", storage);
        contrast?.addEventListener("change", mediaChange);
        motion?.addEventListener("change", mediaChange);
        return () => {
          window.removeEventListener("storage", storage);
          contrast?.removeEventListener("change", mediaChange);
          motion?.removeEventListener("change", mediaChange);
        };
      },
    });
  }
  return browserStore;
}
const getSnapshot = () => store()?.getSnapshot() ?? SERVER_READABILITY;
const getServerSnapshot = () => SERVER_READABILITY;
const subscribe = (listener: () => void) =>
  store()?.subscribe(listener) ?? (() => {});
const update = (
  patch: Partial<Pick<ReadabilityPreferences, "textSize" | "highContrast">>,
) => store()?.update(patch);
const Context = createContext<ReadabilityState & { update: typeof update }>({
  ...SERVER_READABILITY,
  update,
});

export function ReadabilityProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <Context.Provider value={{ ...state, update }}>{children}</Context.Provider>
  );
}
export const useReadability = () => useContext(Context);
