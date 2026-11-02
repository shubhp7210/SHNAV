import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Play } from "lucide-react";
import MapView from "@/components/MapView";
import { useAuth } from "@/contexts/AuthContext";
import { MANHATTAN, MANHATTAN_VIEW, type Pt } from "@/lib/geo/region";

// Real Manhattan-area heliport / vertiport coordinates. These legs are a
// clearly-labeled SIMULATION used only for the ambient homepage view.
const HELIPORTS = {
  downtown: { lat: 40.7011, lng: -74.0090 },  // Downtown Manhattan Heliport
  e34: { lat: 40.7425, lng: -73.9717 },       // East 34th Street Heliport
  w30: { lat: 40.7543, lng: -74.0070 },       // West 30th Street Heliport
  randalls: { lat: 40.7932, lng: -73.9213 },  // Randall's Island
  lga: { lat: 40.7769, lng: -73.8740 },       // LaGuardia
  hoboken: { lat: 40.7359, lng: -74.0275 },   // Hoboken waterfront
} satisfies Record<string, Pt>;

const DEMO_ROUTES: Pt[][] = [
  [HELIPORTS.downtown, HELIPORTS.e34],
  [HELIPORTS.w30, HELIPORTS.randalls],
  [HELIPORTS.e34, HELIPORTS.lga],
  [HELIPORTS.hoboken, HELIPORTS.downtown],
  [HELIPORTS.randalls, HELIPORTS.w30],
];

const fmtCoord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;

function useUtcClock(): string {
  const [t, setT] = useState("");
  useEffect(() => {
    const tick = () => setT(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

const ease = [0.22, 1, 0.36, 1] as const;

/** Homepage hero: full-bleed 3D Manhattan with the headline over it. */
// Touch devices: the hero map is ambient (a one-finger drag would otherwise
// trap page scrolling); pointer devices can orbit it.
const COARSE = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export default function LiveMapSection() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const utc = useUtcClock();

  return (
    <section className="relative w-full overflow-hidden h-[100svh] min-h-[640px]">
      <MapView
        routes={DEMO_ROUTES}
        initialView={MANHATTAN_VIEW}
        animate
        rotate
        interactive={!COARSE}
        wheelZoom={false}
        label="3D map of Manhattan airspace with simulated traffic"
      />
      <div className="absolute inset-0 pointer-events-none map-vignette" />

      {/* Instrument strip — top right, under the dock */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.4, ease }}
        className="absolute top-20 right-4 sm:right-6 z-10 pointer-events-none hidden sm:flex flex-col items-end gap-2"
      >
        <div className="glass-panel rounded-xl px-3.5 py-2.5 text-right">
          <p className="label-caps">Sector · Manhattan, NY</p>
          <p className="font-mono text-xs text-foreground/85 tabular mt-1">
            {fmtCoord(MANHATTAN.lat, "N", "S")} {fmtCoord(MANHATTAN.lng, "E", "W")}
          </p>
          <p className="font-mono text-xs text-signal tabular mt-0.5">{utc} UTC</p>
        </div>
        <div className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-caution" />
          <span className="font-mono text-[10px] tracking-[0.18em] text-foreground/70">SIMULATED TRAFFIC · {DEMO_ROUTES.length} LEGS</span>
        </div>
      </motion.div>

      {/* Headline + actions — bottom left */}
      <div className="absolute inset-x-0 bottom-0 z-10 pointer-events-none">
        <div className="container px-5 sm:px-8 pb-16 sm:pb-20">
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1, ease }}
            className="label-caps text-primary/90 mb-4 flex items-center gap-2"
          >
            <span className="inline-block w-6 h-px bg-primary" />
            Urban air traffic management
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15, ease }}
            className="font-display font-semibold leading-[0.95] tracking-tight text-[clamp(2.6rem,7vw,5.75rem)] max-w-4xl text-balance drop-shadow-[0_4px_24px_hsl(222_60%_2%/0.8)]"
          >
            Air traffic control<br className="hidden sm:block" /> for the <span className="text-primary">urban sky.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-6 max-w-lg text-[15px] sm:text-base text-foreground/70 leading-relaxed"
          >
            SHNAV checks every eVTOL and rotorcraft flight against live traffic, weather and airspace load —
            then issues a clear go, hold or reroute before the aircraft leaves the pad.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.45 }}
            className="mt-8 flex flex-wrap items-center gap-3 pointer-events-auto"
          >
            <Link
              to="/plan"
              className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition shadow-[0_10px_40px_-10px_hsl(var(--primary)/0.7)]"
            >
              Plan a flight
              <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
            </Link>
            <button
              onClick={() => navigate(session ? "/dashboard" : "/auth")}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full glass-panel text-foreground/85 text-sm font-medium hover:text-foreground hover:border-white/20 transition-colors"
            >
              {session ? "Open operations" : "Sign in"}
            </button>
            <Link
              to="/plan?test=map"
              className="inline-flex items-center gap-2 px-3 py-3 text-sm font-medium text-foreground/70 hover:text-foreground transition-colors"
            >
              <Play className="w-3.5 h-3.5 text-signal" fill="currentColor" /> Watch a simulated flight
            </Link>
          </motion.div>
        </div>
      </div>

      {/* Legend + scroll cue */}
      <div className="absolute bottom-5 right-4 sm:right-6 z-10 pointer-events-none hidden md:flex items-center gap-4 glass-panel rounded-full px-4 py-2">
        <span className="flex items-center gap-1.5 text-[11px] text-foreground/70"><span className="w-3 h-0.5 rounded bg-primary" />Lead flight</span>
        <span className="flex items-center gap-1.5 text-[11px] text-foreground/70"><span className="w-3 h-0.5 rounded bg-signal" />Traffic</span>
        <span className="text-[11px] text-foreground/45">Drag to orbit · right-drag to zoom</span>
      </div>
      <ChevronDown className="absolute bottom-4 left-1/2 -translate-x-1/2 w-5 h-5 text-foreground/40 animate-bounce pointer-events-none md:hidden" />
    </section>
  );
}
