# 05 — MCP Tool Catalog

One TypeScript MCP server (`packages/mcp-server`) exposes all tools. Agents access data **only** through these tools (eval-enforced: the agents package has no HTTP client except the MCP transport).

## 1. Conventions

- **Naming**: `namespace.verb_noun` (dots in docs; registered as `namespace_verb_noun` for MCP name compatibility).
- **Validation**: every tool validates input AND output with Zod; invalid output is a server error, never silently returned.
- **Evidence envelope**: every tool result is wrapped:

```typescript
type ToolResult<T> = {
  toolCallId: string;         // logged to tool_calls table → citable as evidence
  source: "live" | "scenario" | "computed";
  provider?: string;          // Open-Meteo, NWS, scenario, manual import, etc.
  asOf: string;               // sim-time or wall-time
  freshness?: "fresh" | "stale" | "fallback" | "unknown";
  data: T;
};
```

Live operations mode extends this envelope as described in `13-live-data-real-app-plan.md`. No UI element or report row should display live-looking data without source/provider/asOf/freshness metadata.

- **Safety tier** is declared in the tool registry (`registry.ts`), not in prompts. Tiers:
  - **safe** — read/compute/draft; agents call freely.
  - **approval** — has side effects visible outside the analysis (publish, assign, notify); MCP server executes only if a valid approval token from the action queue is passed; otherwise returns `PENDING_APPROVAL` and enqueues.
  - **blocked** — exists to be refused; always returns a structured refusal + audit entry. (Deliberately includes one demo-able blocked tool.)
- Common types below: `Zone = string (Z-01..Z-16)`, `GeoJSON = RFC7946 geometry`, `SimTime = ISO string in scenario clock`.

## 2. Catalog

### weather.* (source: live NWS/Open-Meteo with scenario override — see doc 06)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `weather.get_forecast` | Hourly forecast for a point/zone | `{zone? , lat?, lon?, hours=12}` → `{periods[]: {time, tempC, precipMmHr, windKmh, summary}}` | safe |
| `weather.get_alerts` | Active severe weather alerts | `{area}` → `{alerts[]: {type, severity, onset, expires, headline}}` | safe |
| `weather.get_rainfall_risk` | Rain intensity + flood-relevant accumulation per zone | `{zones[], horizonMin}` → `{perZone[]: {zone, peakMmHr, accumMm, floodRelevance: low\|med\|high, peakAt}}` | safe |
| `weather.get_wind_risk` | Gust risk (matters for crews/bridges) | `{zones[]}` → `{perZone[]: {zone, gustKmh, risk}}` | safe |

### grid.* (source: scenario)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `grid.get_outages` | Current outage entities | `{}` → `{outages[]: {id, substation, zones[], customersOut, cause, startedAt, status}}` | safe |
| `grid.get_affected_zones` | Zones + severity for an outage | `{outageId}` → `{zones[]: {zone, level: out\|brownout, customersOut}}` | safe |
| `grid.get_critical_facilities` | Critical facilities in given zones with power status | `{zones[]}` → `{facilities[]: {id, kind: hospital\|shelter\|signal\|water\|school, name, zone, powerStatus, backup: {type, remainingH}?}}` | safe |
| `grid.estimate_restoration_priority` | Deterministic priority ranking (weights: life-safety > signals > density) | `{outageId}` → `{ranked[]: {circuitId, reason, estCrewHours, facilities[]}}` | safe |

### traffic.* (source: scenario congestion + OSRM routing on real OSM roads)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `traffic.get_congestion` | Congestion per corridor | `{zones[]?}` → `{corridors[]: {id, name, level0to1, trend, signalStatus}}` | safe |
| `traffic.get_road_closures` | Active closures incl. bridges | `{}` → `{closures[]: {id, name, kind, since, reason, geo: GeoJSON}}` | safe |
| `traffic.find_routes` | Candidate routes A→B with hazard exposure overlay | `{fromZone, toZone, count=3}` → `{routes[]: {id, name, etaMin, distanceKm, congestionFactor, hazards[]: {kind, zone, activeFrom?}, geo}}` | safe |
| `traffic.estimate_evacuation_time` | People-throughput model for a route | `{routeId, population, transport: mixed\|bus\|car}` → `{totalMin, bottleneck, assumptions[]}` | safe |

### geo.* (source: scenario GeoJSON + computed)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `geo.geocode` | Resolve names ("west side", "Cedar & 5th") to zones/coords | `{query}` → `{matches[]: {zone?, lat, lon, label, confidence}}` | safe |
| `geo.get_zone_boundaries` | Zone polygons + metadata | `{zones[]?}` → `{features[]: GeoJSON w/ {population, density, vulnerabilityIndex}}` | safe |
| `geo.find_nearby_facilities` | Facilities within radius of point/zone | `{zone?, lat?, lon?, kinds[], radiusKm}` → `{facilities[]}` | safe |
| `geo.calculate_distance` | Distance/time between entities | `{fromId, toId, mode}` → `{km, etaMin}` | safe |
| `geo.overlay_risk_layers` | **The risk engine.** Weighted zone risk from outage, flood, congestion, vulnerability, facility criticality, shelter distance | `{zones[]?, weights?}` → `{perZone[]: {zone, score0to100, band: low\|med\|high\|critical, factors: {…each factor's contribution}}, cityScore}` | safe |

`geo.overlay_risk_layers` is deterministic and unit-tested; it is the single source of the risk score shown in the UI and cited by the Commander.

### shelters.* / resources.* (source: scenario)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `shelters.list` | All shelters + status | `{}` → `{shelters[]: {id, name, zone, capacity, occupied, powerStatus, accessible, petFriendly}}` | safe |
| `shelters.get_capacity` | Point-in-time capacity | `{shelterId}` → `{capacity, occupied, trendPerHour}` | safe |
| `shelters.assign_population` | Propose assignment; **rejects overflow**, returns remainder | `{assignments[]: {zone, shelterId, count}}` → `{accepted[], rejected[]: {…, reason, remainder}}` | **approval** |
| `resources.get_available_units` | Crews/buses/generators/pumps + locations | `{kinds[]?}` → `{units[]: {id, kind, zone, status, capacity?}}` | safe |
| `resources.recommend_staging` | Optimizer: units → staging areas under travel-time constraints | `{objective, constraints}` → `{staging[]: {unitId, location, arriveBy, rationale}}` | safe |
| `resources.assign_unit` | Commit a unit to a task (simulated dispatch) | `{unitId, task, location}` → `{assignmentId, label: "SIMULATED"}` | **approval** |

### comms.* (source: templates + validation; sandbox feed only)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `comms.draft_public_alert` | Validate/format a draft (length, banned claims, required elements) | `{channel: sms\|social\|email, body, factsUsed[]}` → `{draftId, validated, issues[]}` | safe |
| `comms.draft_internal_update` | Same for internal updates | `{audienceTeam, body}` → `{draftId, validated, issues[]}` | safe |
| `comms.send_sandbox_alert` | Publish to in-app demo feed (visibly watermarked SIMULATED) | `{draftId, approvalToken}` → `{publishedAt, feedUrl}` | **approval** |
| `comms.broadcast_all_channels` | **Intentionally blocked** — real-broadcast stand-in for the demo | any → structured refusal `{blocked: true, reason, policyRef}` | **blocked** |

### sim.* (source: scenario engine, via server API)

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `sim.load_scenario` | Load/reset a scenario | `{scenarioId}` → `{tick, simTime, summary}` | safe |
| `sim.advance_time` | Advance N ticks (fires timeline events) | `{ticks}` → `{newTick, firedEvents[]}` | **approval** (changes shared demo state) |
| `sim.inject_event` | Fire a what-if event | `{eventId: WHATIF-*}` → `{applied, changedEntities[]}` | **approval** |
| `sim.run_what_if` | Sandbox-fork state, apply events, return forked state handle (no mutation of live state) | `{eventIds[]}` → `{forkId, changedEntities[]}` | safe |
| `sim.compare_response_plans` | Structured diff of two plans | `{planIdA, planIdB}` → `PlanDiff {riskDelta, routeChanges[], shelterChanges[], addedActions[], removedActions[], modifiedActions[]}` | safe |

### report.* / audit.* / safety.*

| Tool | Purpose | Input → Output | Tier |
|---|---|---|---|
| `report.generate_incident_brief` | Assemble brief data bundle from DB (findings, plan, approvals, tool calls) | `{incidentId}` → `{bundle}` | safe |
| `report.generate_action_plan` | ICS-style IAP data bundle | `{planId}` → `{bundle}` | safe |
| `report.export_markdown` | Render bundle + narrative to markdown, persist | `{bundle, narrativeSections}` → `{reportId, url}` | safe |
| `audit.log_event` | Append-only audit entry (auto-called by server for all tier events too) | `{actor, eventType, detail}` → `{auditId, contentHash}` | safe |
| `safety.evaluate_action` | Deterministic classification of a proposed action against policy rules | `{action}` → `{tier, matchedRules[], requiredEvidence[]}` | safe |
| `safety.require_approval` | Enqueue action for human approval | `{actionId}` → `{queuePosition, status}` | safe |
| `safety.record_approval` | Record operator decision (called by server on UI click, not by agents) | `{actionId, decision, operator}` → `{approvalToken?}` | **approval** |
| `safety.block_action` | Record a block with reason | `{actionId, reason, policyRef}` → `{auditId}` | safe |

## 3. Enforcement flow for approval-tier tools

```mermaid
sequenceDiagram
    participant Agent
    participant MCP as MCP server
    participant SRV as Action Queue (server)
    participant Op as Operator (UI)

    Agent->>MCP: comms.send_sandbox_alert {draftId}   (no token)
    MCP->>SRV: enqueue action, tier=needs_approval
    MCP-->>Agent: {status: "PENDING_APPROVAL", actionId}
    Note over Agent: Agent includes actionId in plan;\ndoes NOT retry or work around
    Op->>SRV: click Approve
    SRV->>SRV: safety.record_approval → approvalToken (single-use, hashed, 15-min TTL)
    SRV->>MCP: execute comms.send_sandbox_alert {draftId, approvalToken}
    MCP->>MCP: verify token, publish to sandbox feed
    MCP->>SRV: audit.log_event (auto)
```

Structural guarantee: agents never hold approval tokens. Only the server mints and spends them. A prompt-injected or misbehaving agent physically cannot publish.

## 4. Implementation notes for the builder

- Register tools from a single `registry.ts` array: `{name, description, inputSchema, outputSchema, tier, handler, source}`. The MCP `tools/list` response, the docs table above, and `crisisgrid mcp inspect` all derive from this one array — they can never drift.
- Handlers for `scenario`-source tools read SQLite `scenario_state` at the current tick. Handlers for `live`-source tools call adapters with a scenario-fallback (doc 06 §4).
- Log every call to `tool_calls` with args digest + result digest before returning — this table powers the UI evidence popovers and eval #13 (no bypass).
- Total: **35 tools**. Build order: grid/geo/shelters/sim first (M1 — needed for the pipeline), weather/traffic adapters next (M2), comms/report/safety/audit with the action queue (M2–M3).
