import {
  DEFAULT_READABILITY,
  parseReadability,
  resolveReadability,
  type ReadabilityPreferences,
} from "@/lib/ui/readability";

export interface ReadabilityState {
  preferences: ReadabilityPreferences;
  highContrast: boolean;
  reducedMotion: boolean;
  persistence: "local" | "session";
}
export interface ReadabilityEnvironment {
  read(): string | null;
  write(value: string): void;
  deviceContrast(): boolean;
  reducedMotion(): boolean;
  apply(state: ReadabilityState): void;
  subscribe(listener: (change: "storage" | "media") => void): () => void;
}
export const SERVER_READABILITY: ReadabilityState = {
  preferences: { ...DEFAULT_READABILITY },
  highContrast: false,
  reducedMotion: false,
  persistence: "local",
};

/** An injected environment keeps storage/media behavior independently testable. */
export function createReadabilityStore(environment: ReadabilityEnvironment) {
  const listeners = new Set<() => void>();
  let preferences: ReadabilityPreferences;
  let persistence: ReadabilityState["persistence"] = "local";
  try {
    preferences = parseReadability(environment.read());
  } catch {
    preferences = { ...DEFAULT_READABILITY };
    persistence = "session";
  }
  const snapshot = (): ReadabilityState => ({
    preferences,
    highContrast: resolveReadability(
      preferences,
      environment.deviceContrast(),
      environment.reducedMotion(),
    ).highContrast,
    reducedMotion: environment.reducedMotion(),
    persistence,
  });
  let state = snapshot();
  let disconnect: (() => void) | undefined;
  function publish() {
    const next = snapshot();
    environment.apply(next);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  function refresh(change: "storage" | "media") {
    if (change === "storage") {
      // A denied storage API must not undo an explicit in-memory preference.
      try {
        preferences = parseReadability(environment.read());
      } catch {
        persistence = "session";
      }
    }
    publish();
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => SERVER_READABILITY,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        disconnect = environment.subscribe(refresh);
        if (persistence === "local") refresh("storage");
        else publish();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          disconnect?.();
          disconnect = undefined;
        }
      };
    },
    update(
      patch: Partial<Pick<ReadabilityPreferences, "textSize" | "highContrast">>,
    ) {
      preferences = parseReadability(
        JSON.stringify({ ...preferences, ...patch }),
      );
      try {
        environment.write(JSON.stringify(preferences));
        persistence = "local";
      } catch {
        persistence = "session";
      }
      publish();
    },
  };
}
