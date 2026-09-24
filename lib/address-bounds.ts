/**
 * lib/address-bounds.ts — the box Google address suggestions are kept inside.
 *
 * Without it, "123 Main St Oakland" can suggest Oakland, North Carolina first,
 * and a visitor who taps it gets rejected as out of area.
 *
 * Order of precedence:
 *   1. NEXT_PUBLIC_ADDRESS_BOUNDS = "south,west,north,east" (decimal degrees)
 *   2. NEXT_PUBLIC_SERVICE_AREAS circles (each lat/lng ± radius), but only when
 *      NEXT_PUBLIC_ALLOWED_COUNTIES is NOT set. When counties are configured
 *      they are the real gate and the circles are ignored, so a box built from
 *      the circles could hide addresses the form would accept.
 *   3. Nothing set: no restriction (US-wide, as before).
 */

import { parseServiceAreas } from "@/lib/service-area"

export interface LatLngBoundsLiteral {
  south: number
  west: number
  north: number
  east: number
}

const MILES_PER_DEGREE_LAT = 69.0

function parseExplicitBounds(raw: string): LatLngBoundsLiteral | undefined {
  const parts = raw.split(",").map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined
  const [south, west, north, east] = parts
  if (south >= north || west >= east) return undefined
  return { south, west, north, east }
}

export function getAddressBounds(): LatLngBoundsLiteral | undefined {
  const explicit = (process.env.NEXT_PUBLIC_ADDRESS_BOUNDS ?? "").trim()
  if (explicit) {
    const parsed = parseExplicitBounds(explicit)
    if (parsed) return parsed
  }

  if ((process.env.NEXT_PUBLIC_ALLOWED_COUNTIES ?? "").trim()) return undefined

  const circles = parseServiceAreas()
  if (circles.length === 0) return undefined

  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const c of circles) {
    const dLat = c.radiusMiles / MILES_PER_DEGREE_LAT
    const dLng = c.radiusMiles / (MILES_PER_DEGREE_LAT * Math.max(0.01, Math.cos((c.lat * Math.PI) / 180)))
    south = Math.min(south, c.lat - dLat)
    north = Math.max(north, c.lat + dLat)
    west = Math.min(west, c.lng - dLng)
    east = Math.max(east, c.lng + dLng)
  }
  return { south, west, north, east }
}
