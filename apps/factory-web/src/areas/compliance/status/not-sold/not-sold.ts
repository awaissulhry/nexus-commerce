import { MARKET_STANDINGS, type MarketStanding } from '@nexus/factory-domain/product/markets/rules'

/**
 * "Not sold there" on Compliance › Status board (SCR-119; B-W2b-288, FU2:02 of B-W2b-254 and -266; Style.marketCodes, set on the
 * style's Overview since B-W2b-283), pure. The API asks a style only in the markets it is sold in; a market it leaves out is the
 * cell state NOT_SOLD (no line, never a gap); a style that names no market is asked everywhere. The cell pop-up says which
 * standing it is and where the markets are changed.
 */

export const NOT_SOLD_NAMESPACE = 'compliance-followups-w2b4'
export { MARKET_STANDINGS }
export type { MarketStanding }

/** The message key of the cell pop-up's note for a standing (none: SOLD_THERE says nothing more). */
export const standingNoteKey = (standing: MarketStanding): string | null => (standing === 'NOT_SOLD_THERE' ? 'notSold.cell.notSold' : standing === 'EVERY_MARKET' ? 'notSold.cell.everyMarket' : null)

/** The style's Overview, where its markets are picked (Products › Styles; product.styles.view and the page built), or null. */
export const marketsHref = (styleId: string, prefix: string, stylesView: boolean, built: ReadonlySet<string>): string | null =>
  stylesView && built.has('/products/styles/[id]') ? `${prefix}/products/styles/${encodeURIComponent(styleId)}?tab=overview` : null

/** "Italia, Germania" — the markets a style is sold in, in the page's language (none: null). */
export const soldInWords = (codes: readonly string[], name: (code: string) => string): string | null => (codes.length > 0 ? codes.map(name).join(', ') : null)
