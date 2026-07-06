import { z } from "zod";
import { polygonCentroid } from "@crisisgrid/engine";
import type { ZoneFeature } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs, type StateReader } from "./common.js";
import { demoMode, fetchOpenMeteoForecast } from "../adapters/openMeteo.js";

/**
 * weather.* — hazard tools (plan/05 §2).
 * Scenario weather is the deterministic source; Open-Meteo enriches when
 * DEMO_MODE=false, with automatic scenario fallback (plan/06 §4).
 * Every result carries source: "live" | "scenario" so agents must label it.
 */

function simTimeAtTick(ctx: Parameters<ToolDef["handler"]>[1], scenarioId: string, tick: number): string {
  return ctx.engine.simTimeAt(scenarioId, tick);
}

/** Build deterministic forecast periods from scenario weather state. */
function scenarioForecast(ctx: Parameters<ToolDef["handler"]>[1], s: StateReader, hours: number) {
  const w = s.weather[0];
  if (!w) return [];
  const periods = [];
  const ticksPerHour = 12; // 5-min ticks
  for (let h = 0; h < hours; h++) {
    const tickAt = s.tick + h * ticksPerHour;
    const beforeArrival = tickAt < w.rainArrivalTick;
    // Simple deterministic ramp: pre-arrival light rain, post-arrival peak, decaying after 3h.
    const hoursPast = Math.max(0, (tickAt - w.rainArrivalTick) / ticksPerHour);
    const precip = beforeArrival
      ? w.precipNowMmHr
      : Math.max(4, w.peakMmHr * w.intensityFactor * Math.max(0.3, 1 - hoursPast / 5));
    periods.push({
      time: simTimeAtTick(ctx, s.scenarioId, tickAt),
      tempC: 17,
      precipMmHr: Math.round(precip * 10) / 10,
      windKmh: w.windGustKmh,
      summary: beforeArrival ? `${w.summary} (pre-arrival)` : `Heavy rain band over west metro`,
    });
  }
  return periods;
}

export const weatherTools: ToolDef[] = [
  {
    name: "weather.get_forecast",
    description:
      "Hourly forecast for a zone (or explicit lat/lon). Scenario weather in demo mode; live Open-Meteo otherwise, with automatic scenario fallback. Result.source tells you which.",
    tier: "safe",
    source: "live",
    input: z.object({
      ...scenarioArgs,
      zone: z.string().optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      hours: z.number().int().min(1).max(24).default(12),
    }),
    handler: async (args, ctx) => {
      const s = readState(ctx, args);
      const hours = args.hours as number;
      if (!demoMode()) {
        try {
          let lat = args.lat as number | undefined;
          let lon = args.lon as number | undefined;
          if (lat === undefined || lon === undefined) {
            const zf = ctx.engine
              .dataset(s.scenarioId)
              .city.features.find(
                (f): f is ZoneFeature =>
                  f.properties.kind === "zone" &&
                  (f.properties as { zoneId?: string }).zoneId === (args.zone ?? "Z-05"),
              );
            const [cLon, cLat] = zf ? polygonCentroid(zf.geometry.coordinates[0]!) : [-122.68, 45.51];
            lat = cLat;
            lon = cLon;
          }
          const periods = await fetchOpenMeteoForecast(lat, lon, hours);
          return ctx.wrapAndLog({
            tool: "weather.get_forecast", source: "live", scenarioId: s.scenarioId,
            argsJson: args, data: { periods }, startedMs: performance.now(),
            provider: "Open-Meteo", freshness: "fresh",
          });
        } catch {
          // fall through to scenario
        }
      }
      return ctx.wrapAndLog({
        tool: "weather.get_forecast", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { periods: scenarioForecast(ctx, s, hours) },
        startedMs: performance.now(),
        provider: "scenario", freshness: demoMode() ? "fresh" : "fallback",
        note: demoMode() ? undefined : "live source unavailable, scenario fallback",
      });
    },
  },
  {
    name: "weather.get_alerts",
    description: "Active severe weather alerts for the metro area with onset/expiry in sim time.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const w = s.weather[0];
      const alerts = [];
      if (w && w.peakMmHr * w.intensityFactor >= 20) {
        alerts.push({
          type: w.intensityFactor > 1 ? "Flash Flood Warning" : "Flood Watch",
          severity: w.intensityFactor > 1 ? "severe" : "moderate",
          onset: simTimeAtTick(ctx, s.scenarioId, Math.max(s.tick, w.rainArrivalTick)),
          expires: simTimeAtTick(ctx, s.scenarioId, w.rainArrivalTick + 48),
          headline: `Heavy rain (peak ${Math.round(w.peakMmHr * w.intensityFactor)} mm/h) expected over west metro; low-lying areas near the river may flood`,
        });
      }
      if (w && w.windGustKmh >= 60) {
        alerts.push({
          type: "Wind Advisory",
          severity: "moderate",
          onset: simTimeAtTick(ctx, s.scenarioId, s.tick),
          expires: simTimeAtTick(ctx, s.scenarioId, s.tick + 36),
          headline: `Gusts to ${w.windGustKmh} km/h; hazard for high-profile vehicles and crews working aloft`,
        });
      }
      return ctx.wrapAndLog({
        tool: "weather.get_alerts", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { alerts }, startedMs: performance.now(),
        provider: "scenario", freshness: "fresh",
      });
    },
  },
  {
    name: "weather.get_rainfall_risk",
    description:
      "Rain intensity, accumulation, flood relevance, and peak timing per zone over a horizon. Flood relevance is high where an activating floodplain overlaps the zone.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      zones: z.array(z.string()).min(1),
      horizonMin: z.number().int().min(15).max(720).default(180),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const w = s.weather[0];
      const floodplains = ctx.engine
        .dataset(s.scenarioId)
        .city.features.filter((f) => f.properties.kind === "floodplain");
      const horizonTicks = Math.floor((args.horizonMin as number) / 5);
      const perZone = (args.zones as string[]).map((zone) => {
        const overlapping = floodplains.filter((fp) =>
          (fp.properties as { zones: string[] }).zones.includes(zone),
        );
        const effectivePeak = w ? w.peakMmHr * w.intensityFactor : 0;
        const arrivesInHorizon = w ? w.rainArrivalTick <= s.tick + horizonTicks : false;
        const activating = overlapping.some(
          (fp) => effectivePeak >= (fp.properties as { activationThresholdMmHr: number }).activationThresholdMmHr,
        );
        const declared = w?.perZoneRisk.find((r) => r.zone === zone)?.floodRelevance ?? "low";
        const floodRelevance =
          arrivesInHorizon && activating && overlapping.length > 0
            ? "high"
            : declared === "high" && arrivesInHorizon
              ? "medium"
              : declared;
        return {
          zone,
          peakMmHr: Math.round(effectivePeak * 10) / 10,
          accumMm: Math.round(effectivePeak * 2 * 10) / 10, // ~2h at peak, deterministic proxy
          floodRelevance,
          peakAt: w ? simTimeAtTick(ctx, s.scenarioId, Math.max(s.tick, w.rainArrivalTick) + 6) : null,
          rainArrivalAt: w ? simTimeAtTick(ctx, s.scenarioId, w.rainArrivalTick) : null,
          minutesToArrival: w ? Math.max(0, (w.rainArrivalTick - s.tick) * 5) : null,
          floodplains: overlapping.map((fp) => (fp.properties as { floodplainId: string }).floodplainId),
        };
      });
      return ctx.wrapAndLog({
        tool: "weather.get_rainfall_risk", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: { perZone }, startedMs: performance.now(),
        provider: "ScenarioEngine", freshness: "fresh",
      });
    },
  },
  {
    name: "weather.get_wind_risk",
    description: "Gust risk per zone (matters for utility crews aloft and high-profile vehicles on bridges).",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, zones: z.array(z.string()).min(1) }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const w = s.weather[0];
      const gust = w?.windGustKmh ?? 0;
      const risk = gust >= 90 ? "high" : gust >= 60 ? "medium" : "low";
      const perZone = (args.zones as string[]).map((zone) => ({
        zone,
        gustKmh: gust,
        risk,
        crewImpact: gust >= 60 ? "Bucket-truck work restricted above 60 km/h gusts" : "No restriction",
      }));
      return ctx.wrapAndLog({
        tool: "weather.get_wind_risk", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { perZone }, startedMs: performance.now(),
        provider: "scenario", freshness: "fresh",
      });
    },
  },
];
