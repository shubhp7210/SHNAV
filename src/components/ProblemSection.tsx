import { motion } from "framer-motion";
import { AlertTriangle, Clock, Radio, Layers } from "lucide-react";

const problems = [
  { icon: Clock, title: "Fixed Departure Times", desc: "Rigid scheduling creates cascading delays across operations" },
  { icon: Layers, title: "Single-Slot Clearances", desc: "No fallback options when minor deviations occur" },
  { icon: Radio, title: "Manual Re-coordination", desc: "High communication burden on ATC and operators" },
  { icon: AlertTriangle, title: "Inefficient Airspace Use", desc: "Available capacity wasted by overly conservative slots" },
];

const ProblemSection = () => {
  return (
    <section className="py-24 relative">
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-16"
        >
          <span className="text-accent font-mono text-sm tracking-widest uppercase mb-4 block">
            The Challenge
          </span>
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Current systems weren't built for urban air mobility
          </h2>
          <p className="text-muted-foreground text-lg">
            Legacy airspace coordination relies on mechanisms that create unnecessary workload, delays, and communication overhead — poorly suited to high-frequency operations.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-5">
          {problems.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="glass-card rounded-lg p-6 flex gap-4 group hover:border-accent/30 transition-colors"
            >
              <div className="shrink-0 w-10 h-10 rounded-md bg-accent/10 flex items-center justify-center">
                <p.icon className="w-5 h-5 text-accent" />
              </div>
              <div>
                <h3 className="font-semibold text-lg mb-1">{p.title}</h3>
                <p className="text-muted-foreground text-sm">{p.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ProblemSection;
