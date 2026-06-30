import { useEffect, useState } from "react";

// Tailwind-aligned breakpoints. Keep these in sync with tailwind.config.ts if
// the project ever overrides defaults.
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Device = "mobile" | "tablet" | "desktop";

function getDevice(width: number): Device {
  if (width < BREAKPOINTS.md) return "mobile";
  if (width < BREAKPOINTS.lg) return "tablet";
  return "desktop";
}

/**
 * Reactive media-query hook. Re-renders when the query's match state changes.
 * Use sparingly — prefer Tailwind responsive classes when you only need style
 * differences. This is for *behavioral* branching (different components,
 * different handlers).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  };
  const get = () => (typeof window !== "undefined" && window.matchMedia(query).matches);
  const [matches, setMatches] = useState<boolean>(get);
  useEffect(() => {
    setMatches(get());
    return subscribe(() => setMatches(get()));
  }, [query]);
  return matches;
}

/**
 * Returns the current device category. Re-renders on resize/orientation change.
 *
 * Renders `desktop` on the very first paint in SSR-like environments to avoid
 * hydration mismatch — adjust if/when we add SSR.
 */
export function useBreakpoint(): { device: Device; isMobile: boolean; isTablet: boolean; isDesktop: boolean } {
  const [device, setDevice] = useState<Device>(() =>
    typeof window !== "undefined" ? getDevice(window.innerWidth) : "desktop"
  );

  useEffect(() => {
    const handler = () => setDevice(getDevice(window.innerWidth));
    handler();
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("orientationchange", handler);
    };
  }, []);

  return {
    device,
    isMobile: device === "mobile",
    isTablet: device === "tablet",
    isDesktop: device === "desktop",
  };
}

/** True if the user prefers reduced motion (OS-level a11y setting). */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
