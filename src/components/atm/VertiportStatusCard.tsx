import { motion } from "framer-motion";
import { MapPin, ArrowUp, ArrowDown, Timer } from "lucide-react";
import type { VertiportStatusResult } from "@/lib/atmTypes";

interface Props {
  status: VertiportStatusResult;
}

function VertiportSlot({ name, load, ok, type }: { name: string; load: number; ok: boolean; type: "dep" | "arr" }) {
  const Icon = type === "dep" ? ArrowUp : ArrowDown;
  const color = !ok ? "border-red-500/40 bg-red-500/5" : load >= 70 ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5";
  const dotColor = !ok ? "bg-red-400" : load >= 70 ? "bg-amber-400" : "bg-emerald-400";

  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-white/50" />
        <span className="text-[10px] text-white/50 uppercase">{type === "dep" ? "Departure" : "Arrival"}</span>
        <div className={`w-1.5 h-1.5 rounded-full ml-auto ${dotColor}`} />
      </div>
      <p className="text-sm font-semibold text-white truncate">{name}</p>
      <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${load}%` }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className={`h-full rounded-full ${dotColor}`}
        />
      </div>
      <p className="text-[10px] text-white/30 mt-1">{load}% capacity</p>
    </div>
  );
}

export default function VertiportStatusCard({ status }: Props) {
  const hasDelay = status.departure_delay_minutes > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className="rounded-xl border border-white/10 bg-white/5 overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Vertiport Coordination</span>
        <span className={`text-xs font-bold ${hasDelay ? "text-amber-400" : "text-emerald-400"}`}>
          {hasDelay ? `+${status.departure_delay_minutes} MIN DELAY` : "SLOTS CLEAR"}
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <VertiportSlot
            name={status.origin_vertiport.name}
            load={status.origin_vertiport.load_pct}
            ok={status.origin_vertiport.capacity_ok}
            type="dep"
          />
          <VertiportSlot
            name={status.destination_vertiport.name}
            load={status.destination_vertiport.load_pct}
            ok={status.destination_vertiport.capacity_ok}
            type="arr"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <Timer className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">Flight Time</p>
            <p className="text-sm font-bold text-white">{status.flight_time_minutes}m</p>
          </div>
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <MapPin className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">Distance</p>
            <p className="text-sm font-bold text-white">{status.distance_km} km</p>
          </div>
          <div className="bg-black/20 rounded-lg p-2.5 text-center">
            <ArrowDown className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">ETA</p>
            <p className="text-sm font-bold text-white">
              {new Date(status.estimated_arrival_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        </div>

        <p className="text-xs text-white/40 italic">{status.reason}</p>
      </div>
    </motion.div>
  );
}
