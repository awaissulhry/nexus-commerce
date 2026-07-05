// FF1.5 — eBay channel-specific SHARED (non-market) fields.
// For FF1 this is empty: eBay item-specifics live in platformAttributes JSON
// (deferred, FFD12), and the per-market price/qty/status fields are already
// in CHANNEL_MARKET_FIELDS.
import type { FieldDefinition } from './types'

export const EBAY_SHARED_FIELDS: FieldDefinition[] = []
