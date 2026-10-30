import { businessDate } from '@nexus/factory-domain/core/time'
import { listPriceOnBasis, priceFrom, type ListPrice } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { priceBasisOf } from '@nexus/factory-domain/sales/quotes/quotes'
import type { PartyTaxMode } from '@nexus/factory-domain/parties/tax'
import type { CommandTools } from '../../../core/command'
import { priceChainOf, type PriceChain } from '../pricelists/store'
import { treatmentFor, type QuoteParty, type QuoteRow, type Reader, type VersionRow } from './store'

/**
 * A quote line's list price (B-W2a-19; SAL-165: "quote lines read the list price"): the customer's price list chain
 * (pricelists/store priceChainOf: the version the quote keeps, else the customer's list in force today, else the
 * company's BASE list; then the lists each falls back to), the colourway's own price, else the style's, on the quote's
 * price basis (a consumer's quote VAT included at the customer's rate). The first time a price is read the quote version
 * keeps the version it came from (QuoteVersion.priceListVersionId): an open quote keeps its list version.
 */

export interface QuoteListPrice extends ListPrice {
  /** The list price on the version's basis (what QuoteLine.listUnitPrice stores). */
  readonly onBasis: string
}

/** The chain of a quote version (its company, currency, customer's list, kept version), read today. */
export function chainForQuote(db: Reader, quote: Pick<QuoteRow, 'companyId'>, version: Pick<VersionRow, 'currency' | 'priceListVersionId'>, party: QuoteParty, now: Date, styleIds?: readonly string[]): Promise<PriceChain> {
  return priceChainOf(db, { companyId: quote.companyId, currency: version.currency, partyListId: party.row.priceListId, pinnedVersionId: version.priceListVersionId, day: businessDate(now), styleIds })
}

/** The VAT rate a GROSS (consumer) quote's list price takes: the customer's standard treatment, when taxable. */
function rateOf(party: QuoteParty): string | null {
  if (!party.profile) return null
  const treatment = treatmentFor(party.profile)
  return 'kind' in treatment && treatment.kind === 'TAXABLE' ? treatment.rate.toFixed(2) : null
}

/** The list price of a style in a colourway for this quote version, or null when no list prices it. */
export function listPriceOf(chain: PriceChain, taxMode: PartyTaxMode, party: QuoteParty, styleId: string, colourwayId: string): QuoteListPrice | null {
  const found = priceFrom(chain.levels, styleId, colourwayId)
  if (!found) return null
  return { ...found, onBasis: listPriceOnBasis(found.unitPrice, priceBasisOf(taxMode), rateOf(party)) }
}

/** Inside a command on a DRAFT version: the version keeps the chain's version the first time a list price is read. */
export async function keepListVersion(tools: CommandTools, version: Pick<VersionRow, 'id' | 'priceListVersionId'>, chain: PriceChain): Promise<void> {
  if (version.priceListVersionId !== null || chain.keptVersionId === null) return
  await tools.tx.quoteVersion.update({ where: { id: version.id }, data: { priceListVersionId: chain.keptVersionId }, select: { id: true } })
}
