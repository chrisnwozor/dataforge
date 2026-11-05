"use client";

import { useEffect, useRef, type ReactNode } from "react";

type RevealProps = Readonly<{
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
}>;

/** Server output is fully visible. Motion enhances it only after intersection. */
export function Reveal({ children, className, delay = 0, duration = 0.6 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!element || preference.matches || !("IntersectionObserver" in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        void import("motion/mini").then(({ animate }) => {
          if (disposed || preference.matches) return;
          const animation = animate(
            element,
            { opacity: [0.65, 1], transform: ["translateY(14px)", "translateY(0px)"] },
            { duration, delay, ease: [0.22, 1, 0.36, 1] },
          );
          stop = () => animation.complete();
        });
      },
      { threshold: 0.08 },
    );
    const onPreferenceChange = () => {
      if (preference.matches) stop?.();
    };
    preference.addEventListener("change", onPreferenceChange);
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      stop?.();
      preference.removeEventListener("change", onPreferenceChange);
    };
  }, [delay, duration]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
