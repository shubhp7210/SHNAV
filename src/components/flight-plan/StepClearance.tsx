import { Loader2 } from "lucide-react";
import type { FlightPlanData } from "@/pages/FlightPlan";
import RouteOptimizerCard from "@/components/route/RouteOptimizerCard";
import FlightDecisionPanel from "@/components/atm/FlightDecisionPanel";
import WeatherIntelligenceCard from "@/components/atm/WeatherIntelligenceCard";
import AirspaceSchedulePanel from "@/components/atm/AirspaceSchedulePanel";
import VertiportStatusCard from "@/components/atm/VertiportStatusCard";
import TrajectoryConflictAlert from "@/components/atm/TrajectoryConflictAlert";

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

const StepClearance = ({ data }: Props) => {
  const { atmEngines } = data;
  const loading = data.analysisLoading || atmEngines.atmLoading;

  if (loading) {
    return (
      <div className="py-16 flex flex-col items-center gap-6">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
        <div className="text-center">
          <p className="text-foreground font-medium mb-1">Running ATM analysis...</p>
          <p className="text-muted-foreground text-sm font-mono">
            Trajectory · Weather · Airspace · Vertiports · Decision Engine
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Single automated decision — always present */}
      {atmEngines.flightDecision && (
        <FlightDecisionPanel decision={atmEngines.flightDecision} />
      )}

      {/* Trajectory conflict prediction */}
      {atmEngines.trajectoryPredict && (
        <TrajectoryConflictAlert data={atmEngines.trajectoryPredict} />
      )}

      {/* Weather intelligence */}
      {atmEngines.weatherIntel && (
        <WeatherIntelligenceCard weather={atmEngines.weatherIntel} />
      )}

      {/* Airspace + Vertiport side by side */}
      {(atmEngines.airspaceSchedule || atmEngines.vertiportStatus) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {atmEngines.airspaceSchedule && (
            <AirspaceSchedulePanel schedule={atmEngines.airspaceSchedule} />
          )}
          {atmEngines.vertiportStatus && (
            <VertiportStatusCard status={atmEngines.vertiportStatus} />
          )}
        </div>
      )}

      {/* Route intelligence */}
      <RouteOptimizerCard routeData={data.routeData} routeLoading={data.routeLoading} />
    </div>
  );
};

export default StepClearance;
