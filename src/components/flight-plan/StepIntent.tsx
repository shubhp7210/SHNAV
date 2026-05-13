import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { MapPin, Loader2 } from "lucide-react";
import type { FlightPlanData } from "@/pages/FlightPlan";

interface Props {
  data: FlightPlanData;
  updateData: (d: Partial<FlightPlanData>) => void;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  importance: number;
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function useLocationSearch(query: string) {
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.trim().length < 3) { setResults([]); return; }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`,
          { headers: { "Accept-Language": "en" } }
        );
        const data: NominatimResult[] = await res.json();
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  return { results, loading };
}

function LocationInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
}) {
  const [inputVal, setInputVal] = useState(value);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(!!value);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { results, loading } = useLocationSearch(confirmed ? "" : inputVal);

  const displayValue = useCallback((raw: string) => raw.replace(/\s*@\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$/, ""), []);

  // Sync if parent resets
  useEffect(() => {
    setInputVal(displayValue(value));
    setConfirmed(!!value);
  }, [displayValue, value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        // If user typed something but didn't pick — reset to last confirmed
        if (!confirmed) { setInputVal(displayValue(value)); }
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmed, displayValue, value]);

  const select = (item: NominatimResult) => {
    // Use a clean short name: first two comma-separated parts
    const short = item.display_name.split(",").slice(0, 2).join(",").trim();
    setInputVal(short);
    setConfirmed(true);
    setOpen(false);
    onChange(`${short} @ ${item.lat},${item.lon}`);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(e.target.value);
    setConfirmed(false);
    onChange(""); // clear parent until a real pick is made
    setOpen(true);
  };

  const showDropdown = open && (loading || results.length > 0);

  return (
    <div className="space-y-2" ref={wrapRef}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        <MapPin className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 transition-colors ${confirmed ? "text-primary" : "text-muted-foreground"}`} />
        <input
          type="text"
          value={inputVal}
          onChange={handleChange}
          onFocus={() => !confirmed && setOpen(true)}
          placeholder={placeholder}
          autoComplete="off"
          className={`w-full pl-9 pr-10 py-2.5 rounded-md bg-secondary border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm transition-colors ${
            confirmed ? "border-primary/50" : "border-border"
          }`}
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        )}
        {confirmed && !loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-primary" />
        )}

        {showDropdown && (
          <div className="absolute z-50 top-full mt-1 w-full bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            {loading && results.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground font-mono">Searching...</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.place_id}
                  type="button"
                  onMouseDown={() => select(r)}
                  className="w-full text-left px-4 py-2.5 hover:bg-secondary transition-colors border-b border-border/40 last:border-0"
                >
                  <p className="text-sm text-foreground truncate">
                    {r.display_name.split(",").slice(0, 2).join(",")}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {r.display_name.split(",").slice(2, 4).join(",").trim()}
                  </p>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {!confirmed && inputVal.trim().length >= 3 && !loading && results.length === 0 && (
        <p className="text-xs text-destructive font-mono">No locations found — try a city or address.</p>
      )}
    </div>
  );
}

const StepIntent = ({ data, updateData }: Props) => {
  const windowWarning = useMemo(() => {
    if (!data.departureWindowStart || !data.departureWindowEnd) return null;
    const s = toMinutes(data.departureWindowStart);
    const e = toMinutes(data.departureWindowEnd);
    if (e <= s) return "End time must be after start time.";
    if (e - s > 10) return "Departure window cannot exceed 10 minutes.";
    return null;
  }, [data.departureWindowStart, data.departureWindowEnd]);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Submit a flexible flight intent with a departure time window (max 10 minutes).
      </p>

      <div className="grid md:grid-cols-2 gap-5">
        <LocationInput
          label="Origin Vertiport / Location"
          value={data.origin}
          onChange={(val) => updateData({ origin: val })}
          placeholder="Search for a city or address..."
        />

        <LocationInput
          label="Destination"
          value={data.destination}
          onChange={(val) => updateData({ destination: val })}
          placeholder="Search for a city or address..."
        />

        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-foreground">Departure Date</label>
          <input
            type="date"
            value={data.departureDate}
            min={new Date().toISOString().split("T")[0]}
            onChange={(e) => updateData({ departureDate: e.target.value })}
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm font-mono"
          />
          <p className="text-[11px] text-muted-foreground font-mono">
            Schedule a flight today or any future date.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Departure Window Start</label>
          <input
            type="time"
            value={data.departureWindowStart}
            onChange={(e) => updateData({ departureWindowStart: e.target.value })}
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm font-mono"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Departure Window End</label>
          <input
            type="time"
            value={data.departureWindowEnd}
            onChange={(e) => updateData({ departureWindowEnd: e.target.value })}
            className="w-full px-4 py-2.5 rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm font-mono"
          />
        </div>
      </div>

      {windowWarning && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
          <p className="text-xs text-destructive font-mono">{windowWarning}</p>
        </div>
      )}
    </div>
  );
};

export default StepIntent;
