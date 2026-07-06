# 08 — UI/UX Structure

The UI must read as a **city operations center**, not a SaaS admin panel. Map-first, dark, dense but legible, everything live.

## 1. Visual direction

- **Theme**: near-black slate background (`#0B0F14`), thin borders, high-contrast data ink. One accent per severity: info `#3B82F6`, low `#22C55E`, medium `#EAB308`, high `#F97316`, critical `#EF4444` — used consistently across map, chips, gauge, timeline.
- **Map**: MapLibre GL, dark basemap (OpenFreeMap "dark" or Protomaps dark). Zone fills tinted by risk band with 25–40% opacity; pulsing outline animation on the active incident zones.
- **Typography**: Inter for UI; JetBrains Mono for timestamps, IDs, tool calls, and the audit log — the mono touches sell "command center".
- **Motion**: findings/cards slide-fade in as SSE events arrive; risk gauge animates on change; no decorative animation anywhere else.
- **Status chips everywhere**: `LIVE DATA` / `SCENARIO` / `SIMULATED` badges on every data element (honesty requirement doubles as visual texture).
- **Server-driven truth**: the dashboard must render server snapshots and SSE events, not browser-scripted fake progress. Cinematic motion is allowed only when it is dramatizing real state transitions, agent events, or source freshness changes.

## 2. Layout: single-page command center with rail navigation

```
┌──┬─────────────────────────────────────────────┬───────────────────┐
│  │  TOP BAR: incident title · sim clock 18:05 · │ RISK 78 ▲ HIGH    │
│R │  scenario controls ▶ ⏸ ⏩ · DEMO MODE badge  │ (gauge)           │
│A ├─────────────────────────────────────────────┼───────────────────┤
│I │                                             │  RIGHT PANEL      │
│L │              CRISIS MAP                     │  (tabbed)         │
│  │   zones · facilities · routes · closures    │  · Plan           │
│8 │   risk heat · shelter fill rings            │  · Agent Room     │
│i │                                             │  · Action Queue   │
│c │                                             │  · Comms          │
│o ├─────────────────────────────────────────────┤  · Report         │
│n │  TIMELINE STRIP: ticks · events · scrubber  │                   │
│s │  EVT-004 outage expands ─●───────▶          │                   │
└──┴─────────────────────────────────────────────┴───────────────────┘
```

The map never leaves the screen. Rail icons switch the right panel and add map layers; two rail items (What-If, Evidence) open full-screen overlays.

## 3. The 8 screens/panels

### 3.1 Crisis Dashboard (default)
Right panel = Plan tab. Answers the five questions at a glance: what (incident card), where (map), who (affected population counter + vulnerability callout), what to do (top 3 immediate actions), what's risky (unresolved risks strip). Command input box at bottom of panel: *"Ask CrisisGrid…"* — this is where the demo sentence is typed.

### 3.2 Map / Risk Zones
Layer toggles: risk heat, outages, floodplain, congestion (corridor coloring), routes (recommended = solid accent, rejected = dashed gray with ⚠ reason tooltip — the rejected Route 12 stays visible; that's the debate made spatial), shelters (donut ring = fill %), facilities, closures. Clicking any entity opens an inspector with its state history and every finding referencing it.

### 3.3 Agent Room
The multi-agent showpiece. Left: 9 agent tiles (avatar, status: idle/thinking/done/error, finding count, model badge). Center: streaming feed of finding cards — `severity chip · agent · finding sentence · confidence bar · evidence (n) popover · recommended action`. Debate exchanges render as connected threads between two agent tiles with stance icons (confirm ✓ / contest ⚔ / amend ✎). Commander's conflict resolutions pinned at top with rationale.

Tool-call ticker along the bottom (mono font): `18:04:12 traffic_agent → traffic.find_routes {Z-05→Z-07} 3 routes 412ms` — continuous proof of real tool use.

### 3.4 Action Queue
Three columns by tier: **Executed/Safe** (gray), **Needs Approval** (amber, with Approve/Reject buttons + evidence summary + what-will-happen text), **Blocked** (red, with policy reason — never hidden). Approving fires the token flow; card animates to Executed with audit id. Filter by team.

### 3.5 What-If Simulator (overlay)
Left: event injection cards (`WHATIF-BRIDGE`, `WHATIF-RAIN`, …) + free-text what-if input (parsed by Intake to nearest supported injections). Run → split view: **plan A | plan B** with inline diff highlighting, risk delta gauge (78 → 91), map ghosting (old route dashed, new route solid), and the Commander's `changeExplanations` as a narrated list. Buttons: `Discard` / `Adopt into live state (needs approval)`.

### 3.6 Incident Report
Rendered markdown preview of the brief with sticky section nav; `Download .md` + `Copy`. Approvals and blocked actions rendered as stamped rows with audit hashes.

### 3.7 Scenario Timeline
Full-width horizontal timeline: ticks, fired events (with the operational text from `timeline.json`), plan revisions as milestones, approvals as stamps. Scrubbing moves the map to that tick's state (read-only past view).

### 3.8 Rubric Evidence / Architecture ("Judge Mode")
A self-documenting screen for judges: architecture diagram, agent roster, live MCP `tools/list` dump, eval results table (green/red), security checklist, data-source honesty table, links to repo/docs. Cheap to build, disproportionately valuable at judging.

## 4. Component tree (React)

```
<App>
 ├─ <SSEProvider>            // one EventSource → dispatch to Zustand stores
 ├─ <TopBar>                 // sim clock, scenario controls, risk gauge
 ├─ <NavRail>
 ├─ <CrisisMap>              // MapLibre; layer components subscribe to stores
 │   ├─ <ZoneRiskLayer> <OutageLayer> <FloodLayer> <CongestionLayer>
 │   ├─ <RouteLayer> <ShelterLayer> <FacilityLayer> <ClosureLayer>
 │   └─ <EntityInspector>
 ├─ <TimelineStrip>
 └─ <RightPanel>
     ├─ <PlanPanel>          // IAP: phases, objectives, actions, risks
     ├─ <AgentRoom>          // tiles, finding feed, debate threads, tool ticker
     ├─ <ActionQueue>
     ├─ <CommsPanel>         // drafts w/ channel previews (phone-frame SMS mock)
     └─ <ReportPanel>
 <WhatIfOverlay>  <JudgeMode>
```

State: one Zustand store per event family (`scenarioStore`, `findingsStore`, `planStore`, `actionsStore`, `debateStore`). SSE reducer is the only writer; components are pure subscribers — keeps live updates trivial to reason about.

Live operations mode adds `sourceStore` and `providerStore` for source metadata, provider health, freshness, and fallback state. Map layers must subscribe to those stores so every entity can answer "where did this number come from?"

## 5. UX rules

1. **Nothing is modal during the demo** except What-If — the map and timeline stay visible while agents run.
2. **Every number is clickable** → evidence popover (tool call, source badge, timestamp).
3. **Empty states narrate**: before intake, panels show "Awaiting incident — try: 'Assess the west-side outage…'" (demo affordance).
4. **Latency theater**: while agents run, the Agent Room MUST show per-agent progress and streaming tool calls — a 45-second wait that shows work feels fast; a spinner feels broken.
5. **Approve buttons state consequences**: "Publishes to the simulated public feed. No real alert is sent." under every approval.
6. Keyboard: `1–8` rail switch, `space` play/pause scenario, `w` what-if overlay.
7. **No fake liveness**: demo animations are acceptable in first-run/tutorial mode, but the operational dashboard uses `/api/incidents`, `/api/actions`, server map snapshots, and `EventSource("/api/events")` as its data path.
