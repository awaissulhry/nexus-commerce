/**
 * The Matrix's Status columns (Owner 2026-10-07) — which publish cell a row shows on a market. The cells come from ONE
 * read of every market, each as that market's own channel sheet reads it (`newRows: 'every'`), so a Matrix Status cell
 * is the sheet's Status cell of the same listing:
 *
 *   1. the row's listing on that market (the Matrix read's listing id) — the exact cell the sheet shows for that listing;
 *   2. else the cell of the same place — market, account, listing alias, product: the new row that market's sheet shows
 *      for a member with no listing there, or a listing the Matrix has not read yet (one a Status choice just started).
 *
 * A listing Nexus holds wins over a new row of the same place. No cell = the sheet's "no cell" (`statusCellValue(null)`).
 */
import { isNewRowId, type PublishActionCell } from '@nexus/shared/publish-actions'
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
  const byId = listingId ? byListingId.get(listingId) : undefined
  return byId ?? byPlace.get(publishPlaceKey(coord.channel, coord.market, coord.accountId, coord.alias?.id ?? '', rowId)) ?? null
}
