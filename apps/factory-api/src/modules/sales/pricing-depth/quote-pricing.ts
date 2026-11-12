import { businessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { listPriceOnBasis, listPriceText } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { breakQuantityOf, linePriceOf } from '@nexus/factory-domain/sales/pricing-depth/line-price'
import { isGoodsLine, priceBasisOf } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller } from '../../../core/command'
import { findingViewOf, orderDocumentOf, quoteDocumentOf } from '../line-checks/documents'
import { runLineChecks } from '../line-checks/index'
import { officeOrder } from '../orders/moves'
import { readLines as readOrderLines } from '../orders/store'
import { dayText, entryHoldsOn } from '../pricelists/store'
import { chainForQuote, listPriceOf } from '../quotes/list-price'
import { officeQuote, quotePartyOf, readCurrentVersion, readLineRecords, treatmentFor, type QuoteParty } from '../quotes/store'
import { serverClock } from '../../../core/time'
import { breakRowOf, breaksOf, discountShownFor, surchargeRowOf, surchargesOf } from './store'

/**
 * What a quote's lines take from their price list (B-W2b-325; SAL-166, SAL-167, SAL-180; design quote › Price & margin:
 * list price, quantity break, size surcharge per size), and what the line rules say of a quote or an order (SAL-178).
 * Reads only: the line's price stays what the office set (W1's lines take the list price; B-W2b-330 writes the waterfall
 * with the break and the surcharges, from `steps` here).
 *
 *   the day         the quote version's day (its creation): the dated price that holds then (SAL-167)
 *   the list price  the customer's chain (the version the quote keeps, else the customer's list, else the BASE list)
 *   the break       of the entry's own breaks and its version's breaks for every price, for the pieces of every goods
 *                   line of the version that this price prices (SAL-166)
 *   the surcharges  per size of the line: the version's for the style, the version's for every style, the style's own
 *   the steps       LIST → BREAK → SIZE_SURCHARGE → NET on the version's price basis (factory-db QuoteLine.priceSteps)
 */

/** The VAT rate a GROSS (consumer) quote's list figures take: the customer's standard treatment, when taxable. */
function rateOf(party: QuoteParty | null): string | null {
  if (!party?.profile) return null
  const treatment = treatmentFor(party.profile)
  return 'kind' in treatment && treatment.kind === 'TAXABLE' ? treatment.rate.toFixed(2) : null
}

/** GET /sales/quotes/:quoteId/list-prices: the current version's lines priced from their list. */
export async function quoteListPrices(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const version = await readCurrentVersion(client, quote)
    const day = businessDate(version.createdAt)
    const lines = (await readLineRecords(client, version.id)).filter((line) => isGoodsLine(line))
    const party = await quotePartyOf(client, quote.partyId, businessDate(now), now)
    const basis = priceBasisOf(version.taxMode)
    const rate = rateOf(party)
    const onBasis = (net: string) => listPriceOnBasis(net, basis, rate)
    const chain = party ? await chainForQuote(client, quote, version, party, now, [...new Set(lines.map((line) => line.styleId))]) : null
    const found = lines.map((line) => ({ line, listed: chain && party ? listPriceOf(chain, version.taxMode, party, line.styleId, line.colourwayId) : null }))
    // The entry each line is priced from: its version, style and colourway (or every colourway), holding on the day.
    const versionIds = [...new Set(found.flatMap((row) => (row.listed ? [row.listed.versionId] : [])))]
    const entries = versionIds.length === 0 ? [] : await client.priceListEntry.findMany({ where: { versionId: { in: versionIds }, styleId: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, versionId: true, styleId: true, colourwayId: true, unitPrice: true, validFrom: true, validTo: true } })
    const entryOf = (row: (typeof found)[number]) =>
      row.listed ? (entries.find((entry) => entry.versionId === row.listed!.versionId && entry.styleId === row.line.styleId && entry.colourwayId === (row.listed!.colourwayPrice ? row.line.colourwayId : null) && entryHoldsOn(entry, day)) ?? null) : null
    const withEntries = found.map((row) => ({ ...row, entry: entryOf(row) }))
    const breaks = await breaksOf(client, versionIds)
    const surcharges = (await surchargesOf(client, versionIds, [...new Set(lines.map((line) => line.styleId))])).map(surchargeRowOf)
    const lists = new Map((chain?.lists ?? []).map((list) => [list.id, list]))
    const counted = withEntries.map((row) => ({ entryId: row.entry?.id ?? null, quantity: row.line.quantity }))
    return {
      quoteId: quote.id,
      versionId: version.id,
      revision: version.revision,
      day,
      currency: version.currency,
      priceBasis: basis,
      showDiscount: await discountShownFor(client, version.priceListVersionId ?? chain?.keptVersionId ?? null),
      lines: withEntries.map(({ line, listed, entry }) => {
        const label = listed ? (lists.get(listed.listId)?.code ?? '') : ''
        const priced = linePriceOf({
          entry: entry && listed ? { id: entry.id, versionId: entry.versionId, unitPrice: listPriceText(entry.unitPrice.toString()), label: `${label} version ${lists.get(listed.listId)?.revision ?? ''}`.trim() } : null,
          breaks: entry ? breaks.filter((row) => row.versionId === entry.versionId).map(breakRowOf) : [],
          surcharges,
          styleId: line.styleId,
          quantity: entry ? breakQuantityOf(counted, entry.id) : line.quantity,
          sizes: line.sizes.map((size) => size.size),
          currency: version.currency,
          onBasis,
        })
        const list = listed ? lists.get(listed.listId) : undefined
        return {
          lineId: line.id,
          seq: line.seq,
          styleId: line.styleId,
          colourwayId: line.colourwayId,
          quantity: line.quantity,
          listUnitPrice: asMoney('price', line.listUnitPrice === null ? null : listPriceText(line.listUnitPrice.toString())),
          lineUnitPrice: asMoney('price', listPriceText(line.unitPrice.toString())),
          list:
            listed && entry
              ? { listId: listed.listId, code: list?.code ?? '', versionId: listed.versionId, revision: list?.revision ?? null, entryId: entry.id, validFrom: dayText(entry.validFrom), validTo: dayText(entry.validTo), colourwayPrice: listed.colourwayPrice, depth: listed.depth }
              : null,
          listPrice: asMoney('price', priced.listPrice),
          break: priced.break
            ? { breakId: priced.break.breakId, ownBreak: priced.break.ownBreak, minQuantity: priced.break.minQuantity, pieces: entry ? breakQuantityOf(counted, entry.id) : line.quantity, unitPrice: asMoney('price', onBasis(priced.break.unitPrice)), discountPct: asMoney('price', priced.break.discountPct), delta: asMoney('price', priced.break.delta) }
            : null,
          unitPrice: asMoney('price', priced.unitPrice),
          sizeSurcharges: priced.sizeSurcharges.map((row) => ({ size: row.size, surchargeId: row.surchargeId, scope: row.scope, amount: asMoney('price', row.onBasis), pct: asMoney('price', row.pct) })),
          steps: asMoney('price', priced.steps.map((step) => ({ ...step }))),
        }
      }),
    }
  })
}

/** GET /sales/quotes/:quoteId/line-checks: the line rules over the quote's current version. */
export async function quoteLineCheckView(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const version = await readCurrentVersion(client, quote)
    const lines = await readLineRecords(client, version.id)
    const party = await quotePartyOf(client, quote.partyId, businessDate(now), now)
    const document = await quoteDocumentOf(client, quote, version, lines, party, now)
    return { versionId: version.id, priceListId: document.priceListId, findings: (await runLineChecks(client, document)).map(findingViewOf) }
  })
}

/** GET /sales/orders/:orderId/line-checks: the line rules over an order's open lines. */
export async function orderLineCheckView(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const lines = await readOrderLines(client, order.id)
    const document = await orderDocumentOf(client, order, lines, now)
    return { orderId: order.id, priceListId: document.priceListId, findings: (await runLineChecks(client, document)).map(findingViewOf) }
  })
}
