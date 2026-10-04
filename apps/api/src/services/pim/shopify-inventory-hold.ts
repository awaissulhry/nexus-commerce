/**
 * D2 = A (Amazon sheet gaps) — the hold on Shopify's own inventory field while Nexus sends the listing's quantity. Its own
 * module (type imports only) so the Shopify sheet projection can apply it without importing the Matrix read.
 */
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import type { SheetListing } from './sheet-rows.service.js'
import type { StudioRowStock } from './studio-stock.js'

/**
 * D2 = A: Nexus is the one writer of a Shopify listing's quantity while it follows the stock or is pinned. The
 * sentence that holds Shopify's own inventory field then, pointing to Qty; null when Nexus sends nothing (sync paused
 * by the listing or the channel policy) or the row has no listing.
 */
export function shopifyInventoryHeldReason(row: { listing: Pick<SheetListing, 'syncPaused' | 'follows'> | null; stock?: StudioRowStock }): string | null {
  if (!row.listing) return null
  const sync = row.stock?.cells?.sync
  if (sync ? sync.kind === 'PAUSED' : row.listing.syncPaused === true) return null
  const mode = sync ? (sync.mode === 'PINNED' ? MATRIX_COPY.pinnedAt(sync.intended ?? sync.held ?? 0) : 'Follow')
    : row.listing.follows?.followMasterQuantity === false ? 'Pinned' : 'Follow'
  return `Nexus sends this quantity to Shopify (Mode: ${mode}). Change it in the Qty column, or pause sync to edit it here.`
}
