import type { PartyOption, ProfileRow } from '../api'
import type { Phrase } from '../model'

/**
 * Sales › Made-to-measure's list filters (B-W2b-371, XF2:03; design mtm.tiles "Outside the certified range", "Fittings this week",
 * mtm.grid savedRows "Outside range", "By customer", Export ▾), pure: a row's certified range in words, the customer chosen by name.
 * Keys of `sales-mtm-office-extras` (under `list.`), never the API's English.
 */

/** "Inside" · "Outside: chest, sleeve" · "Not checked" (no open unit, or made-to-measure off for its style's template). */
export function rangeWords(range: ProfileRow['range']): Phrase {
  if (range.inside === null) return { key: 'list.range.unknown' }
  if (range.inside) return { key: 'list.range.inside' }
  return range.points.length > 0 ? { key: 'list.range.outsidePoints', params: { points: range.points.join(', ') } } : { key: 'list.range.outside' }
}

export type RangeTone = 'success' | 'danger' | 'neutral'
export const rangeTone = (range: ProfileRow['range']): RangeTone => (range.inside === null ? 'neutral' : range.inside ? 'success' : 'danger')

/** The chosen customer's name, when the picker knows it. */
export function customerName(customers: readonly PartyOption[] | null | undefined, rows: readonly ProfileRow[] | null, partyId: string | null): string | null {
  if (!partyId) return null
  const party = customers?.find((entry) => entry.id === partyId)
  if (party) return party.legalName
  return rows?.find((row) => row.partyId === partyId)?.customer.name ?? null
}
