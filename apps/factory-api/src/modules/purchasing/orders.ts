import type { Prisma } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { cancellationMail, purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { draftProblem, isPurchaseParty, ordersContactOf, supplierLanguageOf, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { cancelOrderProblem, supplierHolds } from '@nexus/factory-domain/purchasing/orders/changes'
import { daysLate, deliveryStateOf, DELIVERY_STATES, EXPECTING_STATUSES, expectedDateOf, type DeliveryState } from '@nexus/factory-domain/purchasing/orders/delivery'
import { expectedBaseOf, lineDifference } from '@nexus/factory-domain/inventory/receipts/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { PURCHASING_MANAGE, PURCHASING_SEND, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { sendEmail } from '../../platform/email-out/outbound'
import { allocateNumber } from '../../platform/numbering/allocate'
import { unorderRequirement } from '../planning/hooks'
import { revokeConfirmLinks } from './confirm-links'
import { lockOrderReceiving, receiptStopsCancel } from './receiving'
import { endLineFactsOf, reachOf, type Reach } from './revisions/reach'
import {
  actorIdOf,
  assertMay,
  CONTACT_COLUMNS,
  dayOf,
  dayValue,
  mayOn,
  officeContextOf,
  officeOrder,
  PARTY_COLUMNS,
  readOrder,
  senderOf,
  SITE_COLUMNS,
  type OrderRow,
  type PartyRow,
} from './store'
import { orderDetail, type OrderDetail } from './views'

/**
 * Purchase orders (B-W1-30; SCM-050, SCM-053; A2 SCR-058 "Purchase orders", SCR-059 the record): the list, the record, a
 * new draft, its header, and the cancellation. An order is made by a company for one of its sites (where the goods are
 * delivered) to a supplier (a party with the SUPPLIER or SUBCONTRACTOR role, never BLOCKED or ARCHIVED), numbered from
 * the company's PURCHASE_ORDER series in the same command, in the supplier's currency, to its first contact who takes
 * ORDERS. Every write is ONE command on the PurchaseOrder: its version is the edit-conflict guard and its bump locks the
 * row, so two writes to one order never interleave (a send and a cancel included: the second finds a newer version).
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The record after a write, in the command (the answer of every write route). */
export async function detailInCommand(tools: CommandTools, orderId: string): Promise<{ order: OrderDetail }> {
  const order = (await readOrder(tools.tx, orderId))!
  return { order: await orderDetail(tools.tx, tools.context, order, tools.now) }
}

/**
 * A command on an order the caller may act on: the order's version guards it and locks the row; the work gets the order
 * as it is now.
 */
export async function onOrder<Result>(
  caller: CommandCaller,
  order: OrderRow,
  spec: { readonly name: `purchasing.${string}`; readonly idempotencyKey: string | undefined; readonly input: unknown; readonly version: number },
  work: (tools: CommandTools, current: OrderRow) => Promise<Result>,
): Promise<Result> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: spec.version } }, async (tools) =>
    work(tools, (await readOrder(tools.tx, order.id))!),
  )
  return result
}

/** Lines and terms change only while the order is a draft (the …_supply_guards triggers say so too). */
export function assertDraft(order: Pick<OrderRow, 'status'>): void {
  const problem = draftProblem(order.status as PurchaseOrderStatus)
  if (problem) throw new InvalidStateError(problem)
}

/** An order goes only to a supplier that is not blocked or archived (a prospect is drafted, not sent). */
export function assertBuyable(party: PartyRow, path = 'body/partyId'): void {
  if (!isPurchaseParty(party.roles)) throw new ValidationError('This party is not a supplier.', [{ path, message: 'Give the party the supplier role first.' }])
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') {
    throw new DomainError('conflict', `${party.legalName} is ${party.status.toLowerCase()}: no purchase order goes to it; pick another approved source.`, [{ path, message: `The supplier is ${party.status}.` }])
  }
}

/**
 * The order's total: the sum of its lines (kept current while it is a draft; the trigger checks it at the send). B-W2a-52:
 * a cancelled line is not sent, so it counts no more (the …_supply_w2a_guards trigger sums the lines not cancelled).
 */
export async function refreshTotal(tools: CommandTools, orderId: string): Promise<number> {
  const sum = await tools.tx.purchaseOrderLine.aggregate({ where: { purchaseOrderId: orderId, cancelledAt: null }, _sum: { netAmount: true } })
  const netAmount = sum._sum.netAmount ?? 0
  await tools.tx.purchaseOrder.update({ where: { id: orderId }, data: { netAmount }, select: { id: true } })
  return netAmount
}

export interface DraftHeader {
  readonly contactId?: string | null | undefined
  readonly currency?: string | undefined
  readonly requestedDate?: string | null | undefined
  readonly incoterms?: string | null | undefined
  readonly paymentTerms?: string | null | undefined
  readonly note?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

async function contactProblems(tools: CommandTools, partyId: string, contactId: string | null | undefined): Promise<Issue[]> {
  if (!contactId) return []
  const contact = await tools.tx.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true } })
  return !contact || contact.partyId !== partyId || contact.status !== 'ACTIVE' ? [{ path: 'body/contactId', message: 'Not an active contact of this supplier.' }] : []
}

/**
 * Inside a command: a new DRAFT order of the company for its site to the supplier, numbered from the company's
 * PURCHASE_ORDER series, with the supplier's defaults (currency, payment terms, its first orders contact). Audited, and
 * purchase_order.created. The caller checked the permission and the supplier.
 */
export async function insertDraft(tools: CommandTools, input: { readonly companyId: string; readonly siteId: string; readonly party: PartyRow; readonly header: DraftHeader; readonly source: 'OFFICE' | 'PLAN' }): Promise<{ id: string; number: string }> {
  const { tx, now } = tools
  const { party, header } = input
  const contactId =
    header.contactId === undefined
      ? (ordersContactOf(await tx.partyContact.findMany({ where: { partyId: party.id }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))?.id ?? null)
      : header.contactId
  const id = newId()
  const issued = await allocateNumber(tools, { companyId: input.companyId, kind: 'PURCHASE_ORDER' }, { type: 'PurchaseOrder', id })
  const currency = header.currency ?? party.currency
  const data = {
    id,
    companyId: input.companyId,
    siteId: input.siteId,
    number: issued.formatted,
    partyId: party.id,
    contactId,
    currency,
    orderDate: dayValue(businessDate(now)),
    requestedDate: header.requestedDate ? dayValue(header.requestedDate) : null,
    incoterms: blankToNull(header.incoterms),
    paymentTerms: header.paymentTerms === undefined ? party.paymentTerms : blankToNull(header.paymentTerms),
    note: blankToNull(header.note),
    internalNote: blankToNull(header.internalNote),
    createdById: actorIdOf(tools),
  }
  await tx.purchaseOrder.create({ data, select: { id: true } })
  tools.audit({
    action: 'purchasing.create',
    recordType: 'PurchaseOrder',
    recordId: id,
    companyId: input.companyId,
    siteId: input.siteId,
    after: { number: issued.formatted, partyId: party.id, contactId, currency, status: 'DRAFT', source: input.source, requestedDate: header.requestedDate ?? null },
  })
  tools.emit({ type: 'purchase_order.created', subject: id, companyId: input.companyId, siteId: input.siteId, payload: { purchaseOrderId: id, number: issued.formatted, partyId: party.id, siteId: input.siteId, source: input.source } })
  return { id, number: issued.formatted }
}

// ---- create -----------------------------------------------------------------------------------------------------------

export interface CreateOrderInput extends DraftHeader {
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
}

/** purchasing.manage over the company, site and supplier: a new DRAFT order (lines come next). */
export async function createOrder(caller: CommandCaller, body: CreateOrderInput, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const context = officeContextOf(caller)
  assertMay(context, PURCHASING_MANAGE, { companyId: body.companyId, siteId: body.siteId, partyId: body.partyId }, 'Supplier')
  const { result } = await command(caller, { name: 'purchasing.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const site = await tx.site.findUnique({ where: { id: body.siteId }, select: SITE_COLUMNS })
    if (!site || site.companyId !== body.companyId) throw new NotFoundError('Site not found.')
    if (site.status !== 'ACTIVE') throw new InvalidStateError('The site is archived: nothing is delivered there.')
    const party = await tx.party.findUnique({ where: { id: body.partyId }, select: PARTY_COLUMNS })
    if (!party || (party.companyId !== null && party.companyId !== body.companyId)) throw new NotFoundError('Supplier not found.')
    assertBuyable(party)
    const issues = await contactProblems(tools, party.id, body.contactId)
    if (body.currency !== undefined && !isCurrencyCode(body.currency)) issues.push({ path: 'body/currency', message: 'Expected an ISO 4217 currency code.' })
    if (body.requestedDate && body.requestedDate < businessDate(now)) issues.push({ path: 'body/requestedDate', message: 'The delivery date asked for is today or later.' })
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    const { id } = await insertDraft(tools, { companyId: body.companyId, siteId: site.id, party, header: body, source: 'OFFICE' })
    return detailInCommand(tools, id)
  })
  return result
}

// ---- the header -------------------------------------------------------------------------------------------------------

export interface UpdateOrderInput extends DraftHeader {
  readonly version: number
}

/**
 * purchasing.manage: the draft's contact, currency (only while it has no line: the prices are in it), dates, terms and
 * notes. The internal note alone also changes after the send (the office's own).
 */
export async function updateOrder(caller: CommandCaller, orderId: string, body: UpdateOrderInput, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  const { version, ...fields } = body
  return onOrder(caller, order, { name: 'purchasing.update', idempotencyKey, input: { orderId, ...body }, version }, async (tools, current) => {
    const names = Object.keys(fields).filter((key) => fields[key as keyof DraftHeader] !== undefined)
    if (names.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
    if (names.some((name) => name !== 'internalNote')) assertDraft(current)
    const issues = await contactProblems(tools, current.partyId, fields.contactId)
    if (fields.requestedDate && fields.requestedDate < businessDate(tools.now)) issues.push({ path: 'body/requestedDate', message: 'The delivery date asked for is today or later.' })
    if (fields.currency !== undefined && fields.currency !== current.currency) {
      if (!isCurrencyCode(fields.currency)) issues.push({ path: 'body/currency', message: 'Expected an ISO 4217 currency code.' })
      else if ((await tools.tx.purchaseOrderLine.count({ where: { purchaseOrderId: current.id } })) > 0) issues.push({ path: 'body/currency', message: 'The lines are priced in the current currency: remove them first.' })
    }
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    const data: Prisma.PurchaseOrderUncheckedUpdateInput = {}
    if (fields.contactId !== undefined) data.contactId = fields.contactId
    if (fields.currency !== undefined) data.currency = fields.currency
    if (fields.requestedDate !== undefined) data.requestedDate = fields.requestedDate ? dayValue(fields.requestedDate) : null
    if (fields.incoterms !== undefined) data.incoterms = blankToNull(fields.incoterms)
    if (fields.paymentTerms !== undefined) data.paymentTerms = blankToNull(fields.paymentTerms)
    if (fields.note !== undefined) data.note = blankToNull(fields.note)
    if (fields.internalNote !== undefined) data.internalNote = blankToNull(fields.internalNote)
    await tools.tx.purchaseOrder.update({ where: { id: current.id }, data, select: { id: true } })
    const before = Object.fromEntries(names.map((name) => [name, name === 'requestedDate' ? dayOf(current.requestedDate) : current[name as keyof OrderRow]]))
    tools.audit({ action: 'purchasing.update', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before, after: Object.fromEntries(names.map((name) => [name, fields[name as keyof DraftHeader] ?? null])) })
    tools.emit({ type: 'purchase_order.updated', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, fields: names } })
    return detailInCommand(tools, current.id)
  })
}

// ---- read -------------------------------------------------------------------------------------------------------------

export async function getOrder(caller: CommandCaller, orderId: string): Promise<{ order: OrderDetail }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => ({ order: await orderDetail(client, context, order, serverClock.now()) }))
}

export interface ListOrdersQuery {
  readonly status?: PurchaseOrderStatus | undefined
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly q?: string | undefined
  readonly waitingOver48h?: boolean | undefined
  /** B-W2a-52 (SCM-067): only orders with an open line expected late, or this week (today to Sunday). */
  readonly due?: 'LATE' | 'THIS_WEEK' | undefined
  /** B-W2a-52 (SCM-087): only orders still waiting for the supplier's answer after their confirm-by time. */
  readonly pastConfirmBy?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const WAITING_MS = 48 * 60 * 60 * 1000
/** At most this many open lines are read for the delivery tiles and the expected deliveries (`complete` says if all were). */
export const EXPECTED_LINES_READ = 5000

export interface ExpectedLine {
  readonly lineId: string
  readonly purchaseOrderId: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly uom: Uom
  readonly needDate: string
  readonly confirmedDate: string | null
  readonly expectedDate: string
  readonly dateFrom: 'CONFIRMED' | 'ASKED'
  readonly orderedBase: string
  readonly expectedBase: string
  readonly receivedBase: string
  readonly outstandingBase: string
  readonly state: DeliveryState
  readonly daysLate: number
}

/**
 * B-W2a-52 (SCM-067): the open lines of the orders this filter finds that still wait for goods: the order sent (waiting,
 * confirmed, with changes proposed, partly received), the line neither cancelled nor closed short nor received in full;
 * each expected on its confirmed date, else its need date (LATE before today, THIS_WEEK to Sunday, LATER).
 */
export async function expectedLinesOf(client: Prisma.TransactionClient, filters: readonly Prisma.PurchaseOrderWhereInput[], today: string): Promise<{ lines: ExpectedLine[]; complete: boolean }> {
  const rows = await client.purchaseOrderLine.findMany({
    where: { cancelledAt: null, closedShortAt: null, purchaseOrder: { AND: [...filters, { status: { in: [...EXPECTING_STATUSES] } }] } },
    orderBy: [{ needDate: 'asc' }, { id: 'asc' }],
    take: EXPECTED_LINES_READ + 1,
    select: { id: true, purchaseOrderId: true, seq: true, itemId: true, itemColourId: true, uom: true, quantity: true, baseQuantity: true, confirmedQuantity: true, needDate: true, confirmedDate: true, areaTolerancePct: true },
  })
  const page = rows.slice(0, EXPECTED_LINES_READ)
  const sums = page.length === 0 ? [] : await client.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: page.map((row) => row.id) }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
  const received = new Map(sums.map((row) => [row.purchaseOrderLineId!, new Decimal(row._sum.baseQuantity?.toString() ?? '0')]))
  const lines = page.flatMap((row): ExpectedLine[] => {
    const expected = expectedBaseOf({ quantity: row.quantity.toString(), baseQuantity: row.baseQuantity.toString(), confirmedQuantity: row.confirmedQuantity?.toString() ?? null })
    const came = received.get(row.id) ?? new Decimal(0)
    if (lineDifference({ expected, receivedBefore: came, receiving: '0', tolerancePct: row.areaTolerancePct?.toString() ?? null }).complete) return []
    // A line the supplier confirmed at 0 (it cannot deliver it) is expected never: it is no delivery.
    if (row.confirmedQuantity !== null && row.confirmedQuantity.isZero()) return []
    const needDate = dayOf(row.needDate)!
    const confirmedDate = dayOf(row.confirmedDate)
    const expectedDate = expectedDateOf({ confirmedDate, needDate })
    const rest = expected.minus(came)
    return [
      {
        lineId: row.id,
        purchaseOrderId: row.purchaseOrderId,
        seq: row.seq,
        itemId: row.itemId,
        itemColourId: row.itemColourId,
        uom: row.uom as Uom,
        needDate,
        confirmedDate,
        expectedDate,
        dateFrom: confirmedDate ? 'CONFIRMED' : 'ASKED',
        orderedBase: row.baseQuantity.toFixed(4),
        expectedBase: expected.toFixed(4),
        receivedBase: came.toFixed(4),
        outstandingBase: (rest.gt(0) ? rest : new Decimal(0)).toFixed(4),
        state: deliveryStateOf(expectedDate, today),
        daysLate: daysLate(expectedDate, today),
      },
    ]
  })
  return { lines, complete: rows.length <= EXPECTED_LINES_READ }
}

const ordersWith = (lines: readonly ExpectedLine[], state: DeliveryState): string[] => [...new Set(lines.filter((line) => line.state === state).map((line) => line.purchaseOrderId))]

function listFiltersOf(caller: CommandCaller, query: Pick<ListOrdersQuery, 'companyId' | 'siteId' | 'partyId' | 'q'>): Prisma.PurchaseOrderWhereInput[] {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
  return [
    scope,
    query.companyId ? { companyId: query.companyId } : {},
    query.siteId ? { siteId: query.siteId } : {},
    query.partyId ? { partyId: query.partyId } : {},
    query.q ? { number: { contains: query.q, mode: 'insensitive' } } : {},
  ]
}

/**
 * purchasing.view: the orders the caller reaches (scopeWhere: company, site, supplier), newest first, with the tiles
 * "Where POs stand": drafts to send, waiting for the supplier, not confirmed after 48 hours, declined; B-W2a-52: due this
 * week and late (orders with an open line expected so), and past their confirm-by time.
 */
export async function listOrders(caller: CommandCaller, query: ListOrdersQuery) {
  const filters = listFiltersOf(caller, query)
  const now = serverClock.now()
  const today = businessDate(now)
  const waitingLongWhere: Prisma.PurchaseOrderWhereInput = { status: 'SENT', sentAt: { lt: new Date(now.getTime() - WAITING_MS) } }
  const pastConfirmByWhere: Prisma.PurchaseOrderWhereInput = { status: 'SENT', confirmBy: { lte: now } }
  return caller.withClient(async (client) => {
    const expected = await expectedLinesOf(client as unknown as Prisma.TransactionClient, filters, today)
    const late = ordersWith(expected.lines, 'LATE')
    const thisWeek = ordersWith(expected.lines, 'THIS_WEEK')
    const dueWhere: Prisma.PurchaseOrderWhereInput = query.due === 'LATE' ? { id: { in: late } } : query.due === 'THIS_WEEK' ? { id: { in: thisWeek } } : {}
    const rows = await client.purchaseOrder.findMany({
      where: { AND: [...filters, query.status ? { status: query.status } : {}, query.waitingOver48h ? waitingLongWhere : {}, query.pastConfirmBy ? pastConfirmByWhere : {}, dueWhere, query.cursor ? { id: { lt: query.cursor } } : {}] },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, revision: true, currency: true, orderDate: true, requestedDate: true, netAmount: true, sentAt: true, confirmBy: true, confirmedAt: true, confirmedVia: true, confirmedByName: true, declinedAt: true, createdById: true, updatedAt: true, version: true },
    })
    const page = rows.slice(0, query.limit)
    const ids = page.map((row) => row.id)
    const lines = ids.length === 0 ? [] : await client.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: ids } }, select: { purchaseOrderId: true, needDate: true, confirmedDate: true, cancelledAt: true } })
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]))
    const counted = await client.purchaseOrder.groupBy({ by: ['status'], where: { AND: [...filters, { status: { in: ['DRAFT', 'SENT', 'CHANGES_PROPOSED', 'DECLINED'] } }] }, _count: { _all: true } })
    const count = (status: string) => counted.find((row) => row.status === status)?._count._all ?? 0
    const waitingLong = await client.purchaseOrder.count({ where: { AND: [...filters, waitingLongWhere] } })
    const pastConfirmBy = await client.purchaseOrder.count({ where: { AND: [...filters, pastConfirmByWhere] } })
    return {
      summary: {
        drafts: count('DRAFT'),
        waiting: count('SENT'),
        notConfirmedAfter48h: waitingLong,
        changesProposed: count('CHANGES_PROPOSED'),
        declined: count('DECLINED'),
        // B-W2a-52: null when more open lines exist than were read ("—", never a wrong number).
        dueThisWeek: expected.complete ? thisWeek.length : null,
        late: expected.complete ? late.length : null,
        pastConfirmBy,
      },
      orders: page.map((row) => {
        const own = lines.filter((line) => line.purchaseOrderId === row.id && line.cancelledAt === null)
        const need = own.map((line) => dayOf(line.needDate)!).sort()
        const confirmed = own.flatMap((line) => (line.confirmedDate ? [dayOf(line.confirmedDate)!] : [])).sort()
        const open = expected.lines.filter((line) => line.purchaseOrderId === row.id)
        const next = open.map((line) => line.expectedDate).sort()[0] ?? null
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          siteId: row.siteId,
          partyId: row.partyId,
          supplierName: parties.get(row.partyId) ?? '',
          status: row.status,
          revision: row.revision,
          currency: row.currency,
          orderDate: dayOf(row.orderDate)!,
          requestedDate: dayOf(row.requestedDate),
          earliestNeedDate: need[0] ?? null,
          latestConfirmedDate: confirmed.at(-1) ?? null,
          lineCount: own.length,
          netAmount: asMoney('cost', row.netAmount),
          sentAt: row.sentAt === null ? null : toUtcIso(row.sentAt),
          confirmBy: row.confirmBy === null ? null : toUtcIso(row.confirmBy),
          confirmedAt: row.confirmedAt === null ? null : toUtcIso(row.confirmedAt),
          confirmedVia: row.confirmedVia,
          confirmedByName: row.confirmedByName,
          declinedAt: row.declinedAt === null ? null : toUtcIso(row.declinedAt),
          // B-W2a-52: the next open line's expected day and how the order's deliveries stand (null: nothing expected).
          nextExpectedDate: next,
          delivery: next === null ? null : open.some((line) => line.state === 'LATE') ? ('LATE' as const) : deliveryStateOf(next, today),
          createdById: row.createdById,
          updatedAt: toUtcIso(row.updatedAt),
          version: row.version,
        }
      }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    }
  })
}

export interface ExpectedQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly state?: DeliveryState | undefined
  readonly limit: number
}

/**
 * GET /purchasing/expected (purchasing.view; B-W2a-52, SCM-067 "Expected deliveries view", the list's "Expected
 * deliveries (view)"): the open lines the caller's orders still wait for, the earliest expected first, with the tiles
 * late · this week · later (lines and orders). Quantities in the material's base unit; no price.
 */
export async function expectedDeliveries(caller: CommandCaller, query: ExpectedQuery) {
  const filters = listFiltersOf(caller, query)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const expected = await expectedLinesOf(client as unknown as Prisma.TransactionClient, filters, today)
    const chosen = expected.lines.filter((line) => !query.state || line.state === query.state).sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : a.seq - b.seq))
    const page = chosen.slice(0, query.limit)
    const orderIds = [...new Set(page.map((line) => line.purchaseOrderId))]
    const orders = new Map((orderIds.length === 0 ? [] : await client.purchaseOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true, revision: true, partyId: true, siteId: true, companyId: true } })).map((row) => [row.id, row]))
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set([...orders.values()].map((row) => row.partyId))] } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
    const items = new Map((await client.item.findMany({ where: { id: { in: [...new Set(page.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
    const colourIds = [...new Set(page.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
    const colours = new Map((colourIds.length === 0 ? [] : await client.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const tile = (state: DeliveryState) => {
      const lines = expected.lines.filter((line) => line.state === state)
      return { lines: lines.length, orders: new Set(lines.map((line) => line.purchaseOrderId)).size }
    }
    return {
      today,
      complete: expected.complete,
      tiles: Object.fromEntries(DELIVERY_STATES.map((state) => [state, tile(state)])) as Record<DeliveryState, { lines: number; orders: number }>,
      lines: page.map((line) => {
        const order = orders.get(line.purchaseOrderId)!
        const item = items.get(line.itemId)
        const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
        return {
          ...line,
          number: order.number,
          status: order.status,
          revision: order.revision,
          companyId: order.companyId,
          siteId: order.siteId,
          partyId: order.partyId,
          supplierName: parties.get(order.partyId) ?? '',
          item: { code: item?.code ?? '', name: item?.name ?? '' },
          baseUom: (item?.baseUom ?? null) as Uom | null,
          colour: colour ? { code: colour.code, name: colour.name } : null,
        }
      }),
      more: chosen.length > page.length,
    }
  })
}

// ---- cancel -----------------------------------------------------------------------------------------------------------

export interface CancelInput {
  readonly version: number
  readonly reason: string
  /** Words for the supplier, in the cancellation mail of a sent order. */
  readonly message?: string | null | undefined
}

/**
 * purchasing.manage (and purchasing.send once the supplier holds the order): DRAFT, SENT, DECLINED or (B-W2a-52) CONFIRMED
 * → CANCELLED with a reason (factory-domain purchasing/orders/changes cancelOrderProblem). With the supplier's changes
 * waiting the buyer decides first; a received one is closed, never cancelled. When the supplier holds the order (it was
 * sent; B-W2a-52: also a draft of revision 2 or later, which replaces one it holds), in the same command: its live
 * confirm links stop working and the supplier is told by mail on the order's thread (when its contact has an e-mail).
 * The plan lines its lines bought are opened again (their run is the latest plan; an older run's lines never change), and
 * the answer names the demand the latest plan pegged on them (B-W2a-52 reach: work orders and sales orders that lose this
 * supply). The order's version is compared and set: a send (or the supplier's confirmation, B-W1-31) that committed
 * meanwhile makes this a 409, and the order read again says why it cannot be cancelled any more.
 */
export async function cancelOrder(caller: CommandCaller, orderId: string, body: CancelInput, idempotencyKey?: string): Promise<{ order: OrderDetail; supplierTold: boolean; reach: Reach }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.cancel', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const from = current.status as PurchaseOrderStatus
    const problem = cancelOrderProblem(from)
    if (problem) throw new InvalidStateError(problem)
    // After the version bump (the order's row), the lock a goods receipt takes: a receipt that names the order (also a
    // floor one, which cannot move the order's state) stops the cancel (./receiving.ts).
    await lockOrderReceiving(tools.tx, context.tenantId, current.id)
    const received = await receiptStopsCancel(tools.tx, current.id)
    if (received) throw new InvalidStateError(received)
    const told = supplierHolds(from, current.revision)
    if (told && !mayOn(context, PURCHASING_SEND, current)) throw new ForbiddenError('The supplier has this order: cancelling it tells the supplier, which needs the right to send purchase orders.')
    const reason = body.reason.trim()
    if (reason === '') throw new ValidationError('Say why the order is cancelled.', [{ path: 'body/reason', message: 'Required.' }])
    const { tx, now } = tools
    const reach = await reachOf(tx, current, (await endLineFactsOf(tx, current)).filter((line) => !line.cancelled && !line.closedShort))
    const revoked = told ? await revokeConfirmLinks(tools, current, context.actorId) : []
    const reopened = await reopenPlanLines(tools, current.id)
    await tx.purchaseOrder.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason }, select: { id: true } })
    let outboundId: string | null = null
    if (told) {
      const contact = current.contactId ? await tx.partyContact.findUnique({ where: { id: current.contactId }, select: { name: true, email: true, language: true, status: true } }) : null
      const party = await tx.party.findUniqueOrThrow({ where: { id: current.partyId }, select: { language: true } })
      if (contact?.email && contact.status === 'ACTIVE') {
        const language = supplierLanguageOf(contact.language, party.language)
        // A draft of a later revision cancels the revision the supplier holds: its number says which.
        const number = from === 'DRAFT' ? purchaseOrderDocumentNumber(current.number, current.revision - 1) : purchaseOrderDocumentNumber(current.number, current.revision)
        const mail = cancellationMail({ language, number, recipientName: contact.name, message: body.message ?? null })
        const sent = await sendEmail(tools, { record: { type: 'PurchaseOrder', id: current.id }, sender: await senderOf(tx, context), to: [contact.email], subject: mail.subject, body: mail.body, locale: language })
        outboundId = sent.outbound.id
      }
    }
    tools.audit({
      action: 'purchasing.cancel',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      reason,
      before: { status: from },
      after: { status: 'CANCELLED', revokedLinkIds: revoked, reopenedRequirementIds: reopened, outboundId, workOrders: reach.workOrders.map((row) => row.number), salesOrders: reach.salesOrders.map((row) => row.number) },
    })
    tools.emit({ type: 'purchase_order.cancelled', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, from, revokedLinkIds: revoked, outboundId } })
    return { ...(await detailInCommand(tools, current.id)), supplierTold: outboundId !== null, reach }
  })
}

/**
 * Inside a command on the order: the requirements of the latest plan its lines buy go back to OPEN (planning's hook), so
 * the plan shows them to buy again. Requirements of an older (superseded) run never change and keep naming the line.
 */
export async function reopenPlanLines(tools: CommandTools, orderId: string, lineIds?: readonly string[]): Promise<string[]> {
  const named = await tools.tx.materialRequirement.findMany({
    where: { purchaseOrderLine: { purchaseOrderId: orderId }, ...(lineIds ? { purchaseOrderLineId: { in: [...lineIds] } } : {}), decision: 'ORDERED', run: { status: 'DONE' } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  for (const requirement of named) await unorderRequirement(tools, { requirementId: requirement.id })
  return named.map((requirement) => requirement.id)
}
