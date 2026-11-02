import { motion } from "framer-motion";
import { MapPin, ArrowUp, ArrowDown, Timer } from "lucide-react";
import type { VertiportStatusResult } from "@/lib/atmTypes";

interface Props {
  status: VertiportStatusResult;
}

function VertiportSlot({ name, load, ok, type, checked = true }: { name: string; load: number; ok: boolean; type: "dep" | "arr"; checked?: boolean }) {
  const Icon = type === "dep" ? ArrowUp : ArrowDown;
  if (!checked) {
    return (
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-3.5 h-3.5 text-white/50" />
          <span className="text-[10px] text-white/50 uppercase">{type === "dep" ? "Departure" : "Arrival"}</span>
        </div>
        <p className="text-sm font-semibold text-white/70">{name}</p>
        <p className="text-[10px] text-white/40 mt-2">Pad capacity not checked</p>
      </div>
    );
  }
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
      className="panel rounded-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <span className="label-caps text-foreground/75">Vertiport Coordination</span>
        <span className={`text-xs font-bold ${hasDelay ? "text-amber-400" : "text-emerald-400"}`}>
          {status.reserved === false ? "NO SLOT ≤60 MIN" : hasDelay ? `+${status.departure_delay_minutes} MIN DELAY` : "SLOTS RESERVED"}
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <VertiportSlot
            name={status.origin_vertiport.name}
            load={status.origin_vertiport.load_pct}
            ok={status.origin_vertiport.capacity_ok}
            checked={status.origin_vertiport.checked !== false}
            type="dep"
          />
          <VertiportSlot
            name={status.destination_vertiport.name}
            load={status.destination_vertiport.load_pct}
            ok={status.destination_vertiport.capacity_ok}
            checked={status.destination_vertiport.checked !== false}
            type="arr"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="well rounded-lg p-2.5 text-center">
            <Timer className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">Flight Time</p>
            <p className="text-sm font-bold text-white">{status.flight_time_minutes}m</p>
          </div>
          <div className="well rounded-lg p-2.5 text-center">
            <MapPin className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">Distance</p>
            <p className="text-sm font-bold text-white">{status.distance_km != null ? `${status.distance_km} km` : "—"}</p>
          </div>
          <div className="well rounded-lg p-2.5 text-center">
            <ArrowDown className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
            <p className="text-[10px] text-white/40">ETA</p>
            <p className="text-sm font-bold text-white">
              {new Date(status.estimated_arrival_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        </div>

        <p className="text-xs text-white/40 italic">{status.reason}</p>
        {status.capacity_source && (
          <p className="text-[10px] font-mono text-white/30">Pad capacities are {status.capacity_source}.</p>
        )}
      </div>
    </motion.div>
  );
}
