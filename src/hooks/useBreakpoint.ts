import { useEffect, useState } from "react";

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

/** True if the user prefers reduced motion (OS-level a11y setting). */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
