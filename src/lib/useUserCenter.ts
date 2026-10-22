import { useEffect, useState } from "react";

// Map center as [lng, lat]. Defaults to NYC; resolves to the user's actual
// location via the browser Geolocation API (one permission prompt). Falls back
// to the default if the user declines, the API is unavailable, or it times out.
export const DEFAULT_CENTER: [number, number] = [-73.9857, 40.7484];

// Module-level cache so the permission prompt only happens once per session and
// every map that mounts later reuses the resolved location immediately.
let cached: [number, number] | null = null;

export function useUserCenter(): [number, number] {
  const [center, setCenter] = useState<[number, number]>(cached ?? DEFAULT_CENTER);

  useEffect(() => {
    if (cached) { setCenter(cached); return; }
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let active = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cached = [pos.coords.longitude, pos.coords.latitude];
        if (active) setCenter(cached);
      },
      () => { /* permission denied / unavailable — keep default */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
    return () => { active = false; };
  }, []);

  return center;
}
