import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "react-router-dom";
import { ReactNode } from "react";
import { useReducedMotion } from "@/hooks/useBreakpoint";

interface Props {
  children: ReactNode;
}

/**
 * App-like route transitions. Pages fade + lift slightly when navigating.
 * Honors `prefers-reduced-motion`: users who request reduced motion get an
 * instant cross-fade with no translation.
 */
export default function PageTransition({ children }: Props) {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  // Reduced-motion: skip the y translation entirely, keep a tiny opacity fade
  // so the user still gets a hint that the page changed.
  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 };
  const animate = reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 };
  const exit = reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 };
  const duration = reduceMotion ? 0.15 : 0.35;
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
