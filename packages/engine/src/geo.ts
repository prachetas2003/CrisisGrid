import type { LngLat } from "@crisisgrid/shared";

/** Small deterministic geo helpers. No external deps, unit-tested. */

/** Ray-casting point-in-polygon (outer ring only — our polygons have no holes). */
export function pointInPolygon(point: LngLat, ring: LngLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Haversine distance in km. */
export function distanceKm(a: LngLat, b: LngLat): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function polygonCentroid(ring: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  // Skip the closing coordinate (equal to the first).
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    x += ring[i]![0];
    y += ring[i]![1];
  }
  return [x / n, y / n];
}
