/**
 * The Matrix's Status columns (Owner 2026-10-07) — which publish cell a row shows on a market. The cells come from ONE
 * read of every market, each as that market's own channel sheet reads it (`newRows: 'every'`), so a Matrix Status cell
 * is the sheet's Status cell of the same listing:
 *
 *   1. the row's listing on that market (the Matrix read's listing id) — the exact cell the sheet shows for that listing,
 *      when it is THIS market's account's: a listing with no account (or another one) is not on that account's sheet, which
 *      shows its own row for the product instead (2.);
 *   2. with no listing of the account here: the cell of the same place — market, account, listing alias, product: the new
 *      row that market's sheet shows for a member with no listing there, or a listing the Matrix has not read yet (one a
 *      Status choice just started);
 *   3. a listing id the publish read does not hold (yet): no cell — as the sheet (`publishCellOf`), never an older new row.
 *
 * A listing Nexus holds wins over a new row of the same place. No cell = the sheet's "no cell" (`statusCellValue(null)`).
 */
import { isNewRowId, type PublishActionCell } from '@nexus/shared/publish-actions'
import type { PublishCellInput } from '../sheet/usePublishActions'
import type { MatrixCoordinate } from './contract'

/** Where a publish cell sits: market, account, listing alias ('' = the main listing) and product. */
export const publishPlaceKey = (channel: string, market: string, accountId: string | null | undefined, aliasKey: string | null | undefined, productId: string): string =>
  JSON.stringify([channel.toUpperCase(), market.toUpperCase(), accountId ?? '', aliasKey ?? '', productId])

/** Every publish cell by its place; a listing Nexus holds wins over the new row of the same place. */
export function publishCellsByPlace(rows: readonly PublishActionCell[]): Map<string, PublishActionCell> {
  const byPlace = new Map<string, PublishActionCell>()
  for (const cell of rows) {
    const key = publishPlaceKey(cell.channel, cell.marketplace, cell.accountId, cell.aliasKey, cell.productId)
    const held = byPlace.get(key)
    if (!held || (isNewRowId(held.listingId) && !isNewRowId(cell.listingId))) byPlace.set(key, cell)
  }
  return byPlace
}

/** A row's Status cell on a market (see the file header), or null. */
export function matrixStatusCell(
  rowId: string,
  coord: Pick<MatrixCoordinate, 'channel' | 'market' | 'accountId' | 'alias'>,
  listingId: string | null | undefined,
  byListingId: ReadonlyMap<string, PublishActionCell>,
  byPlace: ReadonlyMap<string, PublishActionCell>,
): PublishActionCell | null {
  const place = publishPlaceKey(coord.channel, coord.market, coord.accountId, coord.alias?.id ?? '', rowId)
  if (listingId) {
    const byId = byListingId.get(listingId)
    if (!byId) return null
    if (publishPlaceKey(byId.channel, byId.marketplace, byId.accountId, byId.aliasKey, byId.productId) === place) return byId
  }
  return byPlace.get(place) ?? null
}

/** When the markets' Status columns reached the Matrix (built 2026-10-07, released by the next day). */
export const MATRIX_STATUS_SINCE = Date.parse('2026-10-08T00:00:00.000Z')

/** A saved view last saved before the Status columns existed could not name them (its Listings then show their Status). */
export function savedBeforeMatrixStatus(updatedAt: string | null | undefined): boolean {
  const at = updatedAt ? Date.parse(updatedAt) : NaN
  return Number.isFinite(at) && at < MATRIX_STATUS_SINCE
}

/** A Status clear for a cell with nothing waiting: nothing to clear (the sheet's Delete rule, `usePublishCellEditing`). */
export function clearsNothing(input: PublishCellInput, cell: Pick<PublishActionCell, 'status'> | null): boolean {
  return 'change' in input && input.change.column === 'status' && input.change.target === null && !cell?.status.target
}
