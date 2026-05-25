/**
 * Geospatial utility helpers.
 * For provider proximity queries we use PostGIS via raw SQL.
 * These helpers handle input validation and coordinate formatting.
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Validate that lat/lng values are within valid ranges.
 */
export function isValidCoordinates(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Convert kilometres to metres (PostGIS ST_DWithin uses metres for geography type).
 */
export function kmToMetres(km: number): number {
  return km * 1000;
}

/**
 * Build a PostGIS geography point literal from coordinates.
 * Used in raw SQL queries.
 */
export function toPostGISPoint(lat: number, lng: number): string {
  return `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
}

/**
 * Haversine formula — great-circle distance in km between two points.
 * Used as a fallback when PostGIS is not available (e.g. tests).
 */
export function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
