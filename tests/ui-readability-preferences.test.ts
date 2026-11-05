import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_READABILITY,
  parseReadability,
  READABILITY_BOOTSTRAP,
  READABILITY_STORAGE_KEY,
  resolveReadability,
  TEXT_SIZE_OPTIONS,
} from "@/lib/ui/readability";
import {
  createReadabilityStore,
  SERVER_READABILITY,
  type ReadabilityEnvironment,
} from "@/components/readability/store";

function environment(initial: string | null = null) {
  let saved = initial,
    contrast = false,
    motion = false;
  let listener: ((change: "storage" | "media") => void) | undefined;
  const disconnect = vi.fn();
  const env: ReadabilityEnvironment = {
    read: vi.fn(() => saved),
    write: vi.fn((value: string) => {
      saved = value;
    }),
    deviceContrast: () => contrast,
    reducedMotion: () => motion,
    apply: vi.fn(),
    subscribe: vi.fn((callback) => {
      listener = callback;
      return disconnect;
    }),
  };
  return {
    env,
    disconnect,
    stored: () => saved,
    external: (value: string | null) => {
      saved = value;
      listener?.("storage");
    },
    media: (nextContrast: boolean, nextMotion: boolean) => {
      contrast = nextContrast;
      motion = nextMotion;
      listener?.("media");
    },
  };
}

describe("locally saved presentation preferences", () => {
  it.each([
    null,
    "",
    "{",
    "null",
    "[]",
    "42",
    '{"version":2,"textSize":"large"}',
    '{"version":"1","textSize":"large"}',
  ])("defaults safely for malformed or unsupported storage %s", (input) => {
    expect(parseReadability(input)).toEqual(DEFAULT_READABILITY);
  });
  it("validates fields independently and ignores executable-looking and unrelated input", () => {
    expect(
      parseReadability(
        JSON.stringify({
          version: 1,
          textSize: "<script>evil()</script>",
          highContrast: "yes",
          password: "ignored",
        }),
      ),
    ).toEqual(DEFAULT_READABILITY);
    expect(
      parseReadability(
        '{"version":1,"textSize":"large","highContrast":false,"unused":17}',
      ),
    ).toEqual({ version: 1, textSize: "large", highContrast: false });
  });
  it("round-trips each text size and explicit contrast choice", () => {
    for (const { value } of TEXT_SIZE_OPTIONS)
      for (const contrast of [null, false, true]) {
        const expected = {
          version: 1 as const,
          textSize: value,
          highContrast: contrast,
        };
        expect(parseReadability(JSON.stringify(expected))).toEqual(expected);
      }
  });
  it("follows device contrast until explicitly overridden; reduced motion always follows the device", () => {
    expect(resolveReadability({ ...DEFAULT_READABILITY }, true, true)).toEqual({
      textSize: "default",
      highContrast: true,
      reducedMotion: true,
    });
    expect(
      resolveReadability(
        { ...DEFAULT_READABILITY, highContrast: false },
        true,
        true,
      ),
    ).toEqual({
      textSize: "default",
      highContrast: false,
      reducedMotion: true,
    });
    expect(
      resolveReadability(
        { ...DEFAULT_READABILITY, highContrast: true },
        false,
        false,
      ),
    ).toEqual({
      textSize: "default",
      highContrast: true,
      reducedMotion: false,
    });
  });
  it("persists immediately, applies the whole app state and keeps snapshots stable", () => {
    const platform = environment(),
      store = createReadabilityStore(platform.env),
      changed = vi.fn();
    const unsubscribe = store.subscribe(changed),
      before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.update({ textSize: "extra-large", highContrast: true });
    expect(JSON.parse(platform.stored()!)).toEqual({
      version: 1,
      textSize: "extra-large",
      highContrast: true,
    });
    expect(store.getSnapshot()).toMatchObject({
      preferences: { textSize: "extra-large" },
      highContrast: true,
      persistence: "local",
    });
    expect(platform.env.apply).toHaveBeenLastCalledWith(store.getSnapshot());
    expect(changed).toHaveBeenCalledTimes(1);
    store.update({ textSize: "extra-large", highContrast: true });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getServerSnapshot()).toBe(SERVER_READABILITY);
    unsubscribe();
    expect(platform.disconnect).toHaveBeenCalledOnce();
  });
  it("responds to device changes and cross-tab choices, including reset to system contrast", () => {
    const platform = environment(),
      store = createReadabilityStore(platform.env);
    const unsubscribe = store.subscribe(vi.fn());
    platform.media(true, true);
    expect(store.getSnapshot()).toMatchObject({
      highContrast: true,
      reducedMotion: true,
    });
    store.update({ highContrast: false });
    platform.media(true, false);
    expect(store.getSnapshot()).toMatchObject({
      highContrast: false,
      reducedMotion: false,
    });
    store.update({ highContrast: null });
    expect(store.getSnapshot().highContrast).toBe(true);
    platform.external('{"version":1,"textSize":"small","highContrast":true}');
    expect(store.getSnapshot()).toMatchObject({
      preferences: { textSize: "small", highContrast: true },
      highContrast: true,
    });
    platform.external(null);
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_READABILITY);
    unsubscribe();
  });
  it("keeps an explicit session choice when writes fail and the device preference changes", () => {
    const platform = environment(
      '{"version":1,"textSize":"small","highContrast":null}',
    );
    platform.env.write = () => {
      throw new Error("Quota exceeded");
    };
    const store = createReadabilityStore(platform.env),
      unsubscribe = store.subscribe(vi.fn());
    store.update({ textSize: "large", highContrast: false });
    platform.media(true, true);
    expect(store.getSnapshot()).toMatchObject({
      preferences: { textSize: "large", highContrast: false },
      highContrast: false,
      reducedMotion: true,
      persistence: "session",
    });
    unsubscribe();
  });
  it("continues without storage access and reports session-only persistence", () => {
    const platform = environment();
    platform.env.read = () => {
      throw new Error("Access denied");
    };
    platform.env.write = () => {
      throw new Error("Access denied");
    };
    const store = createReadabilityStore(platform.env),
      unsubscribe = store.subscribe(vi.fn());
    store.update({ textSize: "extra-large" });
    expect(store.getSnapshot()).toMatchObject({
      preferences: { textSize: "extra-large" },
      persistence: "session",
    });
    platform.media(true, false);
    expect(store.getSnapshot()).toMatchObject({
      preferences: { textSize: "extra-large" },
      highContrast: true,
    });
    unsubscribe();
  });
});

describe("before-paint readability bootstrap", () => {
  it.each([
    {
      stored: null,
      contrast: false,
      motion: false,
      text: "default",
      high: false,
    },
    { stored: null, contrast: true, motion: true, text: "default", high: true },
    {
      stored: '{"version":1,"textSize":"extra-large","highContrast":false}',
      contrast: true,
      motion: true,
      text: "extra-large",
      high: false,
    },
    {
      stored: '{"version":1,"textSize":"small","highContrast":true}',
      contrast: false,
      motion: false,
      text: "small",
      high: true,
    },
    {
      stored: '{"version":99,"textSize":"large","highContrast":true}',
      contrast: false,
      motion: true,
      text: "default",
      high: false,
    },
    {
      stored: '{"version":1,"textSize":"<script>evil()</script>"}',
      contrast: true,
      motion: false,
      text: "default",
      high: true,
    },
  ])(
    "independently reconciles initial DOM attributes with the expected saved/device choice: $text/$high",
    ({ stored, contrast, motion, text, high }) => {
      const dataset: Record<string, string> = {},
        read = vi.fn(() => stored);
      runInNewContext(READABILITY_BOOTSTRAP, {
        localStorage: { getItem: read },
        document: { documentElement: { dataset } },
        matchMedia: (query: string) => ({
          matches: query.includes("prefers-contrast") ? contrast : motion,
        }),
      });
      expect(read).toHaveBeenCalledWith(READABILITY_STORAGE_KEY);
      expect(dataset).toEqual({
        textSize: text,
        highContrast: String(high),
        reducedMotion: String(motion),
      });
    },
  );
  it("does not prevent rendering when storage or matchMedia are unavailable", () => {
    const dataset = {};
    expect(() =>
      runInNewContext(READABILITY_BOOTSTRAP, {
        localStorage: {
          getItem: () => {
            throw new Error("Unavailable");
          },
        },
        document: { documentElement: { dataset } },
      }),
    ).not.toThrow();
    expect(dataset).toEqual({
      textSize: "default",
      highContrast: "false",
      reducedMotion: "false",
    });
  });
});
