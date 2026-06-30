import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Radio, Wind, Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";

/**
 * Immersive, app-like hero. Full-bleed, no traditional header/CTAs.
 * Built around the ALTOS wordmark and a live status strip — feels like booting an app.
 */
const HeroSection = () => {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden noise">
      {/* Layered atmospheric background */}
      <div
        className="absolute inset-0 -z-10"
        style={{ background: "radial-gradient(ellipse 80% 60% at 50% 30%, hsl(0 0% 12%) 0%, hsl(0 0% 3%) 70%)" }}
      />
      <div className="absolute inset-0 -z-10 grid-pattern opacity-50" />

      {/* Soft horizon glow */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.7 }}
        transition={{ duration: 2 }}
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[120%] h-[60vh] -z-10 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center bottom, hsl(0 0% 100% / 0.08), transparent 60%)",
        }}
      />

      {/* Top status strip — feels like a system bar */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
        className="absolute top-20 inset-x-0 flex justify-center px-4"
      >
        <div className="flex items-center gap-4 px-4 py-1.5 rounded-full glass-card text-[10px] font-mono tracking-widest text-foreground/55 uppercase">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            System Online
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="tabular-nums text-foreground/70">{clock} UTC</span>
          <span className="w-px h-3 bg-white/10" />
          <span>v2.4 · Build 0512</span>
        </div>
      </motion.div>

      {/* Centerpiece */}
      <div className="relative z-10 flex flex-col items-center px-6 pt-20">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8"
        >
          <Logo size={88} showWordmark={false} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="text-center font-display font-semibold tracking-tightest leading-[0.95] text-[clamp(2.75rem,8vw,6.5rem)] max-w-5xl"
        >
          The operating system for{" "}
          <span className="shimmer-text italic font-light">low-altitude flight.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.7 }}
          className="mt-7 max-w-xl text-center text-[15px] leading-relaxed text-foreground/55"
        >
          ALTOS coordinates eVTOL and rotorcraft traffic in real time —
          predicting conflicts, routing around weather, and clearing flights
          in seconds, not hours.
        </motion.p>

        {/* Primary actions */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.65, duration: 0.6 }}
          className="mt-10 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            to="/plan"
            className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_8px_30px_-8px_rgba(255,255,255,0.3)]"
          >
            Plan a flight
            <ArrowUpRight
              className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              strokeWidth={2.5}
            />
          </Link>
          <button
            onClick={() => navigate(session ? "/dashboard" : "/auth")}
            className="inline-flex items-center gap-2 pl-5 pr-5 py-3 rounded-full border border-white/10 text-foreground/85 text-sm font-medium hover:bg-white/5 transition-colors"
          >
            {session ? "Open dashboard" : "Sign in"}
          </button>
        </motion.div>

        {/* Live telemetry chip strip */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.85, duration: 0.7 }}
          className="mt-16 grid grid-cols-3 gap-3 sm:gap-6 max-w-2xl w-full"
        >
          {[
            { icon: Radio, label: "Clearance", value: "< 8s", sub: "median latency" },
            { icon: Wind, label: "Weather", value: "Live", sub: "wind / METAR / NOTAM" },
            { icon: Activity, label: "Conflicts", value: "4D", sub: "trajectory analysis" },
          ].map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.95 + i * 0.08 }}
              className="glass-card rounded-2xl p-4 flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between">
                <s.icon className="w-3.5 h-3.5 text-foreground/55" strokeWidth={2} />
                <span className="text-[9px] font-mono uppercase tracking-widest text-foreground/40">
                  {s.label}
                </span>
              </div>
              <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-foreground/40">
                {s.sub}
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>

      {/* Scroll cue */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ delay: 1.6, duration: 1 }}
        className="absolute bottom-6 inset-x-0 flex flex-col items-center gap-2 text-foreground/40"
      >
        <div className="w-px h-8 bg-gradient-to-b from-transparent via-foreground/40 to-transparent animate-pulse" />
        <span className="text-[9px] font-mono tracking-[0.3em] uppercase">Scroll</span>
      </motion.div>
    </section>
  );
};

export default HeroSection;
