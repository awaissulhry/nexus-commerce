/**
 * Item ID control, step I4 — the ASIN an Amazon row not on Amazon lists on at Publish: where it is stored and which rows
 * take one. A leaf (the sheet read and the ASIN proof both read it).
 *
 * The store is the sheet's own "Merchant suggested ASIN" column: an Amazon attribute with no listing store of its own,
 * so the sheet's channel write keeps it in the listing's `overrideData` under its key (`channelValueMutation`), and the
 * Amazon publish sends it as `merchant_suggested_asin` for THIS market's listing.
 */
import { hasDeletedShape } from '../../listings/listing-deletions.js'

export const SUGGESTED_ASIN_KEY = 'merchant_suggested_asin'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The ASIN a draft row lists on at Publish, or null (a stored scalar, or Amazon's `[{ value }]` shape). */
export function suggestedAsinOf(overrideData: unknown): string | null {
  const value = record(overrideData)[SUGGESTED_ASIN_KEY]
  const first = Array.isArray(value) ? record(value[0]).value : value
  const text = typeof first === 'string' ? first.trim() : ''
  return text ? text.toUpperCase() : null
}

/** A row that is not on Amazon, so a typed ASIN can be its suggestion: no ASIN, and DRAFT or unpublished (a still-draft, or a deleted row). */
export const takesSuggestedAsin = (row: { externalListingId: string | null; listingStatus: string | null; isPublished: boolean | null }) => hasDeletedShape(row)
