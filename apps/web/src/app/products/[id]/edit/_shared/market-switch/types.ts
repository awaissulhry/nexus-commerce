// AC.3 — Shared market-switch types.
//
// Generic shape used by the Amazon Listing Cockpit chip strip; eBay
// + Shopify cockpits will adopt the same module without retyping.
// Status is intentionally open-ended (string + the conventional set)
// because the canonical channel statuses differ — Amazon uses
// ACTIVE/INACTIVE/SUPPRESSED, eBay uses ACTIVE/ENDED/DRAFT, Shopify
// uses ACTIVE/ARCHIVED/DRAFT. The chip strip renders a status DOT
// (●/○/⚠) by mapping the string through a small classifier.

export type MarketStatusClass = 'published' | 'draft' | 'suppressed' | 'unknown'

export interface MarketChip {
  /** Marketplace short code, e.g. "IT", "DE". Also used as URL value. */
  code: string
  /** Display name shown on hover, e.g. "Italia". */
  name: string
  /** Optional flag emoji or short region code. */
  flag?: string
  /** True when this market has any Listing record for the product. */
  hasListing: boolean
  /** Raw status string straight from Listing.listingStatus. The chip
   *  strip classifies this via `classifyStatus` for the visual dot. */
  listingStatus?: string | null
  /** Number of unsaved fields on this market right now. Drives the
   *  small amber badge in the chip. */
  dirtyCount?: number
}

const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', GB: '🇬🇧',
  US: '🇺🇸', JP: '🇯🇵', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪',
  IE: '🇮🇪', AT: '🇦🇹', CH: '🇨🇭', PT: '🇵🇹',
}

export function marketFlag(code: string): string {
  return FLAG[code] ?? '🌐'
}

export function classifyStatus(
  hasListing: boolean,
  status?: string | null,
): MarketStatusClass {
  if (!hasListing) return 'draft'
  const s = (status ?? '').toUpperCase()
  if (s === 'SUPPRESSED' || s === 'SEARCH_SUPPRESSED' || s === 'BLOCKED') {
    return 'suppressed'
  }
  if (s === 'ACTIVE' || s === 'PUBLISHED' || s === 'BUYABLE') return 'published'
  if (s === 'DRAFT' || s === 'INACTIVE' || s === 'ENDED' || s === 'UNPUBLISHED') {
    return 'draft'
  }
  if (!status) return hasListing ? 'published' : 'draft'
  return 'unknown'
}
