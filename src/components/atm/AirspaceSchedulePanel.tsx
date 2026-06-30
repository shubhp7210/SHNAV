import { motion } from "framer-motion";
import { Layers, Clock, Users } from "lucide-react";
import type { AirspaceScheduleResult } from "@/lib/atmTypes";

interface Props {
  schedule: AirspaceScheduleResult;
}

export default function AirspaceSchedulePanel({ schedule }: Props) {
  const loadColor = schedule.load_percentage >= 80 ? "text-red-400" : schedule.load_percentage >= 60 ? "text-amber-400" : "text-emerald-400";
  const barColor = schedule.load_percentage >= 80 ? "bg-red-500" : schedule.load_percentage >= 60 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="rounded-xl border border-white/10 bg-white/5 overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">Airspace Schedule</span>
        <span className={`text-xs font-bold ${schedule.allocated ? "text-emerald-400" : "text-amber-400"}`}>
          {schedule.allocated ? "SLOT ALLOCATED" : "DELAYED"}
        </span>
      </div>

      <div className="p-5 space-y-4">
        {/* Segment info */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
            <Layers className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{schedule.segment_name}</p>
            <p className="text-xs text-white/40">Priority: {schedule.priority === 100 ? "Emergency" : schedule.priority >= 80 ? "Tier 1" : schedule.priority >= 60 ? "Tier 2" : "Standard"}</p>
          </div>
        </div>

        {/* Capacity bar */}
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-white/40 flex items-center gap-1"><Users className="w-3 h-3" /> Segment Load</span>
            <span className={`font-bold ${loadColor}`}>{schedule.load_percentage}%</span>
          </div>
          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${schedule.load_percentage}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className={`h-full rounded-full ${barColor}`}
            />
          </div>
          <div className="flex justify-between text-[10px] text-white/25 mt-1">
            <span>{schedule.segment_load} active</span>
            <span>{schedule.segment_capacity}/hr capacity</span>
          </div>
        </div>

        {/* Allocated time */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-black/20 rounded-lg p-3">
            <p className="text-[10px] text-white/40 mb-1 flex items-center gap-1"><Clock className="w-3 h-3" /> Allocated Slot</p>
            <p className="text-sm font-bold text-white">
              {new Date(schedule.allocated_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </p>
            {schedule.delay_minutes > 0 && (
              <p className="text-xs text-amber-400">+{schedule.delay_minutes} min</p>
            )}
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <p className="text-[10px] text-white/40 mb-1">Competing Flights</p>
            <p className="text-sm font-bold text-white">{schedule.competing_flights}</p>
            <p className="text-[10px] text-white/30">same altitude band</p>
          </div>
        </div>

        {/* Reason */}
        <p className="text-xs text-white/50 italic">{schedule.reason}</p>
      </div>
    </motion.div>
  );
}
