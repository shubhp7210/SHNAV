import { motion } from "framer-motion";
import { Activity, Wind, Zap, UserCheck, Send, GitBranch, Radar, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";

const CAPABILITIES = [
  {
    icon: Activity,
    code: "CNF",
    title: "Catches conflicts before takeoff",
    body: "Every planned path is checked against other flights by position, altitude band and time window — so separation problems are found on the ground, not in the air.",
  },
  {
    icon: Wind,
    code: "WX",
    title: "Routes around weather, not through it",
    body: "Live wind, gusts, precipitation and visibility feed every route. Crosswind drift is estimated per corridor, and risky corridors are scored down automatically.",
  },
  {
    icon: Zap,
    code: "DCN",
    title: "One clear decision",
    body: "Go, hold or take an alternate. The decision engine weighs traffic, weather, airspace load, vertiport capacity and your own flight history.",
  },
];

const WORKFLOW = [
  { icon: UserCheck, step: "01", title: "Register", body: "Operator and aircraft are registered once and pre-filled after sign-in." },
  { icon: Send, step: "02", title: "File intent", body: "Origin, destination and a departure window of up to 10 minutes." },
  { icon: GitBranch, step: "03", title: "Clearance", body: "Trajectory, weather, airspace, vertiport and route engines run in parallel." },
  { icon: Radar, step: "04", title: "Monitor", body: "3D tracking with deviation alerts; landing feeds the learning loop." },
];

export default function CapabilitiesSection() {
  return (
    <section className="relative py-24 sm:py-32 grid-pattern">
      <div className="container max-w-6xl mx-auto px-5 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          className="max-w-2xl mb-14"
        >
          <p className="label-caps text-primary/90 mb-3 flex items-center gap-2">
            <span className="inline-block w-6 h-px bg-primary" /> What it does
          </p>
          <h2 className="text-3xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
            Serious tools for a new kind of airspace.
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-4">
          {CAPABILITIES.map((item, i) => (
            <motion.article
              key={item.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.08 }}
              className="panel rounded-2xl p-6 sm:p-7 flex flex-col gap-5 group hover:border-primary/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <item.icon className="w-5 h-5 text-primary" strokeWidth={1.75} />
                </div>
                <span className="font-mono text-[11px] tracking-[0.2em] text-foreground/30 group-hover:text-primary/70 transition-colors">{item.code}</span>
              </div>
              <h3 className="text-lg font-semibold leading-snug">{item.title}</h3>
              <p className="text-sm text-foreground/60 leading-relaxed flex-1">{item.body}</p>
            </motion.article>
          ))}
        </div>

        {/* Workflow strip — mirrors the real flight-plan steps */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          className="mt-20"
        >
          <p className="label-caps mb-6">From filing to landing</p>
          <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-border bg-border">
            {WORKFLOW.map((w) => (
              <li key={w.step} className="bg-card p-6 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-primary tabular">{w.step}</span>
                  <w.icon className="w-4 h-4 text-signal" strokeWidth={1.75} />
                </div>
                <p className="font-display text-base font-semibold">{w.title}</p>
                <p className="text-[13px] text-foreground/55 leading-relaxed">{w.body}</p>
              </li>
            ))}
          </ol>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2 }}
          className="mt-14 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 panel rounded-2xl p-6 sm:p-8"
        >
          <div>
            <p className="font-display text-xl sm:text-2xl font-semibold">Ready to file your first flight?</p>
            <p className="text-sm text-foreground/55 mt-1">Clearance analysis runs in seconds. Decision support only — not an operational ATC clearance.</p>
          </div>
          <Link
            to="/plan"
            className="group shrink-0 inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition shadow-[0_10px_40px_-12px_hsl(var(--primary)/0.7)]"
          >
            Get started
            <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
