import { z } from "zod";
import {
  CorridorState,
  FacilityPowerState,
  OutageState,
  ShelterState,
  WeatherState,
  type Facility,
} from "@crisisgrid/shared";
import type { ToolContext } from "../context.js";

/** Shared argument shapes and state readers for scenario-source tools. */

export const scenarioArgs = {
  scenarioId: z
    .string()
    .optional()
    .describe("Scenario id; defaults to the loaded scenario"),
  forkId: z
    .string()
    .optional()
    .describe("What-if fork id for hypothetical state (from sim.run_what_if)"),
};

export interface StateReader {
  scenarioId: string;
  tick: number;
  forkId: string;
  outages: OutageState[];
  corridors: CorridorState[];
  shelters: ShelterState[];
  facilityPower: FacilityPowerState[];
  weather: WeatherState[];
}

export function readState(
  ctx: ToolContext,
  args: { scenarioId?: string; forkId?: string },
): StateReader {
  const scenarioId = ctx.resolveScenario(args.scenarioId);
  const tick = ctx.engine.currentTick(scenarioId);
  const forkId = args.forkId ?? "";
  const of = <T>(type: string, schema: z.ZodType<T>): T[] =>
    ctx.engine
      .entitiesOfType<unknown>(scenarioId, tick, type, forkId)
      .map((s) => schema.parse(s));
  return {
    scenarioId,
    tick,
    forkId,
    outages: of("outage", OutageState),
    corridors: of("corridor", CorridorState),
    shelters: of("shelter", ShelterState),
    facilityPower: of("facilityPower", FacilityPowerState),
    weather: of("weather", WeatherState),
  };
}

export function facilitiesOf(ctx: ToolContext, scenarioId: string): Facility[] {
  return ctx.engine.dataset(scenarioId).facilities.facilities;
}
