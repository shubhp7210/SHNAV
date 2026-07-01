import { motion } from "framer-motion";
import { Activity, Wind, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";

const ITEMS = [
  {
    icon: Activity,
    title: "Catches conflicts before takeoff",
    body: "Before your aircraft leaves the ground, we've already checked its path against every other flight in the air — by position, altitude, and time.",
  },
  {
    icon: Wind,
    title: "Routes around weather, not through it",
    body: "We pull live conditions and factor wind drift into every route. If a corridor looks risky, we find a better one automatically.",
  },
  {
    icon: Zap,
    title: "A clear decision in under 8 seconds",
    body: "Go, hold, or take an alternate — you get an answer fast. We factor in traffic, weather, airspace load, and your flight history to get there.",
  },
];

export default function CapabilitiesSection() {
  return (
    <section className="py-32 relative">
      <div className="container max-w-5xl mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="text-primary font-mono text-[11px] tracking-[0.25em] uppercase mb-3 block">
            What it does
          </span>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
            Serious tools for a new kind of airspace.
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-px bg-border/30 rounded-2xl overflow-hidden">
          {ITEMS.map((item, i) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="bg-background p-8 flex flex-col gap-5"
            >
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <item.icon className="w-5 h-5 text-primary" strokeWidth={1.75} />
              </div>
              <h3 className="text-base font-semibold">{item.title}</h3>
              <p className="text-sm text-foreground/50 flex-1">{item.body}</p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4 }}
          className="flex justify-center mt-12"
        >
          <Link
            to="/plan"
            className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_8px_30px_-8px_hsl(5_72%_60%_/_0.45)]"
          >
            Get started
            <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
