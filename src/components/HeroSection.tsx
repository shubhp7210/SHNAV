import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";

const HeroSection = () => {
  const { session } = useAuth();
  const navigate = useNavigate();

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-background" />

      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8"
        >
          <Logo size={72} showWordmark={false} />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="font-semibold tracking-tight leading-[0.95] text-[clamp(2.8rem,8vw,6.5rem)] max-w-4xl"
        >
          Air traffic control{" "}
          <span className="text-primary italic font-light">for the urban sky.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.6 }}
          className="mt-8 max-w-md text-base text-foreground/50"
        >
          We keep eVTOL and rotorcraft operations moving safely — spotting conflicts, optimizing routes, and issuing clearances before a problem has a chance to form.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="mt-10 flex items-center gap-4"
        >
          <Link
            to="/plan"
            className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Plan a flight
            <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
          </Link>
          <button
            onClick={() => navigate(session ? "/dashboard" : "/auth")}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-full border border-white/12 text-foreground/65 text-sm font-medium hover:bg-white/5 hover:text-foreground transition-colors"
          >
            {session ? "Open dashboard" : "Sign in"}
          </button>
        </motion.div>
      </div>
    </section>
  );
};

export default HeroSection;
