import { beforeAll, describe, expect, it } from "vitest";
import { REGISTRY, ToolContext, executeTool } from "@crisisgrid/mcp-server";
import type { ToolResultEnvelope } from "@crisisgrid/shared";

/**
 * M2 tool-catalog evals: full catalog integrity, weather fallback
 * determinism, and the Route 12 hazard surface the debate depends on
 * (plan/02 demo scenario, plan/05 tool contracts).
 * DEMO_MODE defaults to true — no network is touched here.
 */

let ctx: ToolContext;

function data<T>(outcome: Awaited<ReturnType<typeof executeTool>>): T {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return (outcome.result as ToolResultEnvelope).data as T;
}

beforeAll(() => {
  ctx = new ToolContext(":memory:");
  ctx.engine.load("westside-cascade");
  ctx.engine.tick("westside-cascade", 6); // storm upgraded (EVT-003), closure & brownout active
});

describe("tool catalog integrity", () => {
  it("registers the full M2 catalog (>= 32 tools, unique names, all namespaces)", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(32);
    for (const ns of ["grid", "geo", "weather", "traffic", "shelters", "resources", "comms", "sim", "safety", "audit", "report"]) {
      expect(names.some((n) => n.startsWith(`${ns}.`)), `namespace ${ns}`).toBe(true);
    }
  });

  it("declares tiers per the plan: approval + blocked tools present", () => {
    const byTier = (tier: string) => REGISTRY.filter((t) => t.tier === tier).map((t) => t.name);
    expect(byTier("blocked").sort()).toEqual(["comms.broadcast_all_channels", "safety.record_approval"]);
    expect(byTier("approval").sort()).toEqual([
      "comms.send_sandbox_alert",
      "resources.assign_unit",
      "shelters.assign_population",
      "sim.advance_time",
      "sim.inject_event",
    ]);
  });
});

describe("weather tools (scenario source, DEMO_MODE)", () => {
  it("forecast is deterministic and labeled source: scenario", async () => {
    const a = await executeTool(ctx, "weather.get_forecast", { zone: "Z-05", hours: 6 });
    const b = await executeTool(ctx, "weather.get_forecast", { zone: "Z-05", hours: 6 });
    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("expected ok");
    const envA = a.result as ToolResultEnvelope;
    expect(envA.source).toBe("scenario");
    expect((envA.data as { periods: unknown[] }).periods).toHaveLength(6);
    expect(JSON.stringify(envA.data)).toBe(JSON.stringify((b.result as ToolResultEnvelope).data));
  });

  it("alerts include a flood alert with sim-time onset once the band is upgraded", async () => {
    const { alerts } = data<{ alerts: { type: string; onset: string }[] }>(
      await executeTool(ctx, "weather.get_alerts", {}),
    );
    expect(alerts.some((a) => a.type.includes("Flood"))).toBe(true);
    expect(alerts[0]!.onset).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("rainfall risk marks Z-05 high (floodplain FP-WEST-N activates at 35 mm/h)", async () => {
    const { perZone } = data<{ perZone: { zone: string; floodRelevance: string; peakMmHr: number; floodplains: string[] }[] }>(
      await executeTool(ctx, "weather.get_rainfall_risk", { zones: ["Z-05", "Z-03"], horizonMin: 180 }),
    );
    const z05 = perZone.find((z) => z.zone === "Z-05")!;
    expect(z05.floodRelevance).toBe("high");
    expect(z05.peakMmHr).toBe(35);
    expect(z05.floodplains).toContain("FP-WEST-N");
    expect(perZone.find((z) => z.zone === "Z-03")!.floodRelevance).toBe("low");
  });
});

describe("traffic tools — the Route 12 debate surface", () => {
  it("find_routes exposes the flood hazard on RT-12 and keeps RT-08 clean", async () => {
    const { routes } = data<{
      routes: { id: string; available: boolean; hazards: { kind: string; ref: string; detail: string }[]; etaMin: number }[];
    }>(await executeTool(ctx, "traffic.find_routes", { fromZone: "Z-05", toZone: "Z-07" }));
    expect(routes.map((r) => r.id).sort()).toEqual(["RT-08", "RT-12", "RT-DELTA"]);

    const rt12 = routes.find((r) => r.id === "RT-12")!;
    const floodHazard = rt12.hazards.find((h) => h.kind === "floodplain");
    expect(floodHazard).toBeDefined();
    expect(floodHazard!.ref).toBe("FP-WEST-N");
    expect(floodHazard!.detail).toContain("exceeds activation threshold");

    const rt08 = routes.find((r) => r.id === "RT-08")!;
    expect(rt08.hazards.filter((h) => h.kind === "floodplain")).toHaveLength(0);
    // RT-12 stays FASTER than RT-08 — that asymmetry is what forces the debate.
    expect(rt12.etaMin).toBeLessThan(rt08.etaMin);
  });

  it("evacuation time model is deterministic with explicit assumptions", async () => {
    const run = () =>
      executeTool(ctx, "traffic.estimate_evacuation_time", { routeId: "RT-08", population: 4000, transport: "mixed" });
    const a = data<{ totalMin: number; bottleneck: string; assumptions: string[] }>(await run());
    const b = data<{ totalMin: number }>(await run());
    expect(a.totalMin).toBe(b.totalMin);
    expect(a.totalMin).toBeGreaterThan(0);
    expect(a.bottleneck).toMatch(/^COR-/);
    expect(a.assumptions.length).toBeGreaterThanOrEqual(2);
  });

  it("congestion includes the dark-signal penalty in effective level", async () => {
    const { corridors } = data<{ corridors: { id: string; level0to1: number; rawLevel: number; signalStatus: string }[] }>(
      await executeTool(ctx, "traffic.get_congestion", {}),
    );
    for (const c of corridors.filter((x) => x.signalStatus === "dark")) {
      expect(c.level0to1).toBeGreaterThan(c.rawLevel);
    }
  });
});

describe("resources.recommend_staging (deterministic optimizer)", () => {
  it("picks nearest available units with feasible arrive-by times, and repeats identically", async () => {
    const run = () =>
      executeTool(ctx, "resources.recommend_staging", {
        targetZone: "Z-05",
        needs: [{ kind: "bus_group", count: 2 }, { kind: "pump_crew", count: 1 }],
        arriveWithinMin: 60,
      });
    const a = data<{ staging: { unitId: string; etaMin: number; feasible: boolean; rationale: string }[]; shortfalls: unknown[] }>(await run());
    const b = data<{ staging: { unitId: string }[] }>(await run());
    expect(a.staging.map((s) => s.unitId)).toEqual(b.staging.map((s) => s.unitId));
    expect(a.staging).toHaveLength(3);
    expect(a.staging.every((s) => s.rationale.includes("Nearest available"))).toBe(true);
    // Buses sorted by ETA: the first bus pick must not be slower than the second.
    const buses = a.staging.filter((s) => s.unitId.startsWith("BUS"));
    expect(buses[0]!.etaMin).toBeLessThanOrEqual(buses[1]!.etaMin);
  });
});

describe("report rendering (deterministic sections)", () => {
  it("renders every required section in fixed order from DB state", async () => {
    ctx.db
      .prepare("INSERT INTO incidents (id, scenario_id, revision, operator_text, parsed_json, status, created_at) VALUES ('inc-eval', 'westside-cascade', 0, 'Westside outage assessment', NULL, 'complete', '2026-01-01T00:00:00Z')")
      .run();
    const { markdown } = data<{ reportId: string; markdown: string }>(
      await executeTool(ctx, "report.export_markdown", {
        incidentId: "inc-eval",
        narrativeSections: { executiveSummary: "Narrative summary here." },
      }),
    );
    const sections = [
      "Incident Summary", "Timeline", "Risk Assessment", "Agent Assessments",
      "Incident Action Plan", "Approvals & Blocked Actions", "Communications",
      "Unresolved Risks", "Assumptions", "Next Steps", "Data Sources & Audit",
    ];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = markdown.indexOf(`## ${s}`);
      expect(idx, `section ${s}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    expect(markdown).toContain("SIMULATED EXERCISE");
    expect(markdown).toContain("EVT-003"); // fired timeline events present
    expect(markdown).toContain("City risk score:");
  });
});
