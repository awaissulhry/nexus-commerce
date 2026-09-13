/**
 * MX.P — the SCOPE BAR's semantics on the Matrix, as a pure rule.
 *
 * The Matrix has ONE state: every coordinate at once. The scope bar does not switch surfaces here —
 * it FILTERS the coordinate groups (`docs/2026-09-13-matrix-page-design.md` Revision, §3.2):
 *
 *   Shared product (`scope=master`)  every coordinate, in contract order
 *   a channel chip (`scope=AMAZON`)  that channel's groups — and the REGION group that carries their
 *                                    inventory, which is a different coordinate with the same channel
 *   the market listbox               on a channel scope, narrows to that market's group plus the
 *                                    region group whose `sharedInventoryWith` names it
 *
 * 🔴 The market listbox does NOT narrow on `master`, and that is a decision rather than an omission.
 * On master the listbox is the STUDIO's own coordinate control (the sheet's market), and the studio
 * always resolves one — `defaultMarket()` picks the market served by the most channels, and
 * `lastMarket.ts` restores the operator's. So a literal per-market narrowing on master would mean
 * the Matrix could NEVER land on "every coordinate at once", which is the page's headline state.
 * §3.2's table lists both behaviours in one row; this is the reading that keeps the landing state
 * the design asks for. Recorded as a QUESTION FOR THE OWNER in `docs/pes-claims.md` with this
 * measurement and a recommendation — the lane does not rule.
 *
 * 🔴 Pure: no React, no AG, no fetch, so every clause is asserted in `filters.vitest.test.ts`.
 */
import type { CoordinateKey, MatrixCoordinate } from './contract'

export const MASTER_SCOPE_ID = 'master'

export interface MatrixScopeFilter {
  /** `'master'` or a channel key exactly as the API spells it (`'AMAZON'`). */
  scope: string
  /** The market listbox's value, or `null` before the frame has resolved one. */
  market: string | null
}

/** Does this coordinate carry (or share) inventory for `market`? */
function servesMarket(coord: MatrixCoordinate, market: string): boolean {
  if (coord.market === market) return true
  return (coord.sharedInventoryWith ?? []).includes(market)
}

/**
 * The coordinates a given scope shows, in the READ's own order (which is the contract's order).
 *
 * A coordinate whose inventory lives on a region group brings that group with it, and vice versa:
 * narrowing to `AMAZON · DE` without `AMAZON EU · INVENTORY` would show a market whose Mode, Qty,
 * Buffer and Sync are simply missing, with nothing on screen saying where they went.
 */
export function filterCoordinates(
  coordinates: readonly MatrixCoordinate[],
  filter: MatrixScopeFilter,
): MatrixCoordinate[] {
  if (filter.scope === MASTER_SCOPE_ID) return [...coordinates]
  const channel = coordinates.filter((c) => c.channel === filter.scope)
  if (!filter.market) return channel
  const narrowed = channel.filter((c) => servesMarket(c, filter.market!))
  /* The market's own group points at the region group that carries its inventory cells; pull it in
     by KEY rather than by re-deriving the region, so this cannot disagree with the contract. */
  const inventoryKeys = new Set(narrowed.map((c) => c.inventoryOn).filter((k): k is CoordinateKey => !!k))
  const withInventory = channel.filter((c) => narrowed.includes(c) || inventoryKeys.has(c.key))
  /* A channel that serves this market on NO coordinate shows the channel's coordinates rather than
     an empty grid: "this channel has nothing in DE" is a claim, and the page cannot make it here. */
  return withInventory.length > 0 ? withInventory : channel
}

/** One sentence for the toolbar when the scope bar is hiding groups. `null` when nothing is hidden. */
export function filterNote(
  coordinates: readonly MatrixCoordinate[],
  filter: MatrixScopeFilter,
  channelLabel?: (channel: string) => string,
): string | null {
  const shown = filterCoordinates(coordinates, filter)
  const hidden = coordinates.length - shown.length
  if (hidden <= 0) return null
  const who = filter.scope === MASTER_SCOPE_ID ? 'this scope' : (channelLabel?.(filter.scope) ?? filter.scope)
  const where = filter.scope !== MASTER_SCOPE_ID && filter.market ? ` · ${filter.market}` : ''
  return `${hidden} more ${hidden === 1 ? 'coordinate' : 'coordinates'} hidden by the scope bar — showing ${who}${where}. Choose Shared product to see them all.`
}

/** The key set the chips, the footer and Export narrow against. */
export function visibleCoordinateKeys(
  coordinates: readonly MatrixCoordinate[],
  filter: MatrixScopeFilter,
): Set<CoordinateKey> {
  return new Set(filterCoordinates(coordinates, filter).map((c) => c.key))
}
