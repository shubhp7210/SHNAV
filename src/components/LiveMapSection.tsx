import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import MapView, { type Pt } from "@/components/MapView";

const FLIGHT_COLOR = "#FF3157"; // coral-red (premium palette)

// Demo flights over Manhattan ([lng, lat]). The homepage always opens on NYC —
// no geolocation prompt on the landing page.
const DEMO_ROUTES: Pt[][] = [
  { origin: [-74.013, 40.706], dest: [-73.944, 40.803] },
  { origin: [-73.986, 40.757], dest: [-74.044, 40.685] },
  { origin: [-73.935, 40.730], dest: [-73.993, 40.768] },
  { origin: [-73.960, 40.780], dest: [-73.997, 40.720] },
].map((f) => [
  { lat: f.origin[1], lng: f.origin[0] },
  { lat: f.dest[1], lng: f.dest[0] },
]);

// Tilted view looking north over Midtown, demo routes in frame. Camera sits
// south of the target so the -48° pitch lands on Manhattan.
const NYC_VIEW = { lat: 40.672, lng: -73.985, height: 9_000, heading: 0, pitch: -48 };

export default function LiveMapSection() {
  const navigate = useNavigate();

  return (
    <section className="relative w-full overflow-hidden" style={{ height: "100vh", minHeight: "600px" }}>
      <MapView routes={DEMO_ROUTES} initialView={NYC_VIEW} animate rotate interactive color={FLIGHT_COLOR} label="Live airspace" />

      {/* Live badge */}
      <motion.div
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
        className="absolute top-6 left-5 z-10"
      >
        <div className="flex items-center gap-2 bg-zinc-950 border border-white/10 rounded-xl px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] font-bold font-mono text-white/80 tracking-widest">LIVE AIRSPACE</span>
        </div>
      </motion.div>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.5 }}
        className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3 z-10 px-4"
      >
        <p className="text-[11px] font-mono text-white/30 tracking-widest uppercase">
          Drag to explore the airspace
        </p>
        <button
          onClick={() => navigate("/plan?test=map")}
          className="group inline-flex items-center gap-2 pl-5 pr-4 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          Try the full simulation
          <ArrowUpRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2.5} />
        </button>
      </motion.div>
    </section>
  );
}
