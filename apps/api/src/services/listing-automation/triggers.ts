/**
 * OL.D — Listing-automation domain constants + shared types.
 *
 * The "listings" domain on the shared AutomationRule engine
 * (automation-rule.service.ts). Distinct from bulk-operations /
 * advertising / marketing / review — `domain` is the discriminator and
 * the engine already filters by it, so a listings rule never fires on
 * another domain's evaluator and vice versa.
 *
 * Triggers here are CRON-POLLABLE (the listing-automation-evaluator job
 * scans the catalog each tick and builds a context per product), which
 * keeps the whole feature in new files — no hooks into the contended
 * master-price / master-status mutation services.
 */

export const LISTING_TRIGGERS = [
  // A product's listings disagree on price across markets beyond a
  // threshold (operator decides the threshold + what to do).
  'price_diverged',
  // A product's sellable stock fell below a threshold.
  'inventory_low',
  // A product's marketplace-aware listing health (OL.C) dropped below a
  // threshold. (Wired in OL.D.5.)
  'listing_health_low',
  // The master title/description changed vs what the channels carry.
  // (Wired in OL.D.6.)
  'master_content_changed',
] as const

export type ListingTrigger = (typeof LISTING_TRIGGERS)[number]

// Listings-domain action types. `notify` / `log_only` are engine
// built-ins (always allowed); the rest are registered in
// action-handlers.ts via the ACTION_HANDLERS side-effect pattern.
export const LISTING_ACTION_TYPES = [
  'sync_price_to_marketplaces',
  'sync_inventory_to_marketplaces',
  'cascade_translate_content',
] as const

export type ListingActionType = (typeof LISTING_ACTION_TYPES)[number]

// Per-coordinate snapshot the evaluator attaches to a rule context.
export interface ListingCoord {
  channel: string
  marketplace: string
  price: number | null
  quantity: number | null
  currency: string
  listingStatus: string | null
  listed: boolean
}

// The context object passed to conditions + action handlers. Conditions
// reference dotted paths into this (e.g. `price.spreadPct`, `inventory.available`).
export interface ListingRuleContext {
  trigger: ListingTrigger
  product: { id: string; sku: string | null; name: string | null; basePrice: number | null }
  listings: ListingCoord[]
  price?: { min: number; max: number; spreadPct: number; currency: string }
  inventory?: { available: number }
  health?: { score: number; ready: number; total: number; blocked: number }
}

// Per-market currency (mirrors the cross-channel matrix + preflight).
export function currencyForMarket(mp: string): string {
  const m = (mp ?? '').toUpperCase()
  if (m === 'UK' || m === 'GB') return 'GBP'
  if (m === 'US') return 'USD'
  if (m === 'JP') return 'JPY'
  return 'EUR'
}
