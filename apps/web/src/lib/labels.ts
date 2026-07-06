import type { MapSnapshot } from "./types";

/**
 * The translation layer: every internal ID (Z-05, RT-08, HOSP-RG, tick 16)
 * becomes human language before it reaches the screen. Raw IDs never render.
 * Built once from the map snapshot's scenario geometry.
 */

export interface Labels {
  zone: (id: string) => string;
  facility: (id: string) => string;
  route: (id: string) => string;
  routeShort: (id: string) => string;
  corridor: (id: string) => string;
  /** Replace every known ID inside free text (agent findings mention Z-05 etc.). */
  humanize: (text: string) => string;
  /** tick → "6:40 PM" */
  time: (tick: number) => string;
  /** ISO sim time → "6:40 PM" */
  clock: (iso: string) => string;
}

const START_SIM_TIME = "2026-07-02T17:20:00";
const MINUTES_PER_TICK = 5;

export function formatClock(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

export function tickToClock(tick: number): string {
  const start = new Date(START_SIM_TIME);
  const t = new Date(start.getTime() + tick * MINUTES_PER_TICK * 60_000);
  const h = t.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(t.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export function buildLabels(snapshot: MapSnapshot | null): Labels {
  const zones = new Map<string, string>();
  const facilities = new Map<string, string>();
  const routes = new Map<string, string>();
  const routesShort = new Map<string, string>();
  const corridors = new Map<string, string>();
  const floodplains = new Map<string, string>();
  const bridges = new Map<string, string>();

  if (snapshot) {
    for (const f of snapshot.geometry.city.features) {
      const p = f.properties as Record<string, unknown>;
      if (p.kind === "zone") zones.set(p.zoneId as string, p.name as string);
      if (p.kind === "floodplain") floodplains.set(p.floodplainId as string, "the riverside flood zone");
      if (p.kind === "bridge") bridges.set(p.bridgeId as string, p.name as string);
    }
    for (const f of snapshot.geometry.facilities.facilities) facilities.set(f.id, f.name);
    for (const c of snapshot.geometry.network.corridors) corridors.set(c.id, c.name);
    for (const r of snapshot.geometry.network.routes) {
      routes.set(r.id, r.name);
      // "Route 8 — Main St Bridge" → "Main St Bridge route"
      const short = r.name.includes("—") ? `${r.name.split("—")[1]!.trim()} route` : r.name;
      routesShort.set(r.id, short);
    }
  }

  const zone = (id: string) => zones.get(id) ?? id;
  const facility = (id: string) => facilities.get(id) ?? id;
  const route = (id: string) => routes.get(id) ?? id;
  const routeShort = (id: string) => routesShort.get(id) ?? id;
  const corridor = (id: string) => corridors.get(id) ?? id;

  // Longest IDs first so RT-09S wins over RT-09 style prefixes.
  const idMaps: [RegExp, (id: string) => string][] = [
    [/\bZ-\d{2}\b/g, zone],
    [/\bRT-[A-Z0-9]+\b/g, routeShort],
    [/\bCOR-[A-Z0-9-]+\b/g, corridor],
    [/\b(?:HOSP|SHL|SUB|WTR|STG|SIG)-[A-Z0-9]+\b/g, facility],
    [/\bFP-[A-Z0-9-]+\b/g, (id) => floodplains.get(id) ?? "the flood zone"],
    [/\bBR-[A-Z0-9]+\b/g, (id) => bridges.get(id) ?? id],
    [/\bOUT-\d+\b/g, () => "the west-side outage"],
  ];

  const ID_PATTERN =
    "Z-\\d{2}|RT-[A-Z0-9]+|COR-[A-Z0-9-]+|(?:HOSP|SHL|SUB|WTR|STG|SIG)-[A-Z0-9]+|FP-[A-Z0-9-]+|BR-[A-Z0-9]+|OUT-\\d+";

  const humanize = (text: string) => {
    if (!text || typeof text !== "string") return "";
    let out = text;
    // Agents often write "Westbank (Z-05)" — the name is already there, drop the ID.
    out = out.replace(new RegExp(`\\s*\\((?:${ID_PATTERN})\\)`, "g"), "");
    // Strip opaque finding / evidence refs from readable prose.
    out = out.replace(/\b(?:WX|PW|TRAFFIC|SHL|OUT|CLS)-\d+\b/g, "");
    out = out.replace(/\binc-[a-f0-9]{6,}\b/gi, "");
    out = out.replace(/\bCIRCUIT-(Z-\d{2})\b/g, (_, z: string) => `${zone(z)} power circuit`);
    for (const [re, fn] of idMaps) out = out.replace(re, (m) => fn(m));
    out = out.replace(/\btick (\d+)\b/gi, (_, t: string) => tickToClock(Number(t)));
    out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\b/g, (m) => formatClock(m));
    // Collapse duplicate neighborhood names: "Westbank and Westbank" → "Westbank"
    const zoneNames = [...zones.values()].sort((a, b) => b.length - a.length);
    for (const name of zoneNames) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\b${esc}\\s+(?:and|&)\\s+${esc}\\b`, "gi"), name);
      out = out.replace(new RegExp(`\\b${esc}\\s*,\\s*${esc}\\b`, "gi"), name);
    }
    // Clean up leftover punctuation / whitespace from stripped refs.
    out = out.replace(/\(\s*,/g, "(").replace(/,\s*,/g, ",").replace(/\(\s*\)/g, "");
    out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
    return out;
  };

  return { zone, facility, route, routeShort, corridor, humanize, time: tickToClock, clock: formatClock };
}

// ---------------------------------------------------------------------------
// Agent metadata — plain-English identities for the 9 agents
// ---------------------------------------------------------------------------

export interface AgentMeta {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
}

export const AGENTS: AgentMeta[] = [
  { id: "intake", name: "Intake", role: "Understands your request", icon: "message", color: "#94a3b8" },
  { id: "weather", name: "Weather Analyst", role: "Storm timing and flood risk", icon: "cloud", color: "#38bdf8" },
  { id: "power", name: "Grid Analyst", role: "Outages and hospital power", icon: "zap", color: "#fbbf24" },
  { id: "traffic", name: "Traffic Analyst", role: "Routes and evacuation flow", icon: "route", color: "#34d399" },
  { id: "shelter", name: "Shelter Planner", role: "Beds, buses, and staging", icon: "home", color: "#c084fc" },
  { id: "commander", name: "Commander", role: "Synthesizes the single plan", icon: "shield", color: "#f472b6" },
  { id: "safety", name: "Safety Reviewer", role: "Blocks unsafe actions", icon: "check", color: "#fb923c" },
  { id: "comms", name: "Comms Writer", role: "Drafts public alerts", icon: "megaphone", color: "#22d3ee" },
  { id: "briefing", name: "Briefing Author", role: "Writes the handoff report", icon: "file", color: "#a3e635" },
];

export const agentMeta = (id: string): AgentMeta =>
  AGENTS.find((a) => a.id === id || id.startsWith(`${a.id}(`)) ?? {
    id,
    name: id,
    role: "",
    icon: "bot",
    color: "#94a3b8",
  };

// ---------------------------------------------------------------------------
// Tool-call humanizer — "weather.get_rainfall_risk" → "Checking rainfall flood risk"
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  "geo.geocode": "Resolving the area you described",
  "geo.get_zone_boundaries": "Pulling neighborhood boundaries and population",
  "geo.find_nearby_facilities": "Finding nearby facilities",
  "geo.calculate_distance": "Measuring distances",
  "geo.overlay_risk_layers": "Computing the city risk score",
  "grid.get_outages": "Reading live outage data",
  "grid.get_affected_zones": "Mapping which neighborhoods are dark",
  "grid.get_critical_facilities": "Checking hospitals and water plants on the outage",
  "grid.estimate_restoration_priority": "Ranking power restoration priorities",
  "weather.get_forecast": "Fetching the storm forecast",
  "weather.get_alerts": "Checking severe weather alerts",
  "weather.get_rainfall_risk": "Assessing rainfall flood risk",
  "weather.get_wind_risk": "Checking wind risk for crews",
  "traffic.get_congestion": "Reading live congestion",
  "traffic.get_road_closures": "Checking road and bridge closures",
  "traffic.find_routes": "Comparing evacuation routes",
  "traffic.estimate_evacuation_time": "Modeling evacuation time",
  "shelters.list": "Checking shelter capacity",
  "shelters.get_capacity": "Checking shelter capacity",
  "shelters.assign_population": "Proposing shelter assignments",
  "resources.get_available_units": "Finding available crews and buses",
  "resources.recommend_staging": "Optimizing where to stage resources",
  "resources.assign_unit": "Requesting a unit assignment",
  "comms.draft_public_alert": "Drafting the public alert",
  "comms.draft_internal_update": "Drafting the internal team update",
  "safety.evaluate_action": "Checking an action against safety policy",
  "safety.require_approval": "Queuing an action for your approval",
  "audit.log_event": "Writing to the audit trail",
  "sim.run_what_if": "Simulating a what-if",
  "sim.compare_response_plans": "Comparing plan versions",
  "report.export_markdown": "Rendering the incident brief",
};

export function toolLabel(tool: string): string {
  const dotted = tool.replaceAll("_", ".").replace(/\.(?=[a-z]+\.)/, ".");
  // try direct, then dotted normalization of underscored names like weather_get_forecast
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  const parts = tool.split("_");
  for (let i = 1; i < parts.length; i++) {
    const candidate = `${parts.slice(0, i).join("_")}.${parts.slice(i).join("_")}`;
    if (TOOL_LABELS[candidate]) return TOOL_LABELS[candidate];
  }
  if (TOOL_LABELS[dotted]) return TOOL_LABELS[dotted];
  return tool.replaceAll("_", " ").replaceAll(".", " · ");
}

export const SEVERITY_COLOR: Record<string, string> = {
  info: "#64748b",
  low: "#34d399",
  medium: "#fbbf24",
  high: "#fb923c",
  critical: "#ef4444",
};

export const SEVERITY_LABEL: Record<string, string> = {
  info: "Info",
  low: "Low",
  medium: "Moderate",
  high: "High",
  critical: "Critical",
};

export const PHASES = [
  { id: "intake", label: "Understand", blurb: "Parsing your request into a structured incident" },
  { id: "assessment", label: "Investigate", blurb: "4 analysts working in parallel with live tools" },
  { id: "conflict_detection", label: "Cross-check", blurb: "Deterministic code scans findings for contradictions" },
  { id: "debate", label: "Debate", blurb: "Agents argue conflicts with evidence" },
  { id: "synthesis", label: "Decide", blurb: "Commander writes one plan; Safety reviews it" },
  { id: "comms", label: "Communicate", blurb: "Drafting alerts for your approval" },
  { id: "briefing", label: "Hand off", blurb: "Writing the briefing report" },
] as const;

export function phaseIndex(phase: string): number {
  return PHASES.findIndex((p) => p.id === phase);
}
