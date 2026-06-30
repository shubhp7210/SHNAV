import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Radio, Wind, Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";

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
      {/* Deep background */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 90% 65% at 50% 25%, hsl(5 30% 10%) 0%, hsl(0 0% 4%) 65%)",
        }}
      />
      <div className="absolute inset-0 -z-10 grid-pattern" />

      {/* Coral horizon glow */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2.5 }}
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[110%] h-[55vh] -z-10 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center bottom, hsl(5 72% 50% / 0.07), transparent 65%)",
        }}
      />

      {/* Status strip */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.6 }}
        className="absolute top-20 inset-x-0 flex justify-center px-4"
      >
        <div className="flex items-center gap-4 px-4 py-1.5 rounded-full glass-card text-[10px] font-mono tracking-widest text-foreground/50 uppercase">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            System Online
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="tabular-nums text-foreground/65">{clock} UTC</span>
          <span className="w-px h-3 bg-white/10" />
          <span>v2.4 · Build 0512</span>
        </div>
      </motion.div>

      {/* Centerpiece */}
      <div className="relative z-10 flex flex-col items-center px-6 pt-16">
        <motion.div
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8"
        >
          <Logo size={80} showWordmark={false} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="text-center font-semibold tracking-tight leading-[0.95] text-[clamp(2.6rem,7.5vw,6rem)] max-w-4xl"
        >
          The operating system for{" "}
          <span className="shimmer-text italic font-light">low-altitude flight.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.42, duration: 0.7 }}
          className="mt-6 max-w-lg text-center text-[15px] leading-relaxed text-foreground/50"
        >
          SHNAV coordinates eVTOL and rotorcraft traffic in real time —
          predicting conflicts, routing around weather, and clearing flights
          in seconds.
        </motion.p>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.6 }}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            to="/plan"
            className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_8px_30px_-8px_hsl(5_72%_60%_/_0.5)]"
          >
            Plan a flight
            <ArrowUpRight
              className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
              strokeWidth={2.5}
            />
          </Link>
          <button
            onClick={() => navigate(session ? "/dashboard" : "/auth")}
            className="inline-flex items-center gap-2 pl-5 pr-5 py-3 rounded-full border border-white/12 text-foreground/75 text-sm font-medium hover:bg-white/5 hover:text-foreground transition-all"
          >
            {session ? "Open dashboard" : "Sign in"}
          </button>
        </motion.div>

        {/* Telemetry chips */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.82, duration: 0.7 }}
          className="mt-14 grid grid-cols-3 gap-3 sm:gap-5 max-w-2xl w-full"
        >
          {[
            { icon: Radio, label: "Clearance", value: "< 8s", sub: "median latency" },
            { icon: Wind, label: "Weather", value: "Live", sub: "wind · METAR · NOTAM" },
            { icon: Activity, label: "Conflicts", value: "4D", sub: "trajectory analysis" },
          ].map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.92 + i * 0.08 }}
              className="glass-card rounded-2xl p-4 flex flex-col gap-1.5 hover:border-primary/20 transition-colors"
            >
              <div className="flex items-center justify-between">
                <s.icon className="w-3.5 h-3.5 text-primary/70" strokeWidth={2} />
                <span className="text-[9px] font-mono uppercase tracking-widest text-foreground/38">
                  {s.label}
                </span>
              </div>
              <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-foreground/38">
                {s.sub}
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>

      {/* Scroll cue */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.45 }}
        transition={{ delay: 1.6, duration: 1 }}
        className="absolute bottom-6 inset-x-0 flex flex-col items-center gap-2 text-foreground/40"
      >
        <div className="w-px h-8 bg-gradient-to-b from-transparent via-primary/50 to-transparent" />
        <span className="text-[9px] font-mono tracking-[0.3em] uppercase">Scroll</span>
      </motion.div>
    </section>
  );
};

export default HeroSection;
