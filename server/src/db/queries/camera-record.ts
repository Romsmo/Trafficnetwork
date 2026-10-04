/**
 * What the camera queries return: the public API shape of a camera (`item`) together with the two facts the delivery
 * layer needs but a client must never be sent as such — the camera's country set and its own position
 * (docs/camera-country-policy.md). Keeping them beside the item, instead of inside it, means a forgotten `.map()` cannot
 * put an internal field on the wire, and that nothing can reach the wire without first passing the policy projection.
 */
export interface CameraRecord<T> {
  item: T;
  /** Countries within the border strip of the camera (strictest wins); null = never resolved, [] = no known country. Both mean "not delivered". */
  countries: string[] | null;
  lat: number;
  lng: number;
}

interface GeoJsonPoint {
  coordinates?: [number, number];
}

/** [lng, lat] of a GeoJSON Point as the queries return it (ST_AsGeoJSON(...)::json). */
export function pointOf(position: unknown): { lat: number; lng: number } {
  const coordinates = (position as GeoJsonPoint | null | undefined)?.coordinates;
  if (!coordinates || coordinates.length < 2) throw new Error("camera position is not a GeoJSON Point");
  return { lng: coordinates[0], lat: coordinates[1] };
}

export function toRecord<T extends { position: unknown }>(item: T, countries: string[] | null | undefined): CameraRecord<T> {
  const { lat, lng } = pointOf(item.position);
  return { item, countries: countries ?? null, lat, lng };
}
