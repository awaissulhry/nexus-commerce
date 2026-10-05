/**
 * CM-21 — which portfolios a campaign may be moved to.
 *
 * A portfolio belongs to one Amazon Ads profile, so one market. The grid's "Portfolio" menu listed every market's
 * portfolios (it never asked for a market) plus the ones created in Nexus while writes were closed (`local-pf-…`,
 * which Amazon has never seen). Picking either for a campaign sends Amazon an id it refuses for that campaign.
 * Both pickers (the grid's bulk menu and the campaign detail page) now offer only this market's portfolios that
 * exist on Amazon. Pure, so it is tested without a browser.
 */

export interface PortfolioOption {
  portfolioId: string
  name: string
  /** The market of the portfolio's profile, as `GET /advertising/portfolios` reports it. */
  marketplace?: string | null
}

/** Created in Nexus while writes were closed: no Amazon id, so it can never be sent to Amazon. */
export const isLocalOnlyPortfolio = (portfolioId: string): boolean => portfolioId.startsWith('local-pf-')

/**
 * The portfolios a campaign of `market` may be assigned to: that market's, never a local-only one. `null` = the
 * market is not known, so no market filter applies (local-only ones are still left out).
 */
export function assignablePortfolios<T extends PortfolioOption>(all: readonly T[], market: string | null): T[] {
  return all.filter((p) => !isLocalOnlyPortfolio(p.portfolioId) && (market == null || p.marketplace === market))
}

/** The one market the selected campaigns share, or `mixed` when they span several (a portfolio cannot hold both). */
export function sharedMarket(markets: ReadonlyArray<string | null | undefined>): { market: string | null; mixed: boolean } {
  const distinct = [...new Set(markets.map((m) => m ?? ''))]
  if (distinct.length > 1) return { market: null, mixed: true }
  return { market: distinct[0] || null, mixed: false }
}
