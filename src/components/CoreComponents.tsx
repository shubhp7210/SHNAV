import { motion } from "framer-motion";
import { UserCheck, Send, Activity, GitBranch, Eye, Shield } from "lucide-react";

const components = [
  {
    icon: UserCheck,
    title: "Vehicle & Operator Registration",
    points: ["Aircraft registration identifier (visual & digital)", "Operator authorization", "Aircraft performance profiles"],
  },
  {
    icon: Send,
    title: "Flight Intent Submission",
    points: ["Origin and destination", "Requested altitude band(s)", "Flexible departure time window", "Contingency landing options"],
  },
  {
    icon: Activity,
    title: "Trajectory Simulation & Conflict Analysis",
    points: ["4D trajectory modeling (lat, lon, alt, time)", "Conflict probability against other intents", "Weather & airspace restriction analysis"],
  },
  {
    icon: GitBranch,
    title: "Multi-Option Clearances",
    points: ["Immediate or delayed departure", "Alternate altitude bands", "Alternate corridors", "Auto-transition on delay"],
  },
  {
    icon: Eye,
    title: "Authority Interface",
    points: ["Structured, conflict-evaluated options", "Clear constraint definitions", "Read-only visibility into assumptions"],
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
      <div className="absolute inset-0 grid-pattern opacity-15" />
      <div className="container relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-16"
        >
          <span className="text-primary font-mono text-sm tracking-widest uppercase mb-4 block">
            Platform Modules
          </span>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Six integrated modules for safe, efficient operations
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {components.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="glass-card rounded-lg p-6 hover:glow-primary transition-shadow duration-500 group"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
                  <c.icon className="w-5 h-5 text-primary" />
                </div>
              </div>
              <h3 className="font-semibold text-lg mb-3">{c.title}</h3>
              <ul className="space-y-2">
                {c.points.map((p) => (
                  <li key={p} className="text-sm text-muted-foreground flex items-start gap-2">
                    <span className="w-1 h-1 rounded-full bg-primary mt-2 shrink-0" />
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
