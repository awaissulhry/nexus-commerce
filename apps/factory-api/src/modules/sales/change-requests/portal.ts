import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  cancelCellsOf,
  cancelProblems,
  changeCellsOf,
  changeProblems,
  NO_WITHDRAWAL_WORDS,
  rulesOf,
  VERDICT_CODES,
  type AskedCell,
  type RequestKind,
  type RuleOrder,
} from '@nexus/factory-domain/sales/change-requests/rules'
import type { CommandTools } from '../../../core/command'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { partnerOrder, portalReader, type PortalReader } from '../portal-orders/access'
import { readLines, type PortalLine, type PortalOrderRow } from '../portal-orders/store'
import {
  addressesOf,
  addressLabel,
  asDay,
  dayOrNull,
  LIVE_EVENTS,
  lockRequest,
  readCancelReasons,
  readCatalogue,
  readCells,
  readCuts,
  readCutoffs,
  readShipTos,
  reasonWordsOf,
  REQUEST_COLUMNS,
  requestView,
  ruleLinesOf,
  type AddressRow,
  type CancelReason,
  type LineCatalogue,
  type RequestRow,
} from './store'

/**
 * The customer's side (B-W2b-183; SAL-077, SAL-078; design portal.customer.orders "Ask for a change", "Ask to cancel"): a
 * portal session of the order's party, in the portal's company.
 *
 *   rules     GET  /portal/sales-orders/:orderId/change-requests/rules (portal.salesOrders.ask): what both pop-ups show
 *             BEFORE the click — per line and size what may change, per line whether it may be cancelled and why not in
 *             words ("Not possible: the leather was cut on 12 Oct", "Not possible: in production", "within 14 days of the
 *             delivery date"), the reasons, their delivery addresses, the no-withdrawal words of SAL-304, the open request
 *   ask       POST …/change-requests (portal.salesOrders.ask): the same rules again at the click, refused in words (409 with
 *             the verdict's code in the path: `body/<CODE>`, `body/cells/<i>/<CODE>`), then ONE command in the customer's
 *             own scope: the order's requests serialised (an advisory lock per order: the partner role cannot lock the
 *             order's row), one OPEN request per order, the request OPEN with its cells (the pieces before read from the
 *             order now), an audit row on the request and one on the order (its timeline shows it to the office), and
 *             `order_change_request.asked` (Home › Approvals reads it)
 *   list      GET  …/change-requests (portal.salesOrders.view): the order's requests, newest first, with the office's words
 *             (never who answered)
 *   withdraw  POST …/change-requests/:requestId/withdraw (portal.salesOrders.ask): OPEN → WITHDRAWN, at the version read
 * The cut-off settings, the cuts, the reasons and the catalogue are read in the tenant's scope as the person, after the
 * partner read found the order (none of them is partner-readable). An office preview never writes (its grants hold no
 * write permission; refused here too).
 */

/** Everything the rules need, read for one order of the customer. */
interface AskFacts {
  readonly order: PortalOrderRow
  readonly lines: PortalLine[]
  readonly rule: RuleOrder
  readonly cutoffs: Awaited<ReturnType<typeof readCutoffs>>['cutoffs']
  readonly catalogue: Map<string, LineCatalogue>
  readonly reasons: CancelReason[]
  readonly addresses: AddressRow[]
  readonly openRequestId: string | null
  readonly today: BusinessDate
}

async function askFacts(request: FastifyRequest, reader: PortalReader, orderId: string, now: Date): Promise<AskFacts> {
  const order = await partnerOrder(request, reader, orderId)
  const lines = await request.withClient((client) => readLines(client, [order.id]))
  const open = await request.withClient((client) => client.orderChangeRequest.findFirst({ where: { orderId: order.id, status: 'OPEN' }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' } }))
  const addresses = await request.withClient((client) => readShipTos(client, order.partyId))
  const tenant = await reader.inTenant(async (client) => ({
    cutoffs: (await readCutoffs(client, reader.session.tenantId, order.companyId)).cutoffs,
    cuts: await readCuts(client, lines.map((line) => line.id)),
    catalogue: await readCatalogue(client, lines),
    reasons: await readCancelReasons(client),
  }))
  const rule: RuleOrder = {
    status: order.status,
    promiseDate: dayOrNull(order.promiseDate),
    lines: ruleLinesOf(lines, tenant.cuts),
    openRequestDay: open ? businessDate(open.createdAt) : null,
  }
  return { order, lines, rule, cutoffs: tenant.cutoffs, catalogue: tenant.catalogue, reasons: tenant.reasons, addresses, openRequestId: open?.id ?? null, today: businessDate(now) }
}

export async function portalRules(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const facts = await askFacts(request, reader, orderId, now)
  const rules = rulesOf(facts.rule, facts.cutoffs, facts.today)
  const verdicts = new Map(rules.lines.map((entry) => [entry.lineId, entry]))
  return {
    asOf: toUtcIso(now),
    order: {
      id: facts.order.id,
      number: facts.order.number,
      customerRef: facts.order.customerRef,
      status: facts.order.status,
      requestedDate: dayOrNull(facts.order.requestedDate),
      promiseDate: dayOrNull(facts.order.promiseDate),
      version: facts.order.version,
    },
    change: rules.change,
    cancel: rules.cancel,
    lines: facts.lines.map((line) => {
      const catalogue = facts.catalogue.get(line.id)
      const ordered = new Map(line.sizes.map((size) => [size.size, size.quantity]))
      // The style's range in its order (a size it no longer offers stays when ordered), then any ordered size off the range.
      const range = catalogue?.range ?? []
      const sizes = [...range, ...line.sizes.map((size) => size.size).filter((size) => !range.includes(size))]
        .filter((size) => ordered.has(size) || (catalogue?.offered.has(size) ?? false))
        .map((size) => ({ size, quantity: ordered.get(size) ?? 0, offered: ordered.has(size) || (catalogue?.offered.has(size) ?? false) }))
      const verdict = verdicts.get(line.id)!
      return { lineId: line.id, seq: line.seq, kind: line.kind, style: catalogue?.style ?? null, colourway: catalogue?.colourway ?? null, sizes, change: verdict.change, cancel: verdict.cancel }
    }),
    reasons: facts.reasons,
    addresses: facts.addresses.map((row) => ({ id: row.id, label: addressLabel(row) })),
    noWithdrawal: facts.order.noWithdrawal ? NO_WITHDRAWAL_WORDS : null,
    openRequestId: facts.openRequestId,
    live: { events: [...LIVE_EVENTS] },
  }
}

export interface AskBody {
  readonly kind: RequestKind
  readonly cells?: readonly { readonly lineId: string; readonly size: string; readonly quantity: number }[] | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly lineIds?: readonly string[] | undefined
  readonly reasonCode?: string | undefined
  readonly note?: string | null | undefined
}

const VERDICT_PATH = new RegExp(`/(${VERDICT_CODES.filter((code) => code !== 'FREE').join('|')})$`)

/** A refusal by the cut-off rules is a 409 (the order's state says no); anything else a 400. */
function refused(issues: Issue[]): DomainError {
  const rule = issues.find((issue) => VERDICT_PATH.test(issue.path))
  if (rule) return new DomainError('invalid_state', rule.message, issues)
  return new ValidationError(issues.length === 1 ? issues[0]!.message : 'This request cannot be sent like this.', issues)
}

const blankToNull = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The fields of the other kind are refused in words (one body for both pop-ups). */
function shapeProblems(body: AskBody): Issue[] {
  const issues: Issue[] = []
  if (body.kind === 'CHANGE') {
    if (body.lineIds !== undefined) issues.push({ path: 'body/lineIds', message: 'A change names sizes (cells), not lines.' })
    if (body.reasonCode !== undefined) issues.push({ path: 'body/reasonCode', message: 'A change has no cancel reason.' })
  } else {
    if ((body.cells ?? []).length > 0) issues.push({ path: 'body/cells', message: 'A cancel names lines, not sizes.' })
    if ((body.requestedDate ?? null) !== null || (body.shipToAddressId ?? null) !== null) issues.push({ path: 'body', message: 'A cancel asks no date and no address.' })
    if (body.reasonCode === undefined) issues.push({ path: 'body/reasonCode', message: 'Pick a reason.' })
  }
  return issues
}

/** The cells asked, once the cut-off rules let them through (else the refusal in words). */
function askedCells(body: AskBody, facts: AskFacts): AskedCell[] {
  if (body.kind === 'CHANGE') {
    const ask = { cells: body.cells ?? [], requestedDate: body.requestedDate ?? null, shipToAddressId: body.shipToAddressId ?? null, note: body.note }
    const offered = new Map([...facts.catalogue.entries()].map(([lineId, entry]) => [lineId, entry.offered]))
    const addressOk = ask.shipToAddressId === null ? null : facts.addresses.some((row) => row.id === ask.shipToAddressId)
    const problems = changeProblems(ask, { order: facts.rule, cutoffs: facts.cutoffs, today: facts.today, requestedDate: dayOrNull(facts.order.requestedDate), offered, addressOk })
    if (problems.length > 0) throw refused(problems)
    return changeCellsOf(ask, facts.rule)
  }
  const ask = { lineIds: body.lineIds, reasonCode: body.reasonCode!, note: body.note }
  const reasons = new Map(facts.reasons.map((reason) => [reason.code, { needsNote: reason.needsNote }]))
  const problems = cancelProblems(ask, { order: facts.rule, cutoffs: facts.cutoffs, today: facts.today, reasons })
  if (problems.length > 0) throw refused(problems)
  return cancelCellsOf(ask, facts.rule)
}

export async function askRequest(app: FastifyInstance, request: FastifyRequest, orderId: string, body: AskBody, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  const shape = shapeProblems(body)
  if (shape.length > 0) throw refused(shape)
  const session = reader.session
  const requestId = newId()
  // The rules are read and checked inside the command's work: a repeated Idempotency-Key answers from its receipt
  // before any of it runs (the request it made would otherwise be "another one waiting").
  const { result } = await commandOn(app, request, { name: 'portal.askOrderChange', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const facts = await askFacts(request, reader, orderId, tools.now)
    await askInCommand(tools, { requestId, order: facts.order, body, cells: askedCells(body, facts), partnerUserId: session.userId })
    return { requestId }
  })
  const order = await partnerOrder(request, reader, orderId)
  return { request: await partnerRequestView(request, reader, order, result.requestId) }
}

/** The request written (the customer's scope): serialised per order, one OPEN at a time, the order still askable. */
async function askInCommand(tools: CommandTools, input: { readonly requestId: string; readonly order: PortalOrderRow; readonly body: AskBody; readonly cells: readonly AskedCell[]; readonly partnerUserId: string }) {
  const { tx, now } = tools
  const { order, body, cells } = input
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`factory.order-change-request|${order.id}`}::text))`
  const open = await tx.orderChangeRequest.findFirst({ where: { orderId: order.id, status: 'OPEN' }, select: { id: true, createdAt: true } })
  if (open) throw new DomainError('invalid_state', 'A request on this order waits for our answer: withdraw it first, or wait for the answer.', [{ path: 'body/OPEN_REQUEST', message: 'A request waits.' }])
  const current = await tx.salesOrder.findUnique({ where: { id: order.id }, select: { status: true } })
  if (!current || !['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(current.status)) throw new DomainError('invalid_state', 'The order can no longer be changed or cancelled from the portal.', [{ path: 'body/NOT_ASKABLE', message: 'The order moved on.' }])
  await tx.orderChangeRequest.create({
    data: {
      id: input.requestId,
      companyId: order.companyId,
      partyId: order.partyId,
      orderId: order.id,
      kind: body.kind,
      reasonCode: body.kind === 'CANCEL' ? body.reasonCode! : null,
      reason: blankToNull(body.note),
      requestedDate: body.kind === 'CHANGE' && body.requestedDate ? asDay(body.requestedDate) : null,
      shipToAddressId: body.kind === 'CHANGE' ? (body.shipToAddressId ?? null) : null,
      createdAt: now,
      updatedAt: now,
      createdById: input.partnerUserId,
    },
    select: { id: true },
  })
  if (cells.length > 0) {
    await tx.orderChangeRequestLine.createMany({
      data: cells.map((cell) => ({ id: newId(), partyId: order.partyId, requestId: input.requestId, orderLineId: cell.orderLineId, size: cell.size, quantityBefore: cell.quantityBefore, quantity: cell.quantity, createdAt: now, createdById: input.partnerUserId })),
    })
  }
  const whole = body.kind === 'CANCEL' && cells.length === 0
  const asked = { kind: body.kind, cells: cells.map((cell) => ({ lineId: cell.orderLineId, size: cell.size, before: cell.quantityBefore, asked: cell.quantity })), wholeOrder: whole, requestedDate: body.kind === 'CHANGE' ? (body.requestedDate ?? null) : null, shipToAddressId: body.kind === 'CHANGE' ? (body.shipToAddressId ?? null) : null, reasonCode: body.kind === 'CANCEL' ? body.reasonCode! : null }
  tools.audit({ action: 'portal.askOrderChange', recordType: 'OrderChangeRequest', recordId: input.requestId, companyId: order.companyId, after: { orderId: order.id, status: 'OPEN', ...asked } })
  // The order's timeline (its Activity) shows what the customer asked.
  tools.audit({ action: 'orders.changeRequestAsked', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId: input.requestId, ...asked } })
  tools.emit({ type: 'order_change_request.asked', subject: input.requestId, companyId: order.companyId, payload: { requestId: input.requestId, orderId: order.id, partyId: order.partyId, kind: body.kind, lines: new Set(cells.map((cell) => cell.orderLineId)).size, wholeOrder: whole } })
}

/** The facts every view of the order's requests needs (the names in the tenant's scope). */
async function viewFacts(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow, rows: readonly RequestRow[]) {
  const lines = await request.withClient((client) => readLines(client, [order.id]))
  const cells = await request.withClient((client) => readCells(client, rows.map((row) => row.id)))
  const addresses = await request.withClient((client) => addressesOf(client, rows.map((row) => row.shipToAddressId)))
  const tenant = await reader.inTenant(async (client) => ({
    catalogue: await readCatalogue(client, lines),
    reasons: await reasonWordsOf(client, rows.flatMap((row) => (row.reasonCode ? [row.reasonCode] : []))),
  }))
  const styles = new Map<string, { code: string; name: string }>()
  const colourways = new Map<string, { code: string; name: string }>()
  for (const line of lines) {
    const entry = tenant.catalogue.get(line.id)
    if (entry?.style) styles.set(line.styleId, entry.style)
    if (entry?.colourway) colourways.set(line.colourwayId, entry.colourway)
  }
  return {
    cells,
    facts: { orderNumber: order.number, customerRef: order.customerRef, lines: new Map(lines.map((line) => [line.id, line])), names: { styles, colourways }, addresses, reasons: tenant.reasons },
  }
}

async function partnerRequestView(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow, requestId: string) {
  const row = await request.withClient((client) => client.orderChangeRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS }))
  if (!row || row.orderId !== order.id) throw new NotFoundError('Request not found.')
  const { cells, facts } = await viewFacts(request, reader, order, [row])
  return { ...requestView(row, cells.get(row.id) ?? [], facts), mine: row.createdById === reader.session.userId }
}

export async function partnerList(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const rows = await request.withClient((client) => client.orderChangeRequest.findMany({ where: { orderId: order.id }, select: REQUEST_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }))
  const { cells, facts } = await viewFacts(request, reader, order, rows)
  return {
    asOf: toUtcIso(now),
    items: rows.map((row) => ({ ...requestView(row, cells.get(row.id) ?? [], facts), mine: row.createdById === reader.session.userId })),
    live: { events: [...LIVE_EVENTS] },
  }
}

export async function withdrawRequest(app: FastifyInstance, request: FastifyRequest, orderId: string, requestId: string, version: number, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview reads only.')
  const order = await partnerOrder(request, reader, orderId)
  await commandOn(app, request, { name: 'portal.withdrawOrderChange', idempotencyKey, input: { orderId, requestId, version } }, async (tools) => {
    const { tx, now } = tools
    await lockRequest(tx, requestId)
    const row = await tx.orderChangeRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS })
    if (!row || row.orderId !== order.id) throw new NotFoundError('Request not found.')
    if (row.status !== 'OPEN') throw new InvalidStateError(row.status === 'WITHDRAWN' ? 'This request was already withdrawn.' : 'We already answered this request: it can no longer be withdrawn.')
    if (row.version !== version) throw new ConflictError(`This request changed since you read it (now version ${row.version}). Read it again.`)
    await tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'portal.withdrawOrderChange', recordType: 'OrderChangeRequest', recordId: requestId, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'WITHDRAWN', withdrawnAt: toUtcIso(now) } })
    tools.audit({ action: 'orders.changeRequestWithdrawn', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { requestId, kind: row.kind } })
    tools.emit({ type: 'order_change_request.withdrawn', subject: requestId, companyId: order.companyId, payload: { requestId, orderId: order.id, partyId: order.partyId, kind: row.kind } })
    return null
  })
  return { request: await partnerRequestView(request, reader, order, requestId) }
}
