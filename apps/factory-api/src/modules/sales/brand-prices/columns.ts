import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { asMoney, asMoneyKeys, type Money } from '@nexus/factory-domain/money/marked'
import type { PriceCheckTotal, PriceMatch } from '@nexus/factory-domain/sales/brand-prices/match'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { ExportColumn } from '../../../platform/exports/source'
import { officeContextOf } from '../orders/access'
import type { Reader } from '../orders/store'
import { brandPriceRowsOf, checkOfOrder, NOT_A_PRICE_HOLDER, PRICE_PERMISSION } from './store'

/**
 * The price check in the Orders list (customer page plan C2d, B-CP-018; design customer-page 11 §1.2, §3.1, §3.5; review B4, B5):
 *
 *   row columns   `brandPrice` (the customer's price of the order), `priceMatch`, `priceDiff` (ours − the customer's) and
 *                 `priceNotEqualLines` — read only for a reader holding the price grain (as paid and balance), money-marked in
 *                 the list's contract, so the grain filter drops them for everyone else (absent, not empty). Our price is the
 *                 row's own `netAmount`.
 *   the term      `priceMatch=NOT_EQUAL|NO_BRAND_PRICE|EQUAL` narrows the list (and its totals and its file, which read the
 *                 same filter): refused 403 here, in words, to a person without the price grain — the grain filter checks a
 *                 body and an answer, never a query (review B5); there is no sort by a price field. The candidates are the
 *                 list's own where; the orders with a customer's price among them are checked (factory-domain priceCheckOf),
 *                 at most PRICE_CHECK_CAP at once (else 400 in words: narrow the list first); an order with none is "No
 *                 customer price yet" by itself.
 *   the summary   GET /sales/brand-prices/summary?partyId=&companyId=: how many of ONE customer's orders read Not equal and No
 *                 customer price yet (the Work tab's view chip), every status, as the list's `rows=all` — never a total over
 *                 customers; a customer out of the reader's reach (or none) is not found, like an unknown id (the brand wall),
 *                 and the price grain over it is asked (403 in words).
 *   the file      PRICE_CHECK_EXPORT: the four columns of the `sales.orders` source, each of the price grain (a file of a
 *                 person without it leaves them out and names them above the header).
 *
 * The column ids are fixed (`ourPrice`, `brandPrice`, `priceMatch`, `priceDiff`): the Owner's sheet names go on them in words.
 */

/** The most orders with a customer's price that one price-check term checks. */
export const PRICE_CHECK_CAP = 2_000
const CHUNK = 500

export const PRICE_CHECK_WORDS = Object.freeze({
  tooMany: 'Too many orders to check at once: narrow the list first.',
  customerNotFound: 'Customer not found.',
})

/** The checks of some orders, by order id: one reading of their lines and their customer's prices, in chunks. */
export async function priceChecksOf(db: Reader, orderIds: readonly string[]): Promise<Map<string, PriceCheckTotal>> {
  const out = new Map<string, PriceCheckTotal>()
  for (let start = 0; start < orderIds.length; start += CHUNK) {
    const ids = orderIds.slice(start, start + CHUNK)
    const orders = await db.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, currency: true, netAmount: true } })
    const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: ids } }, select: { id: true, orderId: true, quantity: true, netAmount: true }, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
    const rows = await brandPriceRowsOf(db, ids)
    const linesOf = new Map<string, typeof lines>()
    for (const line of lines) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line])
    const rowsOf = new Map<string, typeof rows>()
    for (const row of rows) rowsOf.set(row.salesOrderId, [...(rowsOf.get(row.salesOrderId) ?? []), row])
    for (const order of orders) out.set(order.id, checkOfOrder(order, linesOf.get(order.id) ?? [], rowsOf.get(order.id) ?? []).total)
  }
  return out
}

/** A list row's price check (the price grain). */
export interface OrderPriceColumns {
  readonly brandPrice: Money<'price', number | null>
  readonly priceMatch: Money<'price', PriceMatch>
  readonly priceDiff: Money<'price', number | null>
  readonly priceNotEqualLines: Money<'price', number>
}

/** The price check of each order of a page, by order id — only for a reader holding the price grain (null for anyone else). */
export async function orderPriceColumns(db: Reader, actor: Actor, orderIds: readonly string[]): Promise<Map<string, OrderPriceColumns> | null> {
  if (!heldGrains(actor).has('price')) return null
  const checks = await priceChecksOf(db, orderIds)
  const out = new Map<string, OrderPriceColumns>()
  for (const [orderId, check] of checks) {
    out.set(orderId, { brandPrice: asMoney('price', check.brandPrice), priceMatch: asMoney('price', check.priceMatch), priceDiff: asMoney('price', check.priceDiff), priceNotEqualLines: asMoney('price', check.priceNotEqualLines) })
  }
  return out
}

/** The `priceMatch` term of a list (its totals and its file): the list's own where, narrowed to the orders that read `match`. */
export async function priceMatchWhere(db: Reader, actor: Actor, base: Prisma.SalesOrderWhereInput, match: PriceMatch): Promise<Prisma.SalesOrderWhereInput> {
  if (!heldGrains(actor).has('price')) throw new ForbiddenError(NOT_A_PRICE_HOLDER)
  const priced = (await db.salesOrder.findMany({ where: { AND: [base, { brandPrices: { some: {} } }] }, select: { id: true }, orderBy: { id: 'asc' }, take: PRICE_CHECK_CAP + 1 })).map((row) => row.id)
  if (priced.length > PRICE_CHECK_CAP) throw new ValidationError(PRICE_CHECK_WORDS.tooMany, [{ path: 'query/priceMatch', message: PRICE_CHECK_WORDS.tooMany }])
  const checks = await priceChecksOf(db, priced)
  const kept = priced.filter((id) => checks.get(id)?.priceMatch === match)
  if (match === 'NO_BRAND_PRICE') return { AND: [base, { OR: [{ brandPrices: { none: {} } }, { id: { in: kept } }] }] }
  return { AND: [base, { id: { in: kept } }] }
}

/** GET /sales/brand-prices/summary (see the module's head). */
export async function brandPriceSummary(caller: CommandCaller, query: { readonly partyId: string; readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const scope = { companyId: query.companyId ?? null, partyId: query.partyId }
  return caller.withClient(async (client) => {
    const party = await client.party.findFirst({ where: { AND: [scopeWhere(actor, ORDERS_VIEW, { party: 'id' }) as Prisma.PartyWhereInput, { id: query.partyId }] }, select: { id: true } })
    if (!party || !can(actor, ORDERS_VIEW, scope)) throw new NotFoundError(PRICE_CHECK_WORDS.customerNotFound)
    if (!can(actor, PRICE_PERMISSION, scope)) throw new ForbiddenError(NOT_A_PRICE_HOLDER)
    const where: Prisma.SalesOrderWhereInput = {
      AND: [scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput, { partyId: query.partyId }, query.companyId ? { companyId: query.companyId } : {}],
    }
    const priced = (await client.salesOrder.findMany({ where: { AND: [where, { brandPrices: { some: {} } }] }, select: { id: true } })).map((row) => row.id)
    const unpriced = await client.salesOrder.count({ where: { AND: [where, { brandPrices: { none: {} } }] } })
    const checks = await priceChecksOf(client, priced)
    let priceNotEqualCount = 0
    let priceMissingCount = unpriced
    for (const id of priced) {
      const match = checks.get(id)?.priceMatch
      if (match === 'NOT_EQUAL') priceNotEqualCount++
      else if (match === 'NO_BRAND_PRICE') priceMissingCount++
    }
    return asMoneyKeys('price', { partyId: query.partyId, priceNotEqualCount, priceMissingCount }) // B-CP-018: every key is the price grain
  })
}

// ---- the file ---------------------------------------------------------------------------------------------------------------

/** What a list row carries for the four columns (the price fields only for a price holder). */
export interface PriceCheckRow {
  readonly currency: string
  readonly netAmount: number
  readonly brandPrice?: number | null | undefined
  readonly priceMatch?: PriceMatch | null | undefined
  readonly priceDiff?: number | null | undefined
}

const money = (minor: number | null | undefined, currency: string) => (minor === null || minor === undefined ? null : { minor: Number(minor), currency })

/** The four columns of the `sales.orders` file (the web's column ids), each of the price grain. */
export function priceCheckExport<Row extends PriceCheckRow>(): Readonly<Record<'ourPrice' | 'brandPrice' | 'priceMatch' | 'priceDiff', ExportColumn<Row>>> {
  return {
    ourPrice: { grain: 'price', value: (row) => money(row.netAmount, row.currency) },
    brandPrice: { grain: 'price', value: (row) => money(row.brandPrice, row.currency) },
    priceMatch: { grain: 'price', value: (row, words) => (row.priceMatch ? words(`priceMatch.${row.priceMatch}`) : null) },
    priceDiff: { grain: 'price', value: (row) => money(row.priceDiff, row.currency) },
  }
}

/** The words of the Price check cell in a file (the plan's orders.json priceCheck.* words, design 11 §6). */
export const PRICE_CHECK_EXPORT_WORDS: Readonly<Record<ExportLocale, Readonly<Record<string, string>>>> = {
  it: { 'priceMatch.EQUAL': 'Uguale', 'priceMatch.NOT_EQUAL': 'Diverso', 'priceMatch.NO_BRAND_PRICE': 'Prezzo del cliente non ancora dato' },
  en: { 'priceMatch.EQUAL': 'Equal', 'priceMatch.NOT_EQUAL': 'Not equal', 'priceMatch.NO_BRAND_PRICE': 'No customer price yet' },
}
