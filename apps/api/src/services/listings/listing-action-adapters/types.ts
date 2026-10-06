/**
 * Sheet publish parity, step 7 — the contract between the listing-action engine (../listing-action.service.ts) and one
 * channel's adapter. The engine decides WHICH rows an action reaches (the plan); an adapter only makes the channel
 * calls for those rows, through the channel gateway, and writes the listing facts the channel confirmed — on the exact
 * coordinate rows it was given, never another account's or alias's.
 */
import type { ActionReach, ListingAction, ListingActionDestination, ListingActionRowOutcome } from '@nexus/shared/listing-actions'

/** One listing row of the family on the destination, as the engine read it (fresh, inside the run). */
export interface ActionListing {
  id: string
  productId: string
  /**
   * Amazon (S3), eBay (S4), Shopify and Etsy (S5): the SKU the channel holds for this row (`listingSendSku`), the product
   * SKU unless it has its own.
   */
  sku: string
  /** S3/S4/S5 — the row has no single SKU on record (two different ones): the plan refuses it with this sentence where the action names the SKU. */
  skuRefusal?: string
  isParent: boolean
  externalListingId: string | null
  listingStatus: string
  isPublished: boolean
  offerClosedAt: Date | null
  offerCloseReason: string | null
  offerActive: boolean
  fulfillmentMethod: string | null
  productFulfillmentMethod: string | null
  platformAttributes: unknown
  /** eBay: an OLDER Claude close-listing paused it (pinned at 0, no hold — `oldClosePauses`); Resume lifts the pin. */
  oldClosePause?: boolean
}

export interface ActionContext {
  previewId: string
  /** Who acted, as the audit records it (user id, else 'system'). */
  actor: string
  destination: ListingActionDestination
  familyId: string
  familySku: string
  /** Every listing of the family on the destination — what an item- or product-level change also updates. */
  family: ActionListing[]
  /**
   * E2 (D6) — how far the plan reaches. Etsy: `row` = Pause/Resume of ONE variation (hide/show its offering on the
   * live listing); otherwise the whole listing. Unset = the capability's own reach.
   */
  reach?: ActionReach
  /**
   * E2 (D6, review m1) — Etsy: what the PREVIEW decided (hide/show variations, or the listing's state), stored with it.
   * The run refuses when the listing no longer matches it, rather than changing meaning silently. Unset = not decided.
   */
  etsyLevel?: 'variation' | 'listing'
  /** E2 (D6, review m8) — the caller named listings, not variations (Claude's close/reopen-listing): never variation level. */
  wholeListing?: boolean
}

export interface AdapterRowResult {
  listingId: string
  productId: string
  sku: string
  outcome: ListingActionRowOutcome
  message: string
  /** What the channel held before / answered — saved on the row's audit record. */
  evidence?: Record<string, unknown>
}

export interface ListingActionAdapter {
  run(action: ListingAction, targets: ActionListing[], ctx: ActionContext): Promise<AdapterRowResult[]>
}

export const rowResult = (row: ActionListing, outcome: ListingActionRowOutcome, message: string, evidence?: Record<string, unknown>): AdapterRowResult =>
  ({ listingId: row.id, productId: row.productId, sku: row.sku, outcome, message, ...(evidence ? { evidence } : {}) })

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err)
