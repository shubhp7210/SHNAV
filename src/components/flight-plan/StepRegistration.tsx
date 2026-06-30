import type { FlightPlanData } from "@/pages/FlightPlan";

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

const StepRegistration = ({ data, updateData }: Props) => {
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Register the participating operator and aircraft prior to operations.
      </p>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Aircraft Registration ID</label>
          <input
            type="text"
            value={data.aircraftId}
            onChange={(e) => updateData({ aircraftId: e.target.value })}
            placeholder="e.g. N-VTOL-4827"
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Operator Name</label>
          <input
            type="text"
            value={data.operatorName}
            onChange={(e) => updateData({ operatorName: e.target.value })}
            placeholder="e.g. SkyLink Operations"
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
          />
        </div>

        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-foreground">Aircraft Type</label>
          <select
            value={data.aircraftType}
            onChange={(e) => updateData({ aircraftType: e.target.value })}
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
          >
            <option value="evtol">eVTOL</option>
            <option value="rotorcraft">Rotorcraft</option>
            <option value="hybrid">Hybrid eVTOL</option>
          </select>
        </div>
      </div>
    </div>
  );
};

export default StepRegistration;
