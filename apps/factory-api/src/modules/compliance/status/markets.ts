import type { GateMarket } from '@nexus/factory-domain/compliance/gates/gate'
import { NOT_SOLD_CELL, type CellSummary } from '@nexus/factory-domain/compliance/status/board'
import { marketStanding, type MarketStanding } from '@nexus/factory-domain/product/markets/rules'

/**
 * "Not sold there" on the compliance status board (B-W2b-288, follow-up FU2:02 of B-W2b-254 and -266; Style.marketCodes of
 * B-W2b-275, set on the style's Overview since B-W2b-283). The board reads the markets a style is sold in the way the
 * requirements gate reads them (factory-domain product/markets `marketStanding`):
 *
 *   EVERY_MARKET    the style names no market: every column is asked, as before
 *   SOLD_THERE      a market the style names: its requirements are asked (Ready, Missing n, Blocked, Expiring)
 *   NOT_SOLD_THERE  a market the style leaves out: "Not sold there" (—), not a gap — nothing is asked, it is never missing,
 *                   blocked or ready, never in "Needs action", never a cell of the coverage the reports count
 */

/** The board's columns split for one style: the markets asked and the ones it is not sold in. */
export function boardMarketsOf(marketCodes: readonly string[], markets: readonly GateMarket[]): { readonly asked: GateMarket[]; readonly notSold: ReadonlySet<string> } {
  const asked = markets.filter((market) => marketStanding(marketCodes, market.code) !== 'NOT_SOLD_THERE')
  return { asked, notSold: new Set(markets.filter((market) => !asked.includes(market)).map((market) => market.code)) }
}

/** A row's state over the markets it is sold in: ready when every one asked is (and one is asked), blocked when one is. */
export function rowStateOf(cells: readonly Pick<CellSummary, 'state'>[]): { readonly ready: boolean; readonly blocked: boolean } {
  const asked = cells.filter((cell) => cell.state !== 'NOT_SOLD')
  return { ready: asked.length > 0 && asked.every((cell) => cell.state === 'READY'), blocked: asked.some((cell) => cell.state === 'BLOCKED') }
}

/** The cell of a market the style is not sold in. */
export const notSoldCell = (): CellSummary => NOT_SOLD_CELL

/** Where a style stands in one market (the cell pop-up says it). */
export const standingOf = (marketCodes: readonly string[], marketCode: string): MarketStanding => marketStanding(marketCodes, marketCode)
