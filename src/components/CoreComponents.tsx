import { motion } from "framer-motion";
import { UserCheck, Send, Activity, GitBranch, Eye, Shield } from "lucide-react";

const components = [
  {
    icon: UserCheck,
    title: "Vehicle & Operator Registration",
    points: ["Aircraft registration identifier", "Operator authorization", "Performance profiles"],
  },
  {
    icon: Send,
    title: "Flight Intent Submission",
    points: ["Origin, destination & altitude band", "Flexible departure window", "Contingency landing options"],
  },
  {
    icon: Activity,
    title: "Trajectory & Conflict Analysis",
    points: ["4D trajectory modeling (lat, lon, alt, time)", "Conflict probability against live traffic", "Weather & airspace restriction overlay"],
  },
  {
    icon: GitBranch,
    title: "Multi-Option Clearances",
    points: ["Immediate or delayed departure", "Alternate altitude bands", "Auto-transition on delay"],
  },
  {
    icon: Eye,
    title: "Authority Interface",
    points: ["Conflict-evaluated decision options", "Clear constraint definitions", "Read-only assumption visibility"],
  },
  {
    icon: Shield,
    title: "In-Flight Monitoring",
    points: ["Real-time trajectory compliance", "Deviation alerts", "Contingency logic triggers"],
  },
];

const CoreComponents = () => {
  return (
    <section id="overview" className="py-24 relative">
      <div className="absolute inset-0 grid-pattern opacity-20" />
      <div className="container relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-14"
        >
          <span className="text-primary font-mono text-[11px] tracking-[0.25em] uppercase mb-3 block">
            Platform Modules
          </span>
          <h2 className="text-3xl md:text-4xl font-bold mb-3 tracking-tight">
            Every phase of flight, covered.
          </h2>
          <p className="text-foreground/50 text-[15px] leading-relaxed">
            From pre-departure registration to real-time in-flight monitoring — SHNAV handles the full operational loop.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {components.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.07 }}
              className="glass-card rounded-2xl p-6 group hover:border-primary/20 transition-colors"
            >
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                <c.icon className="w-4 h-4 text-primary" strokeWidth={1.75} />
              </div>
              <h3 className="font-semibold text-[14px] mb-3 text-foreground/90">{c.title}</h3>
              <ul className="space-y-1.5">
                {c.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-[13px] text-foreground/50">
                    <span className="w-1 h-1 rounded-full bg-primary/50 flex-shrink-0 mt-1.5" />
                    {p}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default CoreComponents;
