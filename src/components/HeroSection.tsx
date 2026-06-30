import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, ArrowDown } from "lucide-react";
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
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden noise">
      {/* Background */}
      <div
        className="absolute inset-0 -z-10"
        style={{ background: "radial-gradient(ellipse 90% 70% at 50% 20%, hsl(5 30% 10%) 0%, hsl(0 0% 4%) 65%)" }}
      />
      <div className="absolute inset-0 -z-10 grid-pattern" />

      {/* Coral horizon glow */}
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-[50vh] -z-10 pointer-events-none"
        style={{ background: "radial-gradient(ellipse at center bottom, hsl(5 72% 50% / 0.06), transparent 65%)" }}
      />

      {/* Status strip */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
        className="absolute top-20 inset-x-0 flex justify-center"
      >
        <div className="flex items-center gap-4 px-4 py-1.5 rounded-full glass-card text-[10px] font-mono tracking-widest text-foreground/45 uppercase">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            System Online
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="tabular-nums text-foreground/60">{clock} UTC</span>
          <span className="w-px h-3 bg-white/10" />
          <span>NYC Metro Airspace</span>
        </div>
      </motion.div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8"
        >
          <Logo size={72} showWordmark={false} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="font-semibold tracking-tight leading-[0.95] text-[clamp(2.8rem,8vw,6.5rem)] max-w-4xl"
        >
          Air traffic,{" "}
          <span className="shimmer-text italic font-light">intelligently managed.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.7 }}
          className="mt-5 max-w-md text-[15px] leading-relaxed text-foreground/48"
        >
          Real-time conflict detection, route optimization, and automated clearance for eVTOL and rotorcraft operations.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55, duration: 0.6 }}
          className="mt-9 flex items-center gap-3"
        >
          <Link
            to="/plan"
            className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_8px_30px_-8px_hsl(5_72%_60%_/_0.5)]"
          >
            Plan a flight
            <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
          </Link>
          <button
            onClick={() => navigate(session ? "/dashboard" : "/auth")}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-white/12 text-foreground/65 text-sm font-medium hover:bg-white/5 hover:text-foreground transition-all"
          >
            {session ? "Open dashboard" : "Sign in"}
          </button>
        </motion.div>
      </div>

      {/* Scroll cue */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 1 }}
        className="absolute bottom-8 inset-x-0 flex flex-col items-center gap-2"
      >
        <motion.div
          animate={{ y: [0, 5, 0] }}
          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
        >
          <ArrowDown className="w-4 h-4 text-foreground/25" />
        </motion.div>
        <span className="text-[9px] font-mono tracking-[0.3em] uppercase text-foreground/25">Live airspace below</span>
      </motion.div>
    </section>
  );
};

export default HeroSection;
