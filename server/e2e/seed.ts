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
];

/** Where the tests put their hazard reports (a few hundred metres around the map centre). */
export function nearCenter(dLat = 0, dLng = 0): { lat: number; lng: number } {
  return { lat: MAP_CENTER.lat + dLat, lng: MAP_CENTER.lng + dLng };
}
