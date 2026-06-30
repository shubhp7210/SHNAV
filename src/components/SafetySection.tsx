import { motion } from "framer-motion";
import { ShieldCheck, Lock, FileCheck, Eye } from "lucide-react";

const items = [
  { icon: ShieldCheck, text: "Respects existing airspace classifications" },
  { icon: Lock, text: "Supports controlled and uncontrolled environments" },
  { icon: FileCheck, text: "Defers final separation authority to regulators and ATC" },
  { icon: Eye, text: "All thresholds conservative, transparent, and auditable" },
];

const SafetySection = () => {
  return (
    <section className="py-24 relative">
      <div className="container">
        <div className="glass-card rounded-xl p-8 md:p-12 glow-primary">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <span className="text-primary font-mono text-sm tracking-widest uppercase mb-4 block">
              Safety & Regulatory Alignment
            </span>
            <h2 className="text-3xl md:text-4xl font-bold mb-8 max-w-xl">
              Designed to fail safely by default
            </h2>

            <div className="grid sm:grid-cols-2 gap-5">
              {items.map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                  className="flex items-start gap-3"
                >
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <item.icon className="w-4 h-4 text-primary" />
                  </div>
                  <p className="text-foreground">{item.text}</p>
                </motion.div>
              ))}
            </div>

            <div className="mt-10 pt-8 border-t border-border/50">
              <p className="text-muted-foreground text-sm max-w-xl">
                No re-routing occurs without explicit authorization. Altos is designed to support — not replace — human decision-making in safety-critical operations.
              </p>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default SafetySection;
