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
  sku: 'The variant SKU this listing sells. Sort to group a family together. One SKU can appear more than once: the same variant listed on several channels, markets, or shared eBay items.',
  variant: 'One row per variant SKU per listing. A variant listed on two eBay items appears twice, so you can control each item separately.',
  channel: 'Which sales channel this listing lives on (Amazon, eBay, Shopify).',
  market: 'Which marketplace/country this listing serves (IT, DE, FR, ES). Amazon Pan-EU listings share one ASIN across markets.',
  lane: 'How the quantity reaches the marketplace. Listing = a normal one-listing-per-SKU push. Shared = a pooled eBay item where several variants share one quantity, revised together.',
  mode: 'How this row gets its quantity. Hover the chip for the full meaning.',
  routedFrom: 'The stock location this quantity is routed from, when a sync route narrows the pool to specific warehouses instead of the whole pool.',
}

/** SCT.1 — full operator-grade explanation of every bulk ACTION button.
 *  Each one states what it writes, what it does NOT touch, and how to undo it,
 *  because these buttons move live marketplace quantities within seconds. */
export const ACTION_HELP: Record<string, string> = {
  FOLLOW:
    'Set Follow — the marketplace quantity starts tracking the shared warehouse pool. Every later stock change (a sale, a restock, a stock import) is pushed automatically within seconds, and any pinned number is cleared. Amazon FBA rows are always skipped. This is the normal hands-off mode, and it is also how you undo Pin or Zero & Pin.',
  PIN:
    'Pin — freeze each selected listing at the quantity that is live right now. The pool can move freely; the marketplace number will not follow it again until you press Set Follow. Use it to hold a listing at a number you chose by hand, e.g. reserving units for a wholesale order. Nothing is pushed at the moment you pin.',
  PAUSE:
    'Pause — stop sending any quantity to the marketplace for the selected rows. Whatever is live stays live and untouched, and no push happens until you Resume. It does not delist, hide, or zero the listing, and it does not change warehouse stock. Use it while investigating a problem or during a stocktake.',
  RESUME:
    'Resume — undo Pause. Pushing restarts and each row is re-cascaded immediately, so the live quantity is brought back in line with the pool (or with its pinned number) on the next push, normally within seconds. Safe to press on rows that were never paused.',
  ZERO_PIN:
    'Zero & Pin — pushes quantity 0 to the marketplace NOW and pins it there, so the listing becomes unbuyable within seconds. It does not delist the listing and it does not touch warehouse stock. Use it only to stop sales instantly: a safety recall, a wrong price, a confirmed oversell. Undo with Set Follow, which lets the pool refill the quantity.',
  EXCLUDE:
    'Exclude — leave the selected shared eBay variants out of the pooled quantity, so their units stop counting toward that eBay item’s advertised stock. Applies only to shared-SKU rows (one eBay item selling several variants); ordinary listing rows are skipped and reported back as skipped.',
  INCLUDE:
    'Include — put previously excluded shared eBay variants back into the pooled quantity, so their units count again on the next push. Applies only to shared-SKU eBay rows.',
  BUFFER:
    'Buffer — hold back a fixed number of units from the marketplace. The pushed quantity becomes pool available minus the buffer, never below zero. Use it as a safety margin against oversell on a slow-syncing channel. Set it to 0 to remove the margin. Applies to every selected row.',
}

/** SCT.1 — explanation of every non-action control (toolbars, filters, Excel,
 *  policies, routes, pagination), so nothing on the page is unexplained. */
export const CONTROL_HELP: Record<string, string> = {
  // toolbar
  bufferInput: 'Units to hold back from the marketplace for every selected row. Type a number, then press Apply. 0 removes the margin.',
  bufferApply: 'Write the buffer above to every selected row. The next push sends pool available minus the buffer.',
  clearSelection: 'Deselect every row. Nothing is written and no push happens.',
  clearFilters: 'Reset every filter to All, empty the search box and switch off Drift only.',
  searchRows: 'Filter by SKU, product name, or eBay item id. Combines with the filters above.',
  searchProducts: 'Filter by product name or by any SKU inside the family, parent or variant.',
  density: 'Row height only — Compact fits the most rows on screen, Spacious is easiest to read. It changes nothing about the data.',
  pageSize: 'How many rows to load at once. Large pages mean far fewer clicks when bulk-editing (500 shows nearly every listing on one page, so one Select all covers it); small pages render faster.',
  pagination: 'Move between pages. Your selection is kept when you change page, so you can gather rows across pages and act on them together.',
  viewToggle: 'Products shows one row per real product family — expand it for its listings and act on the whole family at once. Listings shows every listing flat, for the finest per-row control.',
  selectAll: 'Select every row on this page. Amazon FBA rows cannot be selected: Amazon owns their quantity and Sync Control never writes it.',
  selectRow: 'Select this row for the bulk actions above.',
  // filters
  filterChannel: 'Show only the chosen sales channels. Pick several at once — the result is the union.',
  filterMarket: 'Show only the chosen marketplaces/countries. Pick several at once — the result is the union.',
  filterMode: 'Show only rows in the chosen sync modes. Pick several at once, e.g. Pinned plus Paused to review everything not following the pool.',
  filterLane: 'Listing = a normal one-listing-per-SKU push. Shared = a pooled eBay item whose variants share one quantity.',
  filterFamily: 'Narrow to one duplicate family — one parent listing and its own child SKUs — so an action here touches that family only, not every copy of the product.',
  driftOnly: 'Show only rows where the live marketplace quantity does not match what Sync Control intends. This is the list worth fixing.',
  // Excel
  exportXlsx: 'Download the rows currently in view as an Excel workbook (Listings + Routes sheets). Filters apply, so you export exactly what you see. Amazon FBA rows come through greyed and locked.',
  importXlsx: 'Upload an edited workbook. You get a preview listing every change and its count first — nothing is written until you confirm it. FBA quantities in the file are always ignored.',
  importApply: 'Write the previewed changes. Each affected listing is re-cascaded, so the marketplace catches up within seconds.',
  importCancel: 'Discard this upload. Nothing has been written yet.',
  importClose: 'Close the preview without writing anything.',
  // rows / navigation
  expandRow: 'Show this product’s listings inline. Large families show the first rows here — use the link underneath to open the whole family in a new tab.',
  openProductTab: 'Open this product’s own control page in a new tab: every variant and listing, its own filters, per-family control, and its own Excel export.',
  openFamilyTab: 'Open just this family in a new tab, so an action applies only to this family’s child SKUs instead of every copy of the product.',
  openAllListings: 'Open the full family in a new tab — all of its listings, not just the preview shown here.',
  showAllRows: 'Show every row in this panel. Long lists are capped so the page stays fast.',
  showFewerRows: 'Collapse back to the first few rows.',
  productLink: 'Open this product in the catalogue editor (new tab) to change its content, images or variants.',
  historyLink: 'Open the full audit trail in a new tab: who changed which listing, when, and from what to what.',
  backToFamilies: 'Back to every family of this product.',
  // policies
  policyPause: 'Kill-switch for the whole channel/market: stop all pushes to it, whatever individual listings say. Nothing is delisted and nothing is zeroed.',
  policyResume: 'Lift the kill-switch and let pushes to this channel/market resume. Affected listings are re-cascaded.',
  policyNewDefault: 'Choose how a NEWLY discovered listing on this channel/market starts: paused (safe — it pushes nothing until you check it) or following the pool immediately.',
  policyChannelSelect: 'The channel this new policy applies to.',
  policyMarketSelect: 'The marketplace this new policy applies to. All markets covers every country on that channel.',
  policyAddPause: 'Create a policy that pauses every push on the chosen channel/market straight away.',
  policyAddBornPaused: 'Create a policy that makes newly discovered listings on the chosen channel/market start paused, so nothing goes live unchecked.',
  // routes
  routeEdit: 'Change which stock locations this route draws from.',
  routeSave: 'Save the locations. The pool for the affected listings is recalculated and re-pushed.',
  routeCancel: 'Discard the edit and keep the current locations.',
  routeInput: 'Comma-separated scopes, e.g. AMAZON:IT, EBAY. Leave it empty to apply everywhere.',
}

/** SCT.2 — page sizes. 500 exists so a bulk edit needs one Select all instead
 *  of ten pages of clicking; the API clamp allows it on every surface. */
export const PAGE_SIZES = [25, 50, 100, 200, 500] as const

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
