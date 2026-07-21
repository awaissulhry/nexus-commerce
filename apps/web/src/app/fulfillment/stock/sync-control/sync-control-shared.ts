/**
 * Shared types + display maps for the Sync Control surfaces (listings view,
 * products view, per-product page). One source of truth so every surface
 * renders modes identically.
 */
import type { Tone } from '@/design-system/primitives'
import type { SegmentedOption } from '@/design-system/primitives'

export type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED'

export interface Row {
  lane: 'LISTING' | 'SHARED'
  sku: string
  productId: string | null
  channel: string
  marketplace: string
  mode: Mode
  intendedQty: number | null
  liveQty: number | null
  buffer: number
  routedLocations: string[]
  itemId?: string
}

export interface ProductRollup {
  listings: number
  channels: string[]
  modeCounts: Record<string, number>
  dominantMode: string | null
  uniform: boolean
  hasFba: boolean
  maxBuffer: number
  routedLocations: string[]
  driftCount: number
}

export interface ProductMaster {
  masterId: string
  sku: string
  name: string
  family: { code: string; label: string } | null
  imageUrl: string | null
  poolTotal: number
  variantsInStock: number
  variantCount: number
  rollup: ProductRollup
  children: Row[]
  listingCount: number
  childrenOmitted: boolean
}

/** DS Pill tone per mode (FBA/Uncounted neutral, Excluded danger). */
export const MODE_TONE: Record<Mode, Tone> = {
  FOLLOW: 'success',
  PINNED: 'info',
  PAUSED: 'warning',
  PAUSED_POLICY: 'warning',
  UNCOUNTED: 'neutral',
  FBA: 'neutral',
  EXCLUDED: 'danger',
}

export const MODE_LABEL: Record<Mode, string> = {
  FOLLOW: 'Follow',
  PINNED: 'Pinned',
  PAUSED: 'Paused',
  PAUSED_POLICY: 'Paused (policy)',
  UNCOUNTED: 'Uncounted',
  FBA: 'FBA',
  EXCLUDED: 'Excluded',
}

export const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

export type Density = 'compact' | 'cozy' | 'spacious'

/** Bridge the page's density vocabulary to grid-lens DensityContext. */
export function mapDensity(d: Density): 'compact' | 'comfortable' | 'spacious' {
  return d === 'cozy' ? 'comfortable' : d
}
