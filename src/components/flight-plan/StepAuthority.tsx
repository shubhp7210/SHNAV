import type { FlightPlanData } from "@/pages/FlightPlan";

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
  onApprove?: () => void | Promise<void>;
}

const StepAuthority = ({ data, updateData, onApprove }: Props) => {
  const decisionLabel: Record<string, string> = {
    "auto-best": "GO — Cleared for Departure",
    "delayed-departure": "DELAY — Departure Held",
    "alternate-corridor": "REROUTE — Alternate Corridor",
    // legacy values kept for safety
    "immediate": "Immediate Departure",
    "delayed": "Short Delayed Departure",
    "alt-altitude": "Alternate Altitude Band",
    "alt-corridor": "Alternate Corridor",
  };
  const clearanceLabel = decisionLabel[data.selectedClearance] ?? "—";

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Review your flight summary before authorization.
      </p>

      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-foreground">Flight Summary</h4>
        <div className="bg-secondary rounded-lg divide-y divide-border/30">
          {[
            ["Aircraft", data.aircraftId || "—"],
            ["Operator", data.operatorName || "—"],
            ["Route", `${data.origin || "—"} → ${data.destination || "—"}`],
            ["Departure Window", `${data.departureWindowStart || "—"} – ${data.departureWindowEnd || "—"}`],
            ["Clearance", clearanceLabel],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between px-5 py-3">
              <span className="text-sm text-muted-foreground">{label}</span>
              <span className="text-sm font-mono text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-3 bg-secondary rounded-lg p-4">
        <input
          type="checkbox"
          checked={data.authorityApproved}
          onChange={(e) => {
            updateData({ authorityApproved: e.target.checked });
            if (e.target.checked) onApprove?.();
          }}
          className="mt-1 accent-[hsl(175,70%,45%)]"
        />
        <div>
          <p className="text-sm text-foreground font-medium">Authority Acknowledgment</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            I confirm the flight details have been reviewed and approve this operation.
          </p>
        </div>
      </div>
    </div>
  );
};

export default StepAuthority;
