"use client";

import { useEffect, useState } from "react";

/**
 * Returns true while the viewport matches `(max-width: 768px)`.
 *
 * Mirrors the same hook used inside CardDrawer — kept here so multiple
 * components can share a single source of truth without duplicating the
 * matchMedia plumbing.
 */
export function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setM(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return m;
}
