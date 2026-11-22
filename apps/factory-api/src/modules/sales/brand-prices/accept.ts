import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { acceptanceInForce, PRICE_ACCEPT_WORDS, REACCEPTED_WORDS, type PriceAcceptRefusal } from '@nexus/factory-domain/sales/brand-prices/accept'
import { ORDERS_MONEY_PLAN } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { lockOrder, readOrder, type OrderRow, type Reader } from '../orders/store'
import { priceCheckView, pricedOrder } from './prices'
import { acceptancesOf, announceBrandPrices, auditBrandPrice, brandPriceRowsOf, checkOfOrder } from './store'

/**
 * B-OM-020 (order money tab; Owner D4, reversing the customer page's "no agreed-anyway button"; lead L3): a price difference of an
 * order accepted by hand, and taken back — the Owner and Finance (orders.moneyPlan) with the price grain over the order (else 403
 * "Shown to people who see prices"; another customer's order: not found):
 *
 *   POST   /sales/orders/:orderId/price-check/accept   { ourNet, brandNet, reason }: the nets as the person read the check (a check
 *                                                      that moved on is refused: read it again), only while it reads NOT_EQUAL;
 *                                                      an acceptance the prices left behind is taken back first, in words
 *   DELETE /sales/orders/:orderId/price-check/accept   { reason }: the acceptance not taken back, taken back
 *
 * ONE command each, under the order's row: the row (factory-db OrderPriceAcceptance, its guard the last word), its audit under
 * OrderBrandPrice with the order as the record id (the price history: never on the order's timeline), the event
 * sales_order.brand_price_changed (ids only). Never on a CLOSED or CANCELLED order. Typing the customer's price stays the Owner's
 * (orders.manage + price, unchanged). Answers the price check.
 */

const refused = (code: PriceAcceptRefusal): DomainError => new DomainError('conflict', PRICE_ACCEPT_WORDS[code].en, [{ path: `priceAccept/${code}`, message: PRICE_ACCEPT_WORDS[code].en }])
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string => (tools.context.audience === 'office' ? tools.context.actorId : SYSTEM_ACTOR_ID)
const isFinal = (status: string): boolean => status === 'CLOSED' || status === 'CANCELLED'

/** The order's check total as it reads now. */
async function totalNow(db: Reader, order: OrderRow) {
  const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, quantity: true, netAmount: true }, orderBy: { seq: 'asc' } })
  return checkOfOrder(order, lines, await brandPriceRowsOf(db, [order.id])).total
}

/** The acceptance not taken back, taken back (inside the command). */
async function withdrawInCommand(tools: CommandTools, order: OrderRow, acceptance: { readonly id: string; readonly ourNet: number; readonly brandNet: number }, reason: string): Promise<void> {
  await tools.tx.orderPriceAcceptance.update({ where: { id: acceptance.id }, data: { withdrawnAt: tools.now, withdrawnById: actorIdOf(tools), withdrawReason: reason }, select: { id: true } })
  auditBrandPrice(tools, order, { action: 'brandPrices.unaccept', before: { acceptanceId: acceptance.id, ourNet: markMoney('price', acceptance.ourNet), brandNet: markMoney('price', acceptance.brandNet) }, after: { acceptanceId: acceptance.id, withdrawn: true }, reason })
}

/** The body as the route gives it: every key money-marked (the price grain), so each may be absent — checked here (400). */
export interface AcceptBody {
  readonly ourNet?: number | undefined
  readonly brandNet?: number | undefined
  readonly reason?: string | undefined
}
const missing = (path: string, message: string): ValidationError => new ValidationError(message, [{ path: `body/${path}`, message }])
const REASON_WORDS = 'Say why (3 to 500 characters): it is kept in the price history.'

/** POST /sales/orders/:orderId/price-check/accept. */
export async function acceptPriceDifference(caller: CommandCaller, orderId: string, body: AcceptBody, idempotencyKey?: string) {
  const { context, order } = await pricedOrder(caller, orderId, ORDERS_MONEY_PLAN)
  if (body.ourNet === undefined || body.brandNet === undefined) throw missing(body.ourNet === undefined ? 'ourNet' : 'brandNet', 'Send both nets as you read them on the price check.')
  if (body.reason === undefined) throw missing('reason', REASON_WORDS)
  const nets = { ourNet: body.ourNet, brandNet: body.brandNet }
  if (isFinal(order.status)) throw refused('CLOSED')
  const reason = body.reason.trim()
  await command(caller, { name: 'brandPrices.accept', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockOrder(tx, order.id)
    const fresh = (await readOrder(tx, order.id))!
    if (isFinal(fresh.status)) throw refused('CLOSED')
    const total = await totalNow(tx, fresh)
    if (total.priceMatch !== 'NOT_EQUAL') throw refused('NOTHING_TO_ACCEPT')
    if (nets.ourNet !== total.ourPrice || nets.brandNet !== total.brandPrice) throw refused('STALE')
    const standing = (await acceptancesOf(tx, [fresh.id])).get(fresh.id)
    if (standing && acceptanceInForce(total, standing)) throw refused('ACCEPTED_ALREADY')
    // An acceptance the prices left behind (still not taken back): taken back first, in words.
    if (standing) await withdrawInCommand(tools, fresh, standing, REACCEPTED_WORDS)
    const id = newId()
    await tx.orderPriceAcceptance.create({
      data: { id, companyId: fresh.companyId, partyId: fresh.partyId, salesOrderId: fresh.id, ourNet: nets.ourNet, brandNet: nets.brandNet, reason, acceptedById: actorIdOf(tools), acceptedAt: now },
      select: { id: true },
    })
    auditBrandPrice(tools, fresh, { action: 'brandPrices.accept', after: { acceptanceId: id, ourNet: markMoney('price', nets.ourNet), brandNet: markMoney('price', nets.brandNet), difference: markMoney('price', nets.ourNet - nets.brandNet) }, reason })
    announceBrandPrices(tools, fresh)
    return { acceptanceId: id }
  })
  return caller.withClient(async (client) => priceCheckView(client, context, (await readOrder(client, order.id)) ?? order))
}

/** DELETE /sales/orders/:orderId/price-check/accept. */
export async function takeBackPriceDifference(caller: CommandCaller, orderId: string, body: { readonly reason?: string | undefined }, idempotencyKey?: string) {
  const { context, order } = await pricedOrder(caller, orderId, ORDERS_MONEY_PLAN)
  if (body.reason === undefined) throw missing('reason', REASON_WORDS)
  if (isFinal(order.status)) throw refused('CLOSED')
  const reason = body.reason.trim()
  await command(caller, { name: 'brandPrices.unaccept', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    await lockOrder(tools.tx, order.id)
    const fresh = (await readOrder(tools.tx, order.id))!
    if (isFinal(fresh.status)) throw refused('CLOSED')
    const standing = (await acceptancesOf(tools.tx, [fresh.id])).get(fresh.id)
    if (!standing) throw refused('NOT_ACCEPTED')
    await withdrawInCommand(tools, fresh, standing, reason)
    announceBrandPrices(tools, fresh)
    return { acceptanceId: standing.id }
  })
  return caller.withClient(async (client) => priceCheckView(client, context, (await readOrder(client, order.id)) ?? order))
}
