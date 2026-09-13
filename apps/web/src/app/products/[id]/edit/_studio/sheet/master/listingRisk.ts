/**
 * PES.2 / F3 — what a destructive verb is about to destroy, as a pure rule.
 *
 * 🔴 THE RULE, and why it is not the obvious one.
 *
 * `DELETE /api/catalog/products/:parentId/children/:childId` is a HARD delete: the row goes and its
 * ChannelListings cascade with it by foreign key, with no server-side guard. So the confirmation is
 * the only thing standing between an operator and a live marketplace listing, and it is only as
 * good as its idea of "live".
 *
 * The obvious idea is `listingStatus === 'ACTIVE'`. It is wrong, and measurably so: PES.3 found a
 * family where **all 20 non-ACTIVE eBay rows still carried a real ItemID**. Those listings exist on
 * eBay. A confirm keyed on status would have described 20 live listings as safe to destroy.
 *
 * So the question this file answers is "does something REAL exist on the marketplace", and the
 * field that answers it is `externalListingId` — Amazon's ASIN, eBay's ItemID. Status is reported
 * alongside it as context, never as the test.
 */

import type { ListingRow } from './familyOps'
import { identityHeld as isLiveOnChannel } from '@nexus/shared/listing-risk'
export { identityHeld as isLiveOnChannel, identityHeld, sellingRisk } from '@nexus/shared/listing-risk'

export type ListingRisk = 'live' | 'local'

export interface ListingVerdict {
  row: ListingRow
  risk: ListingRisk
  /** One line for the confirmation, naming the channel, the market and what makes it live. */
  label: string
}

export interface DeletionImpact {
  verdicts: ListingVerdict[]
  /** Listings that exist on a marketplace and would be destroyed with the product. */
  live: ListingVerdict[]
  /** Rows that only ever existed here. Losing them costs nothing outside this system. */
  local: ListingVerdict[]
}

const trimmed = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Is this listing real on the marketplace?
 *
 * The presence of an external id, and nothing else. Not status, not `isPublished` — an unpublished
 * row with an ItemID is still an eBay listing that a delete would take down.
 */


export function classifyListings(rows: readonly ListingRow[]): DeletionImpact {
  const verdicts = rows.map<ListingVerdict>((row) => {
    const live = isLiveOnChannel(row)
    const where = `${row.channel} · ${row.marketplace}`
    const status = trimmed(row.listingStatus) || 'no status'
    return {
      row,
      risk: live ? 'live' : 'local',
      // The id is NAMED. "1 live listing" is a number an operator already knew; "eBay · IT —
      // ItemID 256789012345" is the thing they can go and look at before agreeing to lose it.
      label: live
        ? `${where} — ${status}, ${trimmed(row.externalListingId)}`
        : `${where} — ${status}, no marketplace id on this record`,
    }
  })
  return {
    verdicts,
    live: verdicts.filter((v) => v.risk === 'live'),
    local: verdicts.filter((v) => v.risk === 'local'),
  }
}
