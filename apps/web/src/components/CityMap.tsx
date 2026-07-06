import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map as MlMap, Marker } from "maplibre-gl";
import { useStore } from "../store/store";
import {
  BAND_COLOR,
  VERDICT_COLOR,
  facilityStatuses,
  routeVerdicts,
  weatherState,
  zoneStatuses,
} from "../lib/derive";
import type { Corridor, MapSnapshot } from "../lib/types";

const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const CENTER: [number, number] = [-122.655, 45.512];

/**
 * The city map. Real dark basemap over the scenario's real Portland-area
 * coordinates; zones as risk-colored fills labeled by neighborhood name;
 * facility markers with plain-language status; routes with verdict badges.
 * Everything clickable → inspector card.
 */
export function CityMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const loadedRef = useRef(false);
  const snapshot = useStore((s) => s.snapshot);
  const whatifResult = useStore((s) => s.whatifResult);
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selected);

  const highlightZones = useMemo(() => {
    if (!whatifResult) return new Set<string>();
    return new Set([
      ...whatifResult.affectedZones,
      ...whatifResult.riskDelta.filter((d) => d.beforeBand !== d.afterBand || Math.abs(d.after - d.before) >= 1).map((d) => d.zone),
    ]);
  }, [whatifResult]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP,
      center: CENTER,
      zoom: 11.35,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;

    map.on("load", () => {
      loadedRef.current = true;
      const snap = useStore.getState().snapshot;
      const sel = useStore.getState().selected;
      if (snap) syncMapData(map, snap, sel, highlightZones, !!whatifResult);
      wireInteractions(map, select);
    });
    map.on("error", () => {
      /* basemap tile errors are non-fatal; overlays still render */
    });

    return () => {
      for (const m of markersRef.current) m.remove();
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !snapshot) return;
    if (loadedRef.current) {
      syncMapData(map, snapshot, selected, highlightZones, !!whatifResult);
      syncMarkers(map, snapshot, markersRef, select, selected);
    } else {
      map.once("load", () => {
        syncMapData(map, snapshot, selected, highlightZones, !!whatifResult);
        syncMarkers(map, snapshot, markersRef, select, selected);
      });
    }
  }, [snapshot, select, selected, whatifResult, highlightZones]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// ---------------------------------------------------------------------------

function zoneCollection(snapshot: MapSnapshot) {
  const statuses = zoneStatuses(snapshot);
  return {
    type: "FeatureCollection" as const,
    features: snapshot.geometry.city.features
      .filter((f) => f.properties.kind === "zone")
      .map((f) => {
        const zoneId = f.properties.zoneId as string;
        const st = statuses.get(zoneId);
        return {
          ...f,
          properties: {
            ...f.properties,
            band: st?.band ?? "low",
            score: st?.score ?? 0,
            hasOutage: st?.hasOutage ?? false,
          },
        };
      }),
  };
}

function floodplainCollection(snapshot: MapSnapshot) {
  return {
    type: "FeatureCollection" as const,
    features: snapshot.geometry.city.features.filter((f) => f.properties.kind === "floodplain"),
  };
}

function routeFeature(corridors: Corridor[], corridorIds: string[]) {
  const coords: [number, number][] = [];
  for (const id of corridorIds) {
    const c = corridors.find((x) => x.id === id);
    if (!c) continue;
    for (const pt of c.geo.coordinates) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
    }
  }
  return coords;
}

function routeCollection(snapshot: MapSnapshot) {
  const verdicts = routeVerdicts(snapshot);
  return {
    type: "FeatureCollection" as const,
    features: verdicts.map((v) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: routeFeature(snapshot.geometry.network.corridors, v.route.corridorIds),
      },
      properties: {
        routeId: v.route.id,
        verdict: v.verdict,
        label: v.label,
        color: VERDICT_COLOR[v.verdict],
      },
    })),
  };
}

function ensureSource(map: MlMap, id: string, data: GeoJSON.GeoJSON) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

function syncMapData(map: MlMap, snapshot: MapSnapshot, selected: any, highlightZones: Set<string>, whatifActive: boolean) {
  ensureSource(map, "zones", zoneCollection(snapshot) as GeoJSON.GeoJSON);
  ensureSource(map, "floodplains", floodplainCollection(snapshot) as GeoJSON.GeoJSON);
  ensureSource(map, "routes", routeCollection(snapshot) as GeoJSON.GeoJSON);

  if (!map.getLayer("zones-fill")) {
    map.addLayer({
      id: "zones-fill",
      type: "fill",
      source: "zones",
      paint: {
        "fill-color": [
          "match",
          ["get", "band"],
          "severe",
          BAND_COLOR.severe,
          "high",
          BAND_COLOR.high,
          "moderate",
          BAND_COLOR.moderate,
          BAND_COLOR.low,
        ],
        "fill-opacity": ["match", ["get", "band"], "severe", 0.4, "high", 0.34, "moderate", 0.24, 0.12],
      },
    });
    map.addLayer({
      id: "zones-line",
      type: "line",
      source: "zones",
      paint: { "line-color": "#3b5378", "line-width": 1, "line-opacity": 0.6 },
    });
    map.addLayer({
      id: "zones-label",
      type: "symbol",
      source: "zones",
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11.5,
        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
        "text-letter-spacing": 0.04,
      },
      paint: {
        "text-color": "#dbe6f5",
        "text-halo-color": "#06090f",
        "text-halo-width": 1.4,
      },
    });
    map.addLayer({
      id: "floodplains-fill",
      type: "fill",
      source: "floodplains",
      paint: { "fill-color": "#38bdf8", "fill-opacity": 0.1 },
    });
    map.addLayer({
      id: "floodplains-line",
      type: "line",
      source: "floodplains",
      paint: {
        "line-color": "#38bdf8",
        "line-width": 1.6,
        "line-dasharray": [2, 2],
        "line-opacity": 0.8,
      },
    });
    map.addLayer({
      id: "routes-casing",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#06090f", "line-width": 7, "line-opacity": 0.7 },
    });
    map.addLayer({
      id: "routes-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["match", ["get", "verdict"], "recommended", 4, 3],
        "line-opacity": ["match", ["get", "verdict"], "open", 0.5, 0.95],
        "line-dasharray": ["match", ["get", "verdict"], "avoid", ["literal", [1.5, 1.5]], ["literal", [1, 0]]],
      },
    });
  }

  // Selected overlays (recreated or updated filters)
  if (!map.getLayer("zones-selected-line")) {
    map.addLayer({
      id: "zones-selected-line",
      type: "line",
      source: "zones",
      paint: { "line-color": "#fbbf24", "line-width": 3, "line-opacity": 0.9 },
    });
  }
  if (!map.getLayer("routes-selected-line")) {
    map.addLayer({
      id: "routes-selected-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fbbf24", "line-width": 5.5, "line-opacity": 0.95 },
    });
  }

  const selectedZoneId = selected?.kind === "zone" ? selected.id : "";
  map.setFilter("zones-selected-line", ["==", ["get", "zoneId"], selectedZoneId]);

  const selectedRouteId = selected?.kind === "route" ? selected.id : "";
  map.setFilter("routes-selected-line", ["==", ["get", "routeId"], selectedRouteId]);

  if (map.getLayer("routes-line")) {
    map.setPaintProperty(
      "routes-line",
      "line-width",
      whatifActive ? ["match", ["get", "verdict"], "avoid", 5.5, "recommended", 4.5, 3] : ["match", ["get", "verdict"], "recommended", 4, 3],
    );
  }

  syncWhatIfHighlightLayers(map, highlightZones);
}

/** Purple overlay — filter-based so highlights update reliably after setData. */
function syncWhatIfHighlightLayers(map: MlMap, highlightZones: Set<string>) {
  if (!map.getSource("zones")) return;

  // Remove legacy layer from earlier builds (data-driven line-width never updated reliably).
  if (map.getLayer("zones-whatif")) map.removeLayer("zones-whatif");

  if (!map.getLayer("zones-whatif-fill")) {
    map.addLayer({
      id: "zones-whatif-fill",
      type: "fill",
      source: "zones",
      filter: ["==", ["get", "zoneId"], ""],
      paint: { "fill-color": "#a78bfa", "fill-opacity": 0.38 },
    });
  }
  if (!map.getLayer("zones-whatif-outline")) {
    map.addLayer({
      id: "zones-whatif-outline",
      type: "line",
      source: "zones",
      filter: ["==", ["get", "zoneId"], ""],
      paint: {
        "line-color": "#e9d5ff",
        "line-width": 4,
        "line-opacity": 1,
        "line-dasharray": [2, 1.5],
      },
    });
  }

  const ids = [...highlightZones];
  const filter: maplibregl.FilterSpecification =
    ids.length > 0 ? ["in", ["get", "zoneId"], ["literal", ids]] : ["==", ["get", "zoneId"], ""];

  map.setFilter("zones-whatif-fill", filter);
  map.setFilter("zones-whatif-outline", filter);

  // Keep highlights below routes and floodplains but above base zones.
  if (map.getLayer("zones-whatif-outline") && map.getLayer("routes-casing")) {
    map.moveLayer("zones-whatif-outline", "routes-casing");
  }
  if (map.getLayer("zones-whatif-fill")) {
    map.moveLayer("zones-whatif-fill", "zones-whatif-outline");
  }
}

function wireInteractions(map: MlMap, select: (sel: { kind: "zone" | "facility" | "route"; id: string } | null) => void) {
  map.on("click", "zones-fill", (e) => {
    const f = e.features?.[0];
    if (f) select({ kind: "zone", id: f.properties.zoneId as string });
  });
  map.on("click", "routes-line", (e) => {
    const f = e.features?.[0];
    if (f) select({ kind: "route", id: f.properties.routeId as string });
  });
  for (const layerId of ["zones-fill", "routes-line"]) {
    map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
  }
}

const FACILITY_ICON: Record<string, string> = {
  hospital: "H",
  shelter: "S",
  substation: "⚡",
  water: "W",
  staging: "◆",
};

function syncMarkers(
  map: MlMap,
  snapshot: MapSnapshot,
  markersRef: { current: Marker[] },
  select: (sel: { kind: "zone" | "facility" | "route"; id: string } | null) => void,
  selected: any,
) {
  for (const m of markersRef.current) m.remove();
  markersRef.current = [];

  const toneColor = { ok: "#34d399", warn: "#fbbf24", danger: "#ef4444" } as const;

  for (const st of facilityStatuses(snapshot)) {
    const el = document.createElement("button");
    el.className = "group relative flex items-center";
    el.style.cursor = "pointer";
    const color = toneColor[st.tone];
    
    const isSelected = selected?.kind === "facility" && selected.id === st.facility.id;
    const borderStyle = isSelected ? `3px solid #fbbf24` : `2px solid ${color}`;
    const scale = isSelected ? "transform: scale(1.3);" : "";
    const shadow = isSelected ? "box-shadow: 0 0 15px #fbbf24;" : "box-shadow: 0 2px 8px rgba(0,0,0,.6);";
    const textColor = isSelected ? "#fbbf24" : color;

    el.innerHTML = `
      <span style="
        display:flex;align-items:center;justify-content:center;
        width:22px;height:22px;border-radius:7px;
        background:#0c121c;border:${borderStyle};
        color:${textColor};font:700 11px Inter,sans-serif;
        ${shadow} ${scale} transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      ">${FACILITY_ICON[st.facility.kind] ?? "•"}</span>
      ${st.tone !== "ok" ? `<span style="position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:${color};animation:pulse-dot 1.2s ease-in-out infinite"></span>` : ""}
    `;
    el.title = `${st.facility.name} — ${st.headline}`;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      select({ kind: "facility", id: st.facility.id });
    });
    const marker = new maplibregl.Marker({ element: el }).setLngLat([st.facility.lon, st.facility.lat]).addTo(map);
    markersRef.current.push(marker);
  }

  // Route verdict badges at route midpoints
  const verdicts = routeVerdicts(snapshot);
  for (const v of verdicts) {
    if (v.route.fromZone !== "Z-05" || v.route.toZone !== "Z-07") continue; // badge only the evacuation set
    const coords = routeFeature(snapshot.geometry.network.corridors, v.route.corridorIds);
    if (coords.length < 2) continue;
    const mid = coords[Math.floor(coords.length / 2)]!;
    const el = document.createElement("button");
    el.style.cursor = "pointer";
    const color = VERDICT_COLOR[v.verdict];
    
    const isRouteSelected = selected?.kind === "route" && selected.id === v.route.id;
    const badgeBorder = isRouteSelected ? `2px solid #fbbf24` : `1.5px solid ${color}`;
    const badgeScale = isRouteSelected ? "transform: scale(1.15);" : "";
    const badgeShadow = isRouteSelected ? "box-shadow: 0 0 12px #fbbf24;" : "box-shadow: 0 2px 10px rgba(0,0,0,.55);";
    const badgeColor = isRouteSelected ? "#fbbf24" : color;

    el.innerHTML = `<span style="
      display:inline-block;padding:3px 9px;border-radius:999px;
      background:#0c121ce6;border:${badgeBorder};color:${badgeColor};
      font:600 10.5px Inter,sans-serif;white-space:nowrap;
      ${badgeShadow} ${badgeScale} transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter:blur(4px);
    ">${v.label}</span>`;
    
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      select({ kind: "route", id: v.route.id });
    });
    const marker = new maplibregl.Marker({ element: el, offset: [0, v.route.id === "RT-08" ? 14 : -14] })
      .setLngLat(mid as [number, number])
      .addTo(map);
    markersRef.current.push(marker);
  }

  // Storm front annotation, west of the city, if heavy rain is inbound
  const weather = weatherState(snapshot);
  if (weather.rainArrivalLabel && (weather.peakMmHr ?? 0) >= 28 && snapshot.tick < (weather.rainArrivalTick ?? 0)) {
    const el = document.createElement("div");
    el.innerHTML = `<div style="
      display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:12px;
      background:#0c121cf0;border:1.5px dashed #38bdf8;color:#7dd3fc;
      font:600 11px Inter,sans-serif;white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,.6);
    "><span style="font-size:14px">🌧</span> Heavy rain arriving ~${weather.rainArrivalLabel}</div>`;
    markersRef.current.push(
      new maplibregl.Marker({ element: el }).setLngLat([-122.723, 45.517]).addTo(map),
    );
  }
}
