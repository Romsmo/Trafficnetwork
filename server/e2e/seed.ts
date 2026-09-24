/**
 * Test data: a small "town" in Munich. The layout is deliberate: the bounding box of all segments is centred on
 * MAP_CENTER, and only the vertical 50 km/h street passes through that point — the node opens its map on the
 * region's bounding box, so a click on the middle of the map reliably meets exactly that street.
 *
 *        30 km/h (north)
 *   +------------------------+  lat 48.150
 *   |          |             |
 *   |          | 50 km/h     |
 *   |          |             |
 *   +------------------------+  lat 48.125
 *        30 km/h (south)
 */
export const MAP_CENTER = { lat: 48.1375, lng: 11.5755 } as const;

export const SEGMENTS: Array<{ line: Array<[number, number]>; kmh: number }> = [
  { line: [[11.56, 48.15], [11.591, 48.15]], kmh: 30 },
  { line: [[11.56, 48.125], [11.591, 48.125]], kmh: 30 },
  { line: [[MAP_CENTER.lng, 48.125], [MAP_CENTER.lng, 48.15]], kmh: 50 },
  // A few more streets inside the bounding box (each at least 300 m from the map centre, so the middle of the map still
  // meets only the 50 km/h street) — they make the speed-limit layer look like a small town in the screenshots.
  { line: [[11.562, 48.134], [11.589, 48.134]], kmh: 50 },
  { line: [[11.565, 48.141], [11.586, 48.141]], kmh: 30 },
  { line: [[11.563, 48.131], [11.575, 48.1305]], kmh: 30 },
  { line: [[11.5685, 48.126], [11.5685, 48.149]], kmh: 30 },
  { line: [[11.5825, 48.127], [11.5825, 48.1485]], kmh: 70 },
  { line: [[11.587, 48.128], [11.587, 48.148]], kmh: 30 },
  { line: [[11.565, 48.146], [11.5755, 48.1445], [11.588, 48.1462]], kmh: 50 },
];

/** Where the tests put their hazard reports (a few hundred metres around the map centre). */
export function nearCenter(dLat = 0, dLng = 0): { lat: number; lng: number } {
  return { lat: MAP_CENTER.lat + dLat, lng: MAP_CENTER.lng + dLng };
}
