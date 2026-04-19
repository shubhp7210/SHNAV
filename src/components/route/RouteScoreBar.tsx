import { useEffect, useState } from "react";

interface Props {
  label: string;
  score: number;
  color?: string;
}

const RouteScoreBar = ({ label, score, color }: Props) => {
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const barColor =
    color ??
    (score >= 80 ? "bg-green-500" : score >= 60 ? "bg-yellow-500" : "bg-red-500");

  const textColor = color
    ? "text-foreground"
    : score >= 80
    ? "text-green-400"
    : score >= 60
    ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="text-xs text-muted-foreground font-mono w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: animated ? `${Math.max(0, Math.min(100, score))}%` : "0%" }}
        />
      </div>
      <span className={`text-xs font-mono font-bold w-8 text-right shrink-0 ${textColor}`}>
        {score}
      </span>
    </div>
  );
};

export default RouteScoreBar;
