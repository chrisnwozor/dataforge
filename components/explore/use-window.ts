"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { calculateWindow } from "@/lib/explore/virtual";

export function useWindowedRows(count: number, rowHeight = 40, overscan = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(440);
  const [scrollTop, setScrollTop] = useState(0);
  const attachViewport = useCallback((element: HTMLDivElement | null) => { ref.current = element; }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) setViewportHeight(height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const onScroll = useCallback(() => setScrollTop(ref.current?.scrollTop ?? 0), []);
  return { attachViewport, onScroll, ...calculateWindow({ count, scrollTop, viewportHeight, rowHeight, overscan }) };
}
