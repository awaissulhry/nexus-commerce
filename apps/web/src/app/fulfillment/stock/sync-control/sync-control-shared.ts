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

/** SCD.3 — one parent listing sharing this product's child SKUs. */
export interface SyncFamily {
  key: string
  channel: string
  marketplace: string
  itemId: string | null
  ownerSku: string | null
  listings: number
  skus: number
  modeCounts: Record<string, number>
  driftCount: number
}

export interface ProductMaster {
  masterId: string
  /** SCD.3 — the parent listings ("families") sharing these child SKUs. */
  families?: SyncFamily[]
  /** SCD.3 — set when the payload is narrowed to one family. */
  familyKey?: string | null
  /** SCD.1 — duplicate masters folded into this group (pool-derived), for
   *  group-level bulk actions/export. Empty for a plain canonical/standalone. */
  memberMasterIds?: string[]
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

/** SCD.4 — plain-English explanation of each mode, for hover tooltips. */
export const MODE_HELP: Record<Mode, string> = {
  FOLLOW: 'Follows the shared stock pool — the marketplace quantity tracks available stock automatically.',
  PINNED: 'Held at a fixed manual quantity — pool changes never touch it until you set it back to Follow.',
  PAUSED: 'Frozen — nothing is pushed to the marketplace until you Resume it.',
  PAUSED_POLICY: 'Paused by a channel/market kill-switch policy (Resume the policy to re-enable pushes).',
  UNCOUNTED: 'No stock pool yet for this product — nothing is pushed (it never sends a zero).',
  FBA: 'Amazon-managed (FBA) — Amazon controls the quantity; Sync Control never writes it.',
  EXCLUDED: 'This shared eBay variant is deliberately left out of the pool (Include it to re-enable).',
}

/** SCD.4 — plain-English explanation of each grid column, for header tooltips. */
export const COLUMN_HELP: Record<string, string> = {
  product: 'One row per real product. Duplicate listings of the same product (its ALT/IT- copies) are folded in automatically via the shared stock pool.',
  scope: 'How many variants, listings, and sales channels this product spans.',
  sync: 'How each listing gets its quantity. Hover a mode chip for what it means. A mix shows a count per mode.',
  intended: 'The quantity Sync Control wants on the marketplace for a listing (pool available minus its buffer).',
  live: 'The quantity currently live on the marketplace for a listing.',
  stock: 'Total units in the warehouse pool across this product’s variants, and how many of its variants are in stock.',
  drift: 'Listings whose live marketplace quantity doesn’t match what Sync Control intends. A green check means everything is in sync.',
  buffer: 'A safety margin held back from the marketplace — the push is pool available minus the buffer.',
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
