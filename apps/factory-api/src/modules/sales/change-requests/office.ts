import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { AmendLineInput } from '@nexus/factory-domain/sales/amendments/amendments'
import { amendmentLinesOf, answerProblems, rulesOf, type AskedCell } from '@nexus/factory-domain/sales/change-requests/rules'
import { cancelImpact, closeShortPlan } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { isIssueList } from '@nexus/factory-domain/sales/quotes/quotes'
import { shipToSnapshot } from '@nexus/factory-domain/sales/quotes/send'
import { COMMAND_SETTINGS, runCommand, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { actorOf } from '../../../core/context'
import { amendInCommand, diffView, planAmendment, type AmendBody } from '../orders/amend'
import { assertMay, mayOn, officeContextOf } from '../orders/access'
import { closeLinesInCommand, shortLinesOf } from '../orders/close-lines'
import { impactView, readCancelFacts } from '../orders/impact'
import { cancelOrderInCommand } from '../orders/moves'
import { lockOrder, readLines, readOrder, readOrderFacts, type LineRecord, type OrderRow } from '../orders/store'
import {
  addressesOf,
  dayOrNull,
  LIVE_EVENTS,
  lockRequest,
  OFFICE_REQUEST_COLUMNS,
  readCatalogue,
  readCells,
  readCuts,
  readCutoffs,
  reasonWordsOf,
  requestView,
  ruleLinesOf,
  type OfficeRequestRow,
  type Reader,
} from './store'

/**
 * The office's side (B-W2b-183; SAL-077, SAL-078; design home.approvals "one inbox for every request that needs my yes",
 * portal.customer.orders conn "Office: sales.orders › Changes (the change request lands there)"): orders.view over the
 * order's company and customer to read, orders.manage to answer (W2a's amendment and cancel permission).
 *
 *   list     GET  /sales/change-requests?status=OPEN|…|ALL&orderId&partyId&companyId (OPEN oldest first: the queue)
 *   record   GET  /sales/change-requests/:requestId: what was asked (cells before → asked, date, address, reason, their
 *            words), what the cut-off rules say of each line now, and for a reader who may answer an OPEN request what
 *            accepting does (W2a's amendment preview: lines and sizes old → new, money by grain, whether the customer must
 *            accept again; or the whole order's cancel impact; or why it cannot be applied, in words)
 *   accept   POST …/:requestId/accept {version, answer?, reason?}: ONE command — the request row locked (FOR UPDATE) and
 *            still OPEN at the version read; a change (or a partial cancel) through W2a's amendment (`amendInCommand`:
 *            prices again; a moved net total marks the order for the customer's re-acceptance, W2a's own rule, which
 *            B-W2b-184 asks for), at the order's version read in the same transaction (a parallel amendment is a 409, never
 *            an overwrite); a new delivery address written on the order (refused while a shipment is being prepared for
 *            the old one); a whole-order cancel by W2a's cancel (`cancelOrderInCommand`, its impact check under the locks);
 *            a cancel of some lines by W2a's close of lines (`closeLinesInCommand`, with the request's CANCEL code);
 *            then the request ACCEPTED naming the amendment, audit rows on the request and the order, and
 *            `order_change_request.answered` (the customer is told by e-mail through the portal notifications)
 *   refuse   POST …/:requestId/refuse {version, answer}: REFUSED with the words the customer reads
 * Who answered is the office's: the customer's reads never carry it.
 */

const LIST_MAX = 200

const blankToNull = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The office's views of these requests (one query per table, whatever the count). */
async function officeViews(db: Reader, context: ReturnType<typeof officeContextOf>, rows: readonly OfficeRequestRow[]) {
  if (rows.length === 0) return []
  const orderIds = [...new Set(rows.map((row) => row.orderId))]
  const orders = new Map((await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, customerRef: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, seq: true, styleId: true, colourwayId: true } })
  const catalogue = await readCatalogue(db, lines)
  const styles = new Map<string, { code: string; name: string }>()
  const colourways = new Map<string, { code: string; name: string }>()
  for (const line of lines) {
    const entry = catalogue.get(line.id)
    if (entry?.style) styles.set(line.styleId, entry.style)
    if (entry?.colourway) colourways.set(line.colourwayId, entry.colourway)
  }
  const cells = await readCells(db, rows.map((row) => row.id))
  const addresses = await addressesOf(db, rows.map((row) => row.shipToAddressId))
  const reasons = await reasonWordsOf(db, rows.flatMap((row) => (row.reasonCode ? [row.reasonCode] : [])))
  const people = [...new Set(rows.flatMap((row) => [row.createdById, row.answeredById]).filter((id): id is string => id !== null))]
  const names = new Map((people.length > 0 ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const amendmentIds = rows.flatMap((row) => (row.amendmentId ? [row.amendmentId] : []))
  const amendments = new Map((amendmentIds.length > 0 ? await db.salesOrderAmendment.findMany({ where: { id: { in: amendmentIds } }, select: { id: true, revision: true } }) : []).map((row) => [row.id, row]))
  return rows.map((row) => {
    const order = orders.get(row.orderId)
    const party = parties.get(row.partyId)
    const facts = {
      orderNumber: order?.number ?? '',
      customerRef: order?.customerRef ?? null,
      lines: new Map(lines.filter((line) => line.orderId === row.orderId).map((line) => [line.id, line])),
      names: { styles, colourways },
      addresses,
      reasons,
    }
    return {
      ...requestView(row, cells.get(row.id) ?? [], facts),
      companyId: row.companyId,
      party: { id: row.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
      askedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      answeredBy: row.answeredById ? (names.get(row.answeredById) ?? null) : null,
      amendment: row.amendmentId ? (amendments.get(row.amendmentId) ?? null) : null,
      mayAnswer: row.status === 'OPEN' && mayOn(context, ORDERS_MANAGE, { companyId: row.companyId, partyId: row.partyId }),
    }
  })
}

export interface ListQuery {
  readonly status: 'OPEN' | 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN' | 'ALL'
  readonly orderId?: string | undefined
  readonly partyId?: string | undefined
  readonly companyId?: string | undefined
  readonly limit: number
  readonly offset: number
}

export async function officeList(caller: CommandCaller, query: ListQuery, now: Date) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.OrderChangeRequestWhereInput
  const filters: Prisma.OrderChangeRequestWhereInput[] = [scope]
  if (query.orderId) filters.push({ orderId: query.orderId })
  if (query.partyId) filters.push({ partyId: query.partyId })
  if (query.companyId) filters.push({ companyId: query.companyId })
  const where: Prisma.OrderChangeRequestWhereInput = { AND: query.status === 'ALL' ? filters : [...filters, { status: query.status }] }
  return caller.withClient(async (client) => {
    const grouped = await client.orderChangeRequest.groupBy({ by: ['status'], where: { AND: filters }, _count: { _all: true } })
    const countOf = (status: string) => grouped.find((row) => row.status === status)?._count._all ?? 0
    const count = query.status === 'ALL' ? grouped.reduce((total, row) => total + row._count._all, 0) : countOf(query.status)
    // The queue waits oldest first; the answered ones newest first.
    const order = query.status === 'OPEN' ? 'asc' : 'desc'
    const rows = await client.orderChangeRequest.findMany({ where, select: OFFICE_REQUEST_COLUMNS, orderBy: [{ createdAt: order }, { id: order }], take: Math.min(query.limit, LIST_MAX), skip: query.offset })
    return {
      asOf: toUtcIso(now),
      items: await officeViews(client, context, rows),
      count,
      counts: { OPEN: countOf('OPEN'), ACCEPTED: countOf('ACCEPTED'), REFUSED: countOf('REFUSED'), WITHDRAWN: countOf('WITHDRAWN') },
      live: { events: [...LIVE_EVENTS] },
    }
  })
}

/** The request the office may see (else 404), with its order. */
async function officeRequest(db: Reader, context: ReturnType<typeof officeContextOf>, requestId: string): Promise<{ row: OfficeRequestRow; order: OrderRow }> {
  const row = await db.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS })
  const order = row ? await readOrder(db, row.orderId) : null
  if (!row || !order || !mayOn(context, ORDERS_VIEW, order)) throw new NotFoundError('Change request not found.')
  return { row, order }
}

/** The amendment's reason (kept with the order): the office's own, else the request said in a sentence. */
function reasonOf(row: OfficeRequestRow, given: string | undefined): string {
  if (given !== undefined && given.trim() !== '') return given.trim()
  const what = row.kind === 'CANCEL' ? `cancel request (${row.reasonCode})` : 'change request'
  return `The customer's ${what} of ${businessDate(row.createdAt)} from the portal${row.reason ? `: ${row.reason}` : ''}`.slice(0, MAX_REASON)
}

/**
 * The amendment an accepted change makes (W2a's body: every line named, the asked ones as asked), at the order's version
 * read with its lines; null when no line and no date change (an address alone, or nothing left to change).
 */
function amendmentOf(row: OfficeRequestRow, cells: readonly AskedCell[], order: OrderRow, lines: readonly LineRecord[], reason: string): AmendBody | null {
  const { lines: amendLines, changed } = amendmentLinesOf(cells, lines)
  const asked = dayOrNull(row.requestedDate)
  const dateChanges = asked !== null && asked !== dayOrNull(order.requestedDate)
  if (!changed && !dateChanges) return null
  const body: { version: number; reason: string; lines: AmendLineInput[]; requestedDate?: string } = { version: order.version, reason, lines: amendLines }
  if (dateChanges) body.requestedDate = asked
  return body
}

/** Why the delivery address asked cannot be written on the order now; null when it can. */
async function shipToProblem(db: Reader, order: Pick<OrderRow, 'id' | 'partyId'>, addressId: string): Promise<Issue | null> {
  const address = await db.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true, kinds: true } })
  if (!address || address.partyId !== order.partyId || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) {
    return { path: 'request/shipToAddressId/ADDRESS_GONE', message: 'The delivery address asked is no longer in use: refuse the request, or ask the customer for another address.' }
  }
  const busy = await db.shipment.findFirst({ where: { salesOrderId: order.id, status: { in: ['DRAFT', 'PACKED'] } }, select: { number: true }, orderBy: { createdAt: 'asc' } })
  if (busy) return { path: 'request/shipToAddressId/SHIPMENT_PREPARED', message: `Shipment ${busy.number} is being prepared for the order's address: change it there first, or refuse the request.` }
  return null
}

export async function officeRecord(caller: CommandCaller, requestId: string, now: Date) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const { row, order } = await officeRequest(client, context, requestId)
    const [view] = await officeViews(client, context, [row])
    const lines = await readLines(client, order.id)
    const cuts = await readCuts(client, lines.map((line) => line.id))
    const { cutoffs } = await readCutoffs(client, context.tenantId, order.companyId)
    const today = businessDate(now)
    // The request itself is not "another one waiting": the rules are read as if none waited.
    const rules = rulesOf({ status: order.status, promiseDate: dayOrNull(order.promiseDate), lines: ruleLinesOf(lines, cuts), openRequestDay: null }, cutoffs, today)
    let preview = null
    if (view!.mayAnswer) {
      const cells = (await readCells(client, [row.id])).get(row.id) ?? []
      const problems: Issue[] = []
      let amendment = null
      let cancel = null
      let closes = null
      if (row.kind === 'CANCEL' && cells.length === 0) {
        const impact = cancelImpact(await readCancelFacts(client, order, await readOrderFacts(client, order)))
        cancel = impactView(impact)
        problems.push(...impact.blocks.map((item) => ({ path: `cancel/${item.code}`, message: item.message })))
      } else if (row.kind === 'CANCEL') {
        const plan = closeShortPlan(order.status, shortLinesOf(await readOrderFacts(client, order)), cells.map((cell) => cell.orderLineId))
        if (Array.isArray(plan)) problems.push(...plan)
        else closes = plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity }))
      } else {
        const body = amendmentOf(row, cells, order, lines, reasonOf(row, undefined))
        if (body) {
          const plan = await planAmendment(client, order, order.status, await readOrderFacts(client, order), body, now)
          if (isIssueList(plan)) problems.push(...plan)
          else amendment = diffView(plan.diff)
        }
        if (row.shipToAddressId) {
          const problem = await shipToProblem(client, order, row.shipToAddressId)
          if (problem) problems.push(problem)
        }
        if (!body && !row.shipToAddressId) problems.push({ path: 'request', message: 'Nothing is left to change: the order already looks like this.' })
      }
      preview = { ok: problems.length === 0, problems, amendment, cancel, closes }
    }
    return {
      asOf: toUtcIso(now),
      request: view!,
      rulesNow: rules.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, change: line.change, cancel: line.cancel })),
      preview,
      live: { events: [...LIVE_EVENTS] },
    }
  })
}

/** Inside the command: the request locked, OPEN, at the version read. */
async function openRequestIn(tools: CommandTools, requestId: string, version: number): Promise<OfficeRequestRow> {
  await lockRequest(tools.tx, requestId)
  const row = await tools.tx.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS })
  if (!row) throw new NotFoundError('Change request not found.')
  if (row.status !== 'OPEN') throw new DomainError('invalid_state', row.status === 'WITHDRAWN' ? 'The customer withdrew this request.' : 'This request is already answered.', [{ path: `request/${row.status}`, message: `The request is ${row.status}.` }])
  if (row.version !== version) throw new StaleVersionError('OrderChangeRequest', requestId, row.version, version)
  return row
}

/** The new delivery address written on the order (its row already locked by the caller). */
async function moveShipTo(tools: CommandTools, order: OrderRow, addressId: string, reason: string): Promise<void> {
  const { tx, now } = tools
  const problem = await shipToProblem(tx, order, addressId)
  if (problem) throw new DomainError('invalid_state', problem.message, [problem])
  const address = await tx.partyAddress.findUniqueOrThrow({ where: { id: addressId }, select: { name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true } })
  const before = (await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { shipTo: true } })).shipTo
  const after = shipToSnapshot(address)
  await tx.salesOrder.update({ where: { id: order.id }, data: { shipTo: after as unknown as Prisma.InputJsonValue, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'orders.changeShipTo', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { shipTo: before }, after: { shipTo: after, addressId }, reason })
}

export interface AcceptBody {
  readonly version: number
  readonly answer?: string | null | undefined
  readonly reason?: string | undefined
}

export async function acceptRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const { order } = await caller.withClient((client) => officeRequest(client, context, requestId))
  assertMay(context, ORDERS_MANAGE, order, 'Change request')
  const problems = answerProblems('ACCEPTED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await runCommand(caller, { name: 'orders.acceptChangeRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await openRequestIn(tools, requestId, body.version)
    const cells = (await readCells(tx, [requestId])).get(requestId) ?? []
    const reason = reasonOf(row, body.reason)
    let amendmentId: string | null = null
    let orderCancelled = false
    if (row.kind === 'CANCEL' && cells.length === 0) {
      await cancelOrderInCommand(tools, context.tenantId, order, { reason })
      orderCancelled = true
    } else if (row.kind === 'CANCEL') {
      // Some lines: closed short with the request's CANCEL code (nothing more is made or shipped of them; never removed).
      await closeLinesInCommand(tools, context, order, { reason, reasonCode: row.reasonCode ?? undefined, lineIds: cells.map((cell) => cell.orderLineId) })
    } else {
      // The order and its lines as they are, read in this transaction: the amendment locks the order at this version.
      const fresh = (await readOrder(tx, order.id))!
      const amend = amendmentOf(row, cells, fresh, await readLines(tx, order.id), reason)
      if (amend) amendmentId = (await amendInCommand(tools, context.tenantId, fresh, amend)).amendmentId
      if (row.shipToAddressId) {
        if (!amend) await lockOrder(tx, order.id, fresh.version)
        await moveShipTo(tools, fresh, row.shipToAddressId, reason)
      }
      if (!amend && !row.shipToAddressId) throw new InvalidStateError('Nothing is left to change: the order already looks like this. Refuse the request with a word to the customer instead.')
    }
    await tx.orderChangeRequest.update({
      where: { id: requestId },
      data: { status: 'ACCEPTED', answer: blankToNull(body.answer), answeredAt: tools.now, answeredById: context.actorId, amendmentId, updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({ action: 'orders.acceptChangeRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: 'OPEN' }, after: { status: 'ACCEPTED', amendmentId, orderCancelled, answer: blankToNull(body.answer) } })
    tools.audit({ action: 'orders.changeRequestAccepted', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId, kind: row.kind, amendmentId, orderCancelled } })
    tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: order.id, partyId: row.partyId, kind: row.kind, answer: 'ACCEPTED', amendmentId, orderCancelled } })
    return { orderCancelled }
  }, { ...COMMAND_SETTINGS, clock })
  return { request: await viewAfter(caller, requestId), orderCancelled: result.orderCancelled }
}

export async function refuseRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly answer: string }, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const { order } = await caller.withClient((client) => officeRequest(client, context, requestId))
  assertMay(context, ORDERS_MANAGE, order, 'Change request')
  const problems = answerProblems('REFUSED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await runCommand(caller, { name: 'orders.refuseChangeRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const row = await openRequestIn(tools, requestId, body.version)
    const answer = body.answer.trim()
    await tools.tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'REFUSED', answer, answeredAt: tools.now, answeredById: context.actorId, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.refuseChangeRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: 'OPEN' }, after: { status: 'REFUSED', answer } })
    tools.audit({ action: 'orders.changeRequestRefused', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId, kind: row.kind } })
    tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: order.id, partyId: row.partyId, kind: row.kind, answer: 'REFUSED', amendmentId: null, orderCancelled: false } })
    return null
  }, { ...COMMAND_SETTINGS, clock })
  return { request: await viewAfter(caller, requestId) }
}

async function viewAfter(caller: CommandCaller, requestId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const { row } = await officeRequest(client, context, requestId)
    return (await officeViews(client, context, [row]))[0]!
  })
}

