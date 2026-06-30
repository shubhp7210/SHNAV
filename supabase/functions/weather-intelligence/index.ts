import { serve } from "std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/constants.ts";
import { requireUserAuth } from "../_shared/auth.ts";
import { getCoords } from "../_shared/geocode.ts";
import {
  computeRisk,
  riskLevel,
  weatherCodeToDescription,
} from "../_shared/weather.ts";

const corsHeaders = CORS_HEADERS;

function applyMicroWeather(lat: number, lon: number, windSpeed: number, gusts: number, temp: number) {
  return {
    adjusted_temp: temp + 2.5,
    adjusted_gusts: gusts * 1.15,
    adjusted_wind: windSpeed * 1.05,
    micro_effects: ["Urban heat island effect (+2.5°C)", "Wind channeling in corridors (+15% gusts)"],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    await requireUserAuth(req);

    const { origin, destination, altitude_band } = await req.json();
    const [oLat, oLon] = await getCoords(origin ?? "");
    const [dLat, dLon] = await getCoords(destination ?? "");

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

    const windSpeed = oc.wind_speed_10m ?? 5;
    const gusts = oc.wind_gusts_10m ?? 7;
    const precip = oc.precipitation ?? 0;
    const temp = oc.temperature_2m ?? 20;
    const weatherCode = oc.weather_code ?? 0;
    const visibility = oc.visibility ?? 10000;

    const micro = applyMicroWeather(oLat, oLon, windSpeed, gusts, temp);
    const currentRiskScore = computeRisk(micro.adjusted_wind, micro.adjusted_gusts, precip, weatherCode);
    const currentRiskLevel = riskLevel(currentRiskScore);
    const altitudeMultiplier = altitude_band === "high" ? 1.3 : altitude_band === "mid" ? 1.15 : 1.0;
    const altAdjustedRisk = Math.min(100, Math.round(currentRiskScore * altitudeMultiplier));

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

    const risk15 = getForecastRisk(0);
    const risk30 = getForecastRisk(1);
    const volatility = Math.abs(risk30 - currentRiskScore);
    const uncertainty15 = Math.min(25, 8 + volatility * 0.3);
    const uncertainty30 = Math.min(40, 15 + volatility * 0.5);

    const dw = dc.wind_speed_10m ?? 5;
    const dg = dc.wind_gusts_10m ?? 7;
    const dp = dc.precipitation ?? 0;
    const dc_code = dc.weather_code ?? 0;
    const destRiskScore = computeRisk(dw * 1.05, dg * 1.15, dp, dc_code);
    const destRiskLevel = riskLevel(destRiskScore);

    let recommendation: "proceed" | "delay" | "reroute" = "proceed";
    let recommendationReason = "Conditions are suitable for flight.";
    let suggestedDelayMinutes = 0;
    let suggestedAltBand: string | null = null;

    if (altAdjustedRisk >= 60) {
      if (risk30 < currentRiskScore - 15) {
        recommendation = "delay";
        suggestedDelayMinutes = 30;
        recommendationReason = `High weather risk now (${altAdjustedRisk}/100). Conditions improve in ~30 minutes.`;
      } else {
        recommendation = "reroute";
        recommendationReason = `High weather risk (${altAdjustedRisk}/100). Suggest alternate altitude band or corridor.`;
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
    if (err instanceof Response) return err;
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
