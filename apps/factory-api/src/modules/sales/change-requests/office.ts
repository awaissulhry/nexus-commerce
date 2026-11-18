import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { AmendLineInput } from '@nexus/factory-domain/sales/amendments/amendments'
import { cancelFeeFor, type CancelFee } from '@nexus/factory-domain/sales/change-requests/fee'
import { amendmentLinesOf, answerProblems, ORDER_REQUEST_KIND_WORDS, rulesOf, type AskedCell, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
// B-PR-27a: a line in another colourway (a new line, the old one closed short).
import { colourInWorkWords, colourKeepsTotal, colourLinesOf } from '@nexus/factory-domain/sales/change-requests/rules'
// B-PR-27b: ship what is ready is accepted here too (the order ships as ready, the first part's date proposed to sales).
import { ACCEPT_DONE_WORDS, isProductionAccept } from '@nexus/factory-domain/production-brand/accept'
import { acceptProposals, proposeInCommand, type AcceptProposals } from '../../planning/promise-keep/repromise'
import { markMoney } from '@nexus/factory-domain/money/marked'
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
import { approveWaitingInCommand } from '../portal-ordering/address-check'
// B-PR-26: our counter-offer (the accept of an agreed one carries it out with the counter); a partly shipped order's cancel.
import { acceptedWithCounter, officeAnswersOf, type CounterState } from '@nexus/factory-domain/sales/change-requests/counter'
import type { RequestStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { agreedDateOf, answerableIn, counterOfRow, counterStateIn } from './counter'
import {
  readCounterStates,
  askedColourwayNames, // B-PR-27a
  addressesOf,
  dayOrNull,
  feeLinesOf,
  feeView,
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
 * B-W2b-F14: a cancel's fee (SalesSettings.cancelFeePct) on a waiting cancel's view and in the accept's answer (also on its
 * audit rows); shown only — the request has no column for it and no money moves.
 */

const LIST_MAX = 200

const blankToNull = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The office's views of these requests (one query per table, whatever the count). B-PR-26: production/brand-requests reads them too. */
export async function officeViews(db: Reader, context: ReturnType<typeof officeContextOf>, rows: readonly OfficeRequestRow[]) {
  if (rows.length === 0) return []
  const orderIds = [...new Set(rows.map((row) => row.orderId))]
  const orders = new Map((await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, customerRef: true, currency: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, seq: true, styleId: true, colourwayId: true, netAmount: true, closedShortQuantity: true } })
  const catalogue = await readCatalogue(db, lines)
  const styles = new Map<string, { code: string; name: string }>()
  const colourways = new Map<string, { code: string; name: string }>()
  for (const line of lines) {
    const entry = catalogue.get(line.id)
    if (entry?.style) styles.set(line.styleId, entry.style)
    if (entry?.colourway) colourways.set(line.colourwayId, entry.colourway)
  }
  const cells = await readCells(db, rows.map((row) => row.id))
  // B-PR-27a: the colourways the changes ask, by name.
  for (const [colourwayId, name] of await askedColourwayNames(db, cells.values())) colourways.set(colourwayId, name)
  const addresses = await addressesOf(db, rows.map((row) => row.shipToAddressId))
  const reasons = await reasonWordsOf(db, rows.flatMap((row) => (row.reasonCode ? [row.reasonCode] : [])))
  const people = [...new Set(rows.flatMap((row) => [row.createdById, row.answeredById]).filter((id): id is string => id !== null))]
  const names = new Map((people.length > 0 ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName]))
  const amendmentIds = rows.flatMap((row) => (row.amendmentId ? [row.amendmentId] : []))
  const amendments = new Map((amendmentIds.length > 0 ? await db.salesOrderAmendment.findMany({ where: { id: { in: amendmentIds } }, select: { id: true, revision: true } }) : []).map((row) => [row.id, row]))
  // B-PR-26: where each counter-offer stands (its approval's status).
  const counters = await readCounterStates(db, rows)
  // B-W2b-F14: the cancel fee in force per company, for the waiting cancels.
  const feeCompanies = [...new Set(rows.filter((row) => row.kind === 'CANCEL' && row.status === 'OPEN').map((row) => row.companyId))]
  const feePct = new Map<string, string | null>()
  for (const companyId of feeCompanies) feePct.set(companyId, (await readCutoffs(db, context.tenantId, companyId)).cancelFeePct)
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
      fee: feePct.has(row.companyId) ? { pct: feePct.get(row.companyId) ?? null, currency: order?.currency ?? 'EUR', lines: feeLinesOf(lines.filter((line) => line.orderId === row.orderId)) } : null,
      // B-PR-26
      counters,
      audience: 'office' as const,
    }
    // B-PR-26: an OPEN request, or a COUNTERED one the customer said yes to (accept) or whose counter lapsed (refuse).
    const answers = officeAnswersOf({ kind: row.kind as OrderRequestKind, status: row.status as RequestStatus }, counterStateOfView(row, counters))
    return {
      ...requestView(row, cells.get(row.id) ?? [], facts),
      companyId: row.companyId,
      party: { id: row.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
      askedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      answeredBy: row.answeredById ? (names.get(row.answeredById) ?? null) : null,
      amendment: row.amendmentId ? (amendments.get(row.amendmentId) ?? null) : null,
      // B-PR-23: Sales answers CHANGE and CANCEL; a production ask is read here and answered in Home › Approvals (B-PR-26).
      // B-PR-27b: and ship what is ready (SPLIT_SHIPMENT: orders.manage, accepted here).
      mayAnswer: (answers.accept || answers.refuse) && !isProductionAccept(row.kind) && mayOn(context, ORDERS_MANAGE, { companyId: row.companyId, partyId: row.partyId }),
    }
  })
}

/** B-PR-26: where a request's counter stands, from the states read with the views (null: never countered). */
const counterStateOfView = (row: Pick<OfficeRequestRow, 'counterApprovalId'>, counters: ReadonlyMap<string, CounterState>): CounterState | null =>
  row.counterApprovalId ? (counters.get(row.counterApprovalId) ?? 'LAPSED') : null

export interface ListQuery {
  readonly status: 'OPEN' | 'ACCEPTED' | 'REFUSED' | 'WITHDRAWN' | 'COUNTERED' | 'ALL'
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
      counts: { OPEN: countOf('OPEN'), ACCEPTED: countOf('ACCEPTED'), REFUSED: countOf('REFUSED'), WITHDRAWN: countOf('WITHDRAWN'), COUNTERED: countOf('COUNTERED') },
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
  // B-PR-26: a request the customer agreed with our counter-offer is carried out with the counter's date.
  const asked = row.status === 'COUNTERED' ? acceptedWithCounter({ requestedDate: dayOrNull(row.requestedDate) }, counterOfRow(row)).date : dayOrNull(row.requestedDate)
  const dateChanges = asked !== null && asked !== dayOrNull(order.requestedDate)
  if (!changed && !dateChanges) return null
  // B-PR-27a: a line asked in another colourway: a new line of its style in that colourway, the sizes asked, at the old line's
  // prices (the old line is closed short after the amendment: a line a request names is never removed).
  const byId = new Map(lines.map((line) => [line.id, line]))
  for (const colour of colourLinesOf(cells)) {
    const from = byId.get(colour.fromLineId)
    if (!from || colour.sizes.length === 0) continue
    const own = new Map(from.sizes.map((size) => [size.size, size.unitPrice === null ? null : size.unitPrice.toString()]))
    amendLines.push({ styleId: from.styleId, colourwayId: colour.colourwayId, unitPrice: from.unitPrice.toString(), sizes: colour.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: own.get(size.size) ?? null })), description: from.description, note: from.note })
  }
  const body: { version: number; reason: string; lines: AmendLineInput[]; requestedDate?: string } = { version: order.version, reason, lines: amendLines }
  if (dateChanges) body.requestedDate = asked
  return body
}

/**
 * B-PR-27a: why a line asked in another colourway cannot change now — a work order makes it (not cancelled): a colour change is
 * then cancel-and-remake, answered by hand (409 `request/COLOUR_IN_WORK`); null when every such line is free.
 */
async function colourInWorkProblem(db: Reader, cells: readonly AskedCell[], lines: readonly Pick<LineRecord, 'id' | 'seq'>[]): Promise<Issue | null> {
  const asked = colourLinesOf(cells).map((colour) => colour.fromLineId)
  if (asked.length === 0) return null
  const made = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: asked }, workOrder: { status: { not: 'CANCELLED' } } }, select: { salesOrderLineId: true, workOrder: { select: { number: true } } }, orderBy: { workOrderId: 'asc' } })
  const first = asked.find((lineId) => made.some((cell) => cell.salesOrderLineId === lineId))
  if (!first) return null
  const numbers = [...new Set(made.filter((cell) => cell.salesOrderLineId === first).map((cell) => cell.workOrder.number))]
  const words = colourInWorkWords(lines.find((line) => line.id === first)?.seq ?? 0, numbers)
  return { path: 'request/COLOUR_IN_WORK', message: words.en }
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
    // B-PR-26: what accepting does, while it may be accepted (OPEN, or the customer said yes to our counter-offer).
    const accepts = officeAnswersOf({ kind: row.kind as OrderRequestKind, status: row.status as RequestStatus }, await counterStateIn(client, row)).accept
    if (view!.mayAnswer && accepts) {
      const cells = (await readCells(client, [row.id])).get(row.id) ?? []
      const problems: Issue[] = []
      let amendment = null
      let cancel = null
      let closes = null
      if (row.kind === 'SPLIT_SHIPMENT') {
        // B-PR-27b: ship what is ready changes no line: the order ships as ready, the first part's date goes to sales as a re-promise.
      } else if (row.kind === 'CANCEL' && cells.length === 0 && order.status === 'PARTLY_SHIPPED') {
        // B-PR-26: a partly shipped order's "whole order" is what is still to ship: those lines are closed short.
        const plan = closeShortPlan(order.status, shortLinesOf(await readOrderFacts(client, order)), [])
        if (Array.isArray(plan)) problems.push(...plan)
        else closes = plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity }))
      } else if (row.kind === 'CANCEL' && cells.length === 0) {
        const impact = cancelImpact(await readCancelFacts(client, order, await readOrderFacts(client, order)))
        cancel = impactView(impact)
        problems.push(...impact.blocks.map((item) => ({ path: `cancel/${item.code}`, message: item.message })))
      } else if (row.kind === 'CANCEL') {
        const plan = closeShortPlan(order.status, shortLinesOf(await readOrderFacts(client, order)), cells.map((cell) => cell.orderLineId))
        if (Array.isArray(plan)) problems.push(...plan)
        else closes = plan.close.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity }))
      } else {
        // B-PR-27a: a line asked in another colourway changes only while no work order makes it.
        const inWork = await colourInWorkProblem(client, cells, lines)
        if (inWork) problems.push(inWork)
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

/** Inside the command: the request locked, OPEN (B-PR-26: or COUNTERED, as its counter lets this answer), at the version read. */
async function openRequestIn(tools: CommandTools, requestId: string, version: number, answer: 'ACCEPTED' | 'REFUSED'): Promise<OfficeRequestRow> {
  await lockRequest(tools.tx, requestId)
  const row = await tools.tx.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS })
  if (!row) throw new NotFoundError('Change request not found.')
  // B-PR-23: a production ask is answered in Home › Approvals (B-PR-26, B-PR-27a/b), never through Sales' accept or refuse.
  // B-PR-27b: but ship what is ready (SPLIT_SHIPMENT) is Sales' to accept (orders.manage).
  if (isProductionAccept(row.kind)) {
    const words = ORDER_REQUEST_KIND_WORDS[row.kind as OrderRequestKind]
    throw new DomainError('invalid_state', `This is a production ask ("${words.en}"): it is answered in Home › Approvals, not here.`, [{ path: 'request/PRODUCTION_ASK', message: 'A production ask is answered in Home › Approvals.' }])
  }
  // B-PR-26: a countered request is accepted once the customer said yes (carried out with the counter), refused once it lapsed.
  if (row.status === 'COUNTERED') return (await answerableIn(tools, requestId, version, answer)).row
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

/** B-PR-27b: what ship what is ready did, as the accept's contract sends it (fix-pr-4: its own arrays, not read-only ones). */
type SplitDone = {
  shipComplete: boolean
  proposals: { id: string; orderLineId: string; seq: number; sizes: { size: string | null; from: string | null; to: string }[] }[]
  skipped: AcceptProposals['skipped'][number][]
  words: { it: string; en: string }
}

export async function acceptRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const { order } = await caller.withClient((client) => officeRequest(client, context, requestId))
  assertMay(context, ORDERS_MANAGE, order, 'Change request')
  const problems = answerProblems('ACCEPTED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  // B-PR-27b: ship what is ready — the first part's date (asked, or our counter's) proposed to sales for its sizes promised later,
  // read before the command (planning/promise-keep acceptProposals). fix-pr-5 (lead decision): the accept is the decision, so the
  // proposal is made in its command under the accepter's orders.manage (asserted above), not planning.promise.manage (byAccept).
  const asked = await caller.withClient((client) => client.orderChangeRequest.findUnique({ where: { id: requestId }, select: OFFICE_REQUEST_COLUMNS }))
  const splitProposals: AcceptProposals | null =
    asked?.kind === 'SPLIT_SHIPMENT'
      ? await caller.withClient(async (client) => {
          const only = new Map<string, Set<string>>()
          for (const cell of (await readCells(client, [requestId])).get(requestId) ?? []) if (cell.size !== null) only.set(cell.orderLineId, (only.get(cell.orderLineId) ?? new Set<string>()).add(cell.size))
          return acceptProposals(client, context, { orderId: asked.orderId, date: agreedDateOf(asked), only, now: clock.now(), byAccept: true })
        })
      : null
  const { result } = await runCommand(caller, { name: 'orders.acceptChangeRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await openRequestIn(tools, requestId, body.version, 'ACCEPTED')
    const cells = (await readCells(tx, [requestId])).get(requestId) ?? []
    const reason = reasonOf(row, body.reason)
    let amendmentId: string | null = null
    let orderCancelled = false
    // B-PR-27b: what ship what is ready did.
    let split: SplitDone | null = null
    // B-W2b-F14: a cancel's fee as it stands now (before its lines close), kept on the audit rows and shown in the answer:
    // the request has no column for it, and no money moves.
    let cancelFee: CancelFee | null = null
    if (row.kind === 'CANCEL') {
      const orderLines = await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true, netAmount: true, closedShortQuantity: true } })
      cancelFee = cancelFeeFor(feeLinesOf(orderLines), cells.map((cell) => cell.orderLineId), (await readCutoffs(tx, context.tenantId, order.companyId)).cancelFeePct, order.currency)
    }
    const feeAudit = cancelFee ? { cancelFee: { pct: cancelFee.pct, currency: cancelFee.currency, lines: cancelFee.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, fee: markMoney('price', line.fee) })), totalFee: markMoney('price', cancelFee.totalFee) } } : {}
    // B-PR-26: a partly shipped order's "whole order" is what is still to ship: those lines are closed short (the order is not
    // cancelled: some of it shipped).
    const partlyShipped = row.kind === 'CANCEL' && cells.length === 0 && (await readOrder(tx, order.id))?.status === 'PARTLY_SHIPPED'
    if (row.kind === 'SPLIT_SHIPMENT') {
      // B-PR-27b: the order ships as ready (its row locked, its version moved), then the first part's date proposed to sales.
      await lockOrder(tx, order.id)
      const before = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { shipComplete: true } })
      if (before.shipComplete) {
        await tx.salesOrder.update({ where: { id: order.id }, data: { shipComplete: false, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'orders.shipAsReady', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { shipComplete: true }, after: { shipComplete: false, requestId }, reason })
      }
      const proposals: SplitDone['proposals'] = []
      for (const checked of splitProposals?.checked ?? []) {
        const made = await proposeInCommand(tools, checked)
        proposals.push({ id: made.proposalId, orderLineId: checked.line.id, seq: checked.line.seq, sizes: made.sizes.map((size) => ({ size: size.size, from: size.from, to: size.to })) })
      }
      const words = [ACCEPT_DONE_WORDS.shipsAsReady, ACCEPT_DONE_WORDS.repromised(proposals.length)]
      split = { shipComplete: false, proposals, skipped: [...(splitProposals?.skipped ?? [])], words: { it: words.map((entry) => entry.it).join(' '), en: words.map((entry) => entry.en).join(' ') } }
    } else if (partlyShipped) {
      await closeLinesInCommand(tools, context, order, { reason, reasonCode: row.reasonCode ?? undefined, lineIds: [] })
    } else if (row.kind === 'CANCEL' && cells.length === 0) {
      await cancelOrderInCommand(tools, context.tenantId, order, { reason })
      orderCancelled = true
    } else if (row.kind === 'CANCEL') {
      // Some lines: closed short with the request's CANCEL code (nothing more is made or shipped of them; never removed).
      await closeLinesInCommand(tools, context, order, { reason, reasonCode: row.reasonCode ?? undefined, lineIds: cells.map((cell) => cell.orderLineId) })
    } else {
      // The order and its lines as they are, read in this transaction: the amendment locks the order at this version.
      const fresh = (await readOrder(tx, order.id))!
      const freshLines = await readLines(tx, order.id)
      // B-PR-27a: a line asked in another colourway: only while no work order makes it (else answered by hand, nothing written).
      const inWork = await colourInWorkProblem(tx, cells, freshLines)
      if (inWork) throw new DomainError('invalid_state', inWork.message, [inWork])
      const amend = amendmentOf(row, cells, fresh, freshLines, reason)
      // B-PR-27a: the same pieces in another colourway at the old line's prices move no money: no re-acceptance (as a split).
      if (amend) amendmentId = (await amendInCommand(tools, context.tenantId, fresh, amend, colourKeepsTotal(cells) ? { reacceptance: false } : {})).amendmentId
      // B-PR-27a: then each old line closed short (a line a request names is never removed: W2a's close, with our reason).
      const coloured = colourLinesOf(cells).filter((colour) => colour.sizes.length > 0).map((colour) => colour.fromLineId)
      if (coloured.length > 0) await closeLinesInCommand(tools, context, (await readOrder(tx, order.id))!, { reason, lineIds: coloured })
      if (row.shipToAddressId) {
        if (!amend) await lockOrder(tx, order.id, fresh.version)
        // B-W2b-F13b: a delivery address the customer added for this request waits for our check: accepting approves it.
        await approveWaitingInCommand(tools, row.shipToAddressId, { type: 'OrderChangeRequest', id: requestId, number: null })
        await moveShipTo(tools, fresh, row.shipToAddressId, reason)
      }
      if (!amend && !row.shipToAddressId) throw new InvalidStateError('Nothing is left to change: the order already looks like this. Refuse the request with a word to the customer instead.')
    }
    await tx.orderChangeRequest.update({
      where: { id: requestId },
      data: { status: 'ACCEPTED', answer: blankToNull(body.answer), answeredAt: tools.now, answeredById: context.actorId, amendmentId, updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({ action: 'orders.acceptChangeRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: row.status }, after: { status: 'ACCEPTED', amendmentId, orderCancelled, answer: blankToNull(body.answer), ...feeAudit, /* B-PR-26 */ ...(row.status === 'COUNTERED' ? { withCounter: row.counterApprovalId } : {}), ...(partlyShipped ? { closedRest: true } : {}) } })
    tools.audit({ action: 'orders.changeRequestAccepted', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId, kind: row.kind, amendmentId, orderCancelled, ...feeAudit } })
    tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: order.id, partyId: row.partyId, kind: row.kind, answer: 'ACCEPTED', amendmentId, orderCancelled } })
    return { orderCancelled, cancelFee, split }
  }, { ...COMMAND_SETTINGS, clock })
  return { request: await viewAfter(caller, requestId), orderCancelled: result.orderCancelled, cancelFee: result.cancelFee ? feeView(result.cancelFee) : null, /* B-PR-27b */ split: result.split }
}

export async function refuseRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly answer: string }, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const { order } = await caller.withClient((client) => officeRequest(client, context, requestId))
  assertMay(context, ORDERS_MANAGE, order, 'Change request')
  const problems = answerProblems('REFUSED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  await runCommand(caller, { name: 'orders.refuseChangeRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const row = await openRequestIn(tools, requestId, body.version, 'REFUSED')
    const answer = body.answer.trim()
    await tools.tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'REFUSED', answer, answeredAt: tools.now, answeredById: context.actorId, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.refuseChangeRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: row.status }, after: { status: 'REFUSED', answer } })
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

