import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { reorderPlan, type ReorderPlan } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import { priceShown } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader, type PortalReader } from '../portal-orders/access'
import { factsOf, readCatalogue, type CustomerCatalogue } from './catalogue'
import { addLinesInCommand, ownRequest, pricesFor, requestView, type NewLine } from './requests'
import { dayText, readRequest } from './store'

/**
 * Reorder a past order (B-W2b-190, SAL-072; design portal.customer.neworder "Reorder a past order": "Past orders (your
 * PO, date, pieces); pick one or some lines", "Notices per line", "Add selected lines to the draft").
 *
 *   GET  /portal/reorder/orders                   the party's past orders of the portal's company (not cancelled):
 *                                                 their PO first, our number, date, lines, pieces; newest first
 *   GET  /portal/reorder/orders/:orderId          its lines as they would be copied today: the sizes kept, today's
 *                                                 price beside the order's (price grain), and every difference in words
 *                                                 (factory-domain sales/portal-ordering reorderPlan), the colours to
 *                                                 choose instead of a discontinued one
 *   POST /portal/order-requests/:id/reorder       the chosen lines (all addable ones when none is named) into the draft
 *                                                 at today's prices, each naming the order line it came from; a line
 *                                                 with a discontinued colour goes in only with another colour chosen;
 *                                                 a style and colour the draft has already takes the sizes it lacked
 */

const LIST_MAX = 200

export async function pastOrders(app: FastifyInstance, request: FastifyRequest, query: { readonly q?: string | undefined }) {
  const reader = portalReader(app, request)
  const q = query.q?.trim()
  const rows = await request.withClient((client) =>
    client.salesOrder.findMany({
      where: {
        companyId: reader.session.company.id,
        status: { not: 'CANCELLED' },
        ...(q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { customerRef: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, number: true, customerRef: true, orderDate: true, status: true, lines: { select: { kind: true, quantity: true } } },
      orderBy: [{ orderDate: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  return {
    orders: rows.map((row) => ({
      id: row.id,
      number: row.number,
      customerRef: row.customerRef,
      orderDate: dayText(row.orderDate),
      lines: row.lines.length,
      pieces: row.lines.reduce((sum, line) => sum + line.quantity, 0),
    })),
  }
}

async function orderLinesOf(request: FastifyRequest, reader: PortalReader, orderId: string) {
  if (!isUuid(orderId)) throw new NotFoundError('Order not found.')
  const order = await request.withClient((client) =>
    client.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        companyId: true,
        number: true,
        customerRef: true,
        orderDate: true,
        status: true,
        lines: { select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, styleRevisionId: true, unitPrice: true, description: true, sizes: { select: { size: true, quantity: true } } }, orderBy: { seq: 'asc' } },
      },
    }),
  )
  if (!order || order.companyId !== reader.session.company.id || order.status === 'CANCELLED') throw new NotFoundError('Order not found.')
  const revisionIds = [...new Set(order.lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const revisions = revisionIds.length === 0 ? new Map<string, number>() : await reader.inTenant(async (db) => new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision])))
  return { order, revisions }
}

type OrderLines = Awaited<ReturnType<typeof orderLinesOf>>

function planOf(line: OrderLines['order']['lines'][number], revisions: OrderLines['revisions'], catalogue: CustomerCatalogue, seesPrices: boolean, colourwayId?: string): ReorderPlan {
  const past = {
    kind: line.kind,
    unitPrice: line.unitPrice.toString(),
    revision: line.styleRevisionId ? (revisions.get(line.styleRevisionId) ?? null) : null,
    sizes: line.sizes.filter((size) => size.size !== null && size.quantity > 0).map((size) => ({ size: size.size!, quantity: size.quantity })),
  }
  return reorderPlan(past, factsOf(catalogue, line.styleId, colourwayId ?? line.colourwayId), seesPrices)
}

export async function pastOrder(app: FastifyInstance, request: FastifyRequest, orderId: string) {
  const reader = portalReader(app, request)
  const { order, revisions } = await orderLinesOf(request, reader, orderId)
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: order.companyId, partyId: reader.session.partyId, day: businessDate(appClock(app).now()), styleIds: order.lines.map((line) => line.styleId) }))
  return {
    order: { id: order.id, number: order.number, customerRef: order.customerRef, orderDate: dayText(order.orderDate) },
    lines: order.lines.map((line) => {
      const plan = planOf(line, revisions, catalogue, reader.seesPrices)
      const facts = factsOf(catalogue, line.styleId, line.colourwayId)
      const style = catalogue.styles.get(line.styleId)
      return {
        orderLineId: line.id,
        seq: line.seq,
        style: { id: line.styleId, code: catalogue.codes.get(line.styleId)?.code ?? '', name: catalogue.codes.get(line.styleId)?.name ?? '' },
        colourway: { id: line.colourwayId, code: catalogue.colourways.get(line.colourwayId)?.code ?? '', name: catalogue.colourways.get(line.colourwayId)?.name ?? '' },
        sizesOrdered: line.sizes.filter((size) => size.size !== null).map((size) => ({ size: size.size!, quantity: size.quantity })),
        sizes: [...plan.sizes],
        pieces: plan.sizes.reduce((sum, size) => sum + size.quantity, 0),
        unitPriceThen: asMoney('price', priceShown(line.unitPrice.toString()) as string | null),
        priceNow: asMoney('price', facts?.priceNow ? priceShown(facts.priceNow) : null),
        addable: plan.addable,
        needsColour: plan.needsColour,
        colours: plan.needsColour && style ? style.colourways.filter((entry) => entry.available).map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })) : [],
        notices: [...plan.notices],
      }
    }),
    seesPrices: reader.seesPrices,
  }
}

export interface ReorderBody {
  readonly version: number
  readonly orderId: string
  /** The lines to copy (another colour for a discontinued one); none: every addable line. */
  readonly lines?: readonly { readonly orderLineId: string; readonly colourwayId?: string | undefined }[] | undefined
}

export async function reorderInto(app: FastifyInstance, request: FastifyRequest, requestId: string, body: ReorderBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownRequest(request, reader, requestId)
  if (row.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
  const { order, revisions } = await orderLinesOf(request, reader, body.orderId)
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: businessDate(appClock(app).now()), styleIds: order.lines.map((line) => line.styleId) }))
  const issues: Issue[] = []
  const chosen = body.lines ?? order.lines.map((line) => ({ orderLineId: line.id, colourwayId: undefined }))
  const lines: NewLine[] = []
  const skipped: { orderLineId: string; seq: number; notices: ReorderPlan['notices'] }[] = []
  for (const [index, pick] of chosen.entries()) {
    const line = order.lines.find((entry) => entry.id === pick.orderLineId)
    if (!line) {
      issues.push({ path: `body/lines/${index}/orderLineId`, message: 'Not a line of this order.' })
      continue
    }
    const colour = pick.colourwayId && pick.colourwayId !== line.colourwayId ? pick.colourwayId : undefined
    if (colour && catalogue.colourways.get(colour)?.styleId !== line.styleId) {
      issues.push({ path: `body/lines/${index}/colourwayId`, message: 'Not a colour of this style.' })
      continue
    }
    const plan = planOf(line, revisions, catalogue, reader.seesPrices, colour)
    if (!plan.addable) {
      if (body.lines) issues.push({ path: `body/lines/${index}`, message: plan.notices.map((notice) => notice.words.en).join(' ') })
      else skipped.push({ orderLineId: line.id, seq: line.seq, notices: plan.notices })
      continue
    }
    lines.push({ styleId: line.styleId, colourwayId: colour ?? line.colourwayId, sizes: plan.sizes, note: null, sourceOrderLineId: line.id })
  }
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  if (lines.length === 0) throw new ValidationError('No line of this order can be copied today.', skipped.flatMap((entry) => entry.notices.map((notice) => ({ path: `lines/${entry.seq}`, message: notice.words.en }))))
  const prices = pricesFor(lines, catalogue, reader.seesPrices)
  const { result } = await commandOn(app, request, { name: 'portalOrdering.reorder', idempotencyKey, input: { requestId, ...body }, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const current = await readRequest(tools.tx, row.id)
    if (current?.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
    const outcome = await addLinesInCommand(tools, row, lines, prices, reader.session.userId, true)
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      after: { reorderOf: order.id, added: outcome.added, merged: outcome.merged, kept: outcome.kept, lines: lines.map((line) => ({ sourceOrderLineId: line.sourceOrderLineId, colourwayId: line.colourwayId, sizes: line.sizes, unitPriceShown: markMoney('price', prices.get(`${line.styleId}|${line.colourwayId}`) ?? null) })) },
    })
    return outcome
  })
  return { ...(await requestView(app, request, reader, await ownRequest(request, reader, requestId))), added: result.added.length, merged: [...result.merged], kept: [...result.kept], skipped: skipped.map((entry) => ({ ...entry, notices: [...entry.notices] })) }
}
