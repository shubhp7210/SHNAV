import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Known city coordinates for location lookup
const CITY_COORDS: Record<string, [number, number]> = {
  "new york": [40.7128, -74.006], "nyc": [40.7128, -74.006],
  "los angeles": [34.0522, -118.2437], "la": [34.0522, -118.2437],
  "chicago": [41.8781, -87.6298], "miami": [25.7617, -80.1918],
  "san francisco": [37.7749, -122.4194], "sf": [37.7749, -122.4194],
  "houston": [29.7604, -95.3698], "boston": [42.3601, -71.0589],
  "seattle": [47.6062, -122.3321], "dallas": [32.7767, -96.797],
  "atlanta": [33.749, -84.388], "denver": [39.7392, -104.9903],
  "london": [51.5074, -0.1278], "dubai": [25.2048, 55.2708],
  "tokyo": [35.6762, 139.6503], "singapore": [1.3521, 103.8198],
};

function parseTaggedCoords(location: string): [number, number] | null {
  const tagged = location.match(/@\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (tagged) {
    const lat = parseFloat(tagged[1]);
    const lon = parseFloat(tagged[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }

  const bare = location.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return [lat, lon];
  }

  return null;
}

async function getCoords(location: string): Promise<[number, number]> {
  if (!location?.trim()) return [40.7128, -74.006];

  const parsed = parseTaggedCoords(location);
  if (parsed) return parsed;

  const lower = location.toLowerCase().trim();
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(key)) return coords;
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "Altos-ATM/1.0", "Accept-Language": "en" } }
    );
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      return [parseFloat(arr[0].lat), parseFloat(arr[0].lon)];
    }
  } catch (error) {
    console.error("Weather geocode failed:", error);
  }

  return [40.7128, -74.006];
}

function weatherCodeToDescription(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 9) return "Overcast";
  if (code <= 19) return "Fog";
  if (code <= 29) return "Drizzle";
  if (code <= 39) return "Freezing drizzle";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Snow showers";
  return "Thunderstorm";
}

function computeRisk(windSpeed: number, gusts: number, precip: number, weatherCode: number): number {
  let risk = 0;
  // Wind
  if (windSpeed > 50) risk += 40;
  else if (windSpeed > 35) risk += 25;
  else if (windSpeed > 20) risk += 12;
  else if (windSpeed > 10) risk += 4;
  // Gusts
  if (gusts > 60) risk += 30;
  else if (gusts > 40) risk += 18;
  else if (gusts > 25) risk += 8;
  // Precipitation
  if (precip > 5) risk += 20;
  else if (precip > 2) risk += 12;
  else if (precip > 0.5) risk += 5;
  // Weather code
  if (weatherCode >= 95) risk += 30; // Thunderstorm
  else if (weatherCode >= 80) risk += 15; // Showers
  else if (weatherCode >= 61) risk += 10; // Rain
  else if (weatherCode >= 51) risk += 6; // Drizzle
  return Math.min(100, risk);
}

function riskLevel(score: number): "low" | "moderate" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "moderate";
  return "low";
}

// Micro-weather urban effects: amplify wind gusts near city centers
function applyMicroWeather(lat: number, lon: number, windSpeed: number, gusts: number, temp: number) {
  // Urban heat island: +2-4°C in city centers
  const urbanHeatBias = 2.5;
  // Wind channeling in urban canyons: gusts amplified 10-20%
  const gustAmplification = 1.15;
  return {
    adjusted_temp: temp + urbanHeatBias,
    adjusted_gusts: gusts * gustAmplification,
    adjusted_wind: windSpeed * 1.05,
    micro_effects: ["Urban heat island effect (+2.5°C)", "Wind channeling in corridors (+15% gusts)"],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { origin, destination, altitude_band } = await req.json();
    const [oLat, oLon] = await getCoords(origin ?? "");
    const [dLat, dLon] = await getCoords(destination ?? "");

    // Fetch current + hourly forecast from Open-Meteo for origin AND destination
    const params = "wind_speed_10m,wind_gusts_10m,precipitation,temperature_2m,weather_code,visibility";
    const hourlyParams = "wind_speed_10m,wind_gusts_10m,precipitation,weather_code,temperature_2m";

    const [originRes, destRes] = await Promise.allSettled([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${oLat}&longitude=${oLon}&current=${params}&hourly=${hourlyParams}&forecast_days=1&wind_speed_unit=kmh`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${dLat}&longitude=${dLon}&current=${params}&hourly=${hourlyParams}&forecast_days=1&wind_speed_unit=kmh`),
    ]);

    let originData: any = null, destData: any = null;
    if (originRes.status === "fulfilled" && originRes.value.ok) originData = await originRes.value.json();
    if (destRes.status === "fulfilled" && destRes.value.ok) destData = await destRes.value.json();

    const oc = originData?.current ?? {};
    const dc = destData?.current ?? {};

    // Current conditions at origin
    const windSpeed = oc.wind_speed_10m ?? 5;
    const gusts = oc.wind_gusts_10m ?? 7;
    const precip = oc.precipitation ?? 0;
    const temp = oc.temperature_2m ?? 20;
    const weatherCode = oc.weather_code ?? 0;
    const visibility = oc.visibility ?? 10000;

    // Apply micro-weather corrections
    const micro = applyMicroWeather(oLat, oLon, windSpeed, gusts, temp);

    // Current risk score
    const currentRiskScore = computeRisk(micro.adjusted_wind, micro.adjusted_gusts, precip, weatherCode);
    const currentRiskLevel = riskLevel(currentRiskScore);

    // Altitude modifier: higher = more wind exposure
    const altitudeMultiplier = altitude_band === "high" ? 1.3 : altitude_band === "mid" ? 1.15 : 1.0;
    const altAdjustedRisk = Math.min(100, Math.round(currentRiskScore * altitudeMultiplier));

    // Forecast: extract t+15min and t+30min from hourly (approximate with next 2 hours)
    const now = new Date();
    const currentHour = now.getHours();
    const oh = originData?.hourly ?? {};

    function getForecastRisk(hourOffset: number): number {
      const idx = Math.min(currentHour + hourOffset, 23);
      const fw = oh.wind_speed_10m?.[idx] ?? windSpeed;
      const fg = oh.wind_gusts_10m?.[idx] ?? gusts;
      const fp = oh.precipitation?.[idx] ?? precip;
      const fc = oh.weather_code?.[idx] ?? weatherCode;
      return computeRisk(fw * 1.05, fg * 1.15, fp, fc);
    }

    const risk15 = getForecastRisk(0); // same hour, approximate
    const risk30 = getForecastRisk(1); // next hour

    // Uncertainty: increases with time horizon and current volatility
    const volatility = Math.abs(risk30 - currentRiskScore);
    const uncertainty15 = Math.min(25, 8 + volatility * 0.3);
    const uncertainty30 = Math.min(40, 15 + volatility * 0.5);

    // Destination weather
    const dw = dc.wind_speed_10m ?? 5;
    const dg = dc.wind_gusts_10m ?? 7;
    const dp = dc.precipitation ?? 0;
    const dc_code = dc.weather_code ?? 0;
    const destRiskScore = computeRisk(dw * 1.05, dg * 1.15, dp, dc_code);
    const destRiskLevel = riskLevel(destRiskScore);

    // Decision recommendation
    let recommendation: "proceed" | "delay" | "reroute" = "proceed";
    let recommendationReason = "Conditions are suitable for flight.";
    let suggestedDelayMinutes = 0;
    let suggestedAltBand: string | null = null;

    if (altAdjustedRisk >= 60) {
      // High risk — check if delaying helps
      if (risk30 < currentRiskScore - 15) {
        recommendation = "delay";
        suggestedDelayMinutes = 30;
        recommendationReason = `High weather risk now (${altAdjustedRisk}/100). Conditions improve in ~30 minutes.`;
      } else {
        recommendation = "reroute";
        recommendationReason = `High weather risk (${altAdjustedRisk}/100). Suggest alternate altitude band or corridor to avoid weather.`;
        suggestedAltBand = altitude_band === "high" ? "mid" : altitude_band === "mid" ? "low" : "mid";
      }
    } else if (altAdjustedRisk >= 35) {
      if (risk15 < currentRiskScore - 10) {
        recommendation = "delay";
        suggestedDelayMinutes = 15;
        recommendationReason = `Moderate weather risk (${altAdjustedRisk}/100). Short delay of 15 min should improve conditions.`;
      } else {
        recommendation = "proceed";
        recommendationReason = `Moderate weather risk (${altAdjustedRisk}/100) but stable. Proceed with caution.`;
      }
    }

    return new Response(JSON.stringify({
      origin_weather: {
        wind_speed: Math.round(micro.adjusted_wind),
        wind_gusts: Math.round(micro.adjusted_gusts),
        precipitation: precip,
        temperature: Math.round(micro.adjusted_temp),
        weather_code: weatherCode,
        weather_description: weatherCodeToDescription(weatherCode),
        visibility_m: visibility,
        risk_score: altAdjustedRisk,
        risk_level: currentRiskLevel,
        micro_effects: micro.micro_effects,
      },
      destination_weather: {
        wind_speed: Math.round(dw),
        wind_gusts: Math.round(dg),
        precipitation: dp,
        risk_score: destRiskScore,
        risk_level: destRiskLevel,
        weather_description: weatherCodeToDescription(dc_code),
      },
      forecast: {
        t_plus_15: { risk_score: Math.round(risk15 * altitudeMultiplier), uncertainty_pct: Math.round(uncertainty15) },
        t_plus_30: { risk_score: Math.round(risk30 * altitudeMultiplier), uncertainty_pct: Math.round(uncertainty30) },
        trend: risk30 < currentRiskScore ? "improving" : risk30 > currentRiskScore ? "degrading" : "stable",
      },
      recommendation,
      recommendation_reason: recommendationReason,
      suggested_delay_minutes: suggestedDelayMinutes,
      suggested_altitude_band: suggestedAltBand,
      altitude_risk_modifier: altitudeMultiplier,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
