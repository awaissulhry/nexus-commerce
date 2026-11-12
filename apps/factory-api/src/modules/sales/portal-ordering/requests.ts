import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { approvalView } from '@nexus/factory-domain/parties/address-approval'
import { withdrawProblem } from '@nexus/factory-domain/sales/portal-ordering/office'
import { reorderPlan, type PastLine } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import { isGoodsLine } from '@nexus/factory-domain/sales/quotes/quotes'
import {
  draftTotals,
  headerProblems,
  heldWords,
  lineAmount,
  lineProblems,
  lineShapeProblems,
  ORDERING_LIMITS,
  piecesOfSizes,
  priceShown,
  REQUEST_NOTICE,
  REQUEST_STATUS_WORDS,
  type LineInput,
  type Problem,
  type RequestSource,
  type RequestStatus,
  type SizeAsk,
} from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { addWorkingDaysFor } from '../../../platform/calendars/service'
import { portalOf } from '../../../platform/auth/portal/service'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { portalReader, type PortalReader } from '../portal-orders/access'
import { factsOf, readCatalogue, type CustomerCatalogue } from './catalogue'
import { dayText, dayValue, iso, lockRequest, priceOrNull, readLines, readRequest, REQUEST_COLUMNS, type LineRow, type Reader, type RequestRow } from './store'

/**
 * The customer's order requests in the portal (B-W2b-190; SAL-074 "portal orders arrive as requests", the draft of
 * SAL-071/072/073; design portal.customer.neworder). Partner sessions with portal.orderRequests.manage, inside their party
 * (row-level security) and the portal's company.
 *
 *   GET    /portal/order-requests                    the party's requests (drafts first, then the newest)
 *   POST   /portal/order-requests                    a new DRAFT (how it starts: PICKER, REORDER, UPLOAD; the header)
 *   GET    /portal/order-requests/:id                the request: header, lines with their sizes, prices shown and now,
 *                                                    a reorder line's differences from the order it came from, the
 *                                                    problems that hold the send, totals, the delivery addresses
 *   PATCH  /portal/order-requests/:id                the header of a DRAFT (autosave: their PO, ship-to, date, note)
 *   POST   /portal/order-requests/:id/lines          styles picked (one line per style and colour, its size run)
 *   PUT    /portal/order-requests/:id/lines/:lineId  a line's sizes, note or colour
 *   DELETE /portal/order-requests/:id/lines/:lineId  a line out
 *   POST   /portal/order-requests/:id/prices         take today's prices on every line (after "Prices changed")
 *   DELETE /portal/order-requests/:id                discard the draft (it has no number)
 *   POST   /portal/order-requests/:id/send           the request goes to the office: numbered from the company's
 *                                                    PORTAL_REQUEST series in the tenant's office scope as the person
 *                                                    (the partner role has no numbering grant), SENT, Home › Approvals
 *   POST   /portal/order-requests/:id/withdraw       a SENT request back, before the office decided
 *
 * Every line is checked against the customer's catalogue today before it is written (./catalogue: the tenant's scope as
 * the person); a draft's line that the catalogue no longer holds as it was is named as a problem when the draft is read,
 * and the send is held until none is left. The price a line shows is the customer's list price the day it was added
 * (price grain only); a change since is a problem the customer accepts with /prices before sending: what is sent is what
 * was shown, and the office prices again when it makes the order.
 */

const MAX_DRAFTS = 20
const LIST_MAX = 200

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const today = (app: FastifyInstance): BusinessDate => businessDate(appClock(app).now())

// ---- reads -----------------------------------------------------------------------------------------------------------

/** The request of the party in the portal's company, read in the partner scope, or 404. */
export async function ownRequest(request: FastifyRequest, reader: PortalReader, requestId: string): Promise<RequestRow> {
  const row = await request.withClient((client) => readRequest(client, requestId))
  if (!row || row.companyId !== reader.session.company.id) throw new NotFoundError('Order request not found.')
  return row
}

export interface SourceFacts {
  readonly orderLineId: string
  readonly orderId: string
  readonly orderNumber: string
  readonly customerRef: string | null
  readonly orderDate: string
  readonly line: PastLine
}

/** The order lines reorder lines came from (the partner's own: price grain, never cost), with their revision number. */
async function sourcesOf(request: FastifyRequest, reader: PortalReader, lines: readonly LineRow[]): Promise<Map<string, SourceFacts>> {
  const ids = [...new Set(lines.flatMap((line) => (line.sourceOrderLineId ? [line.sourceOrderLineId] : [])))]
  if (ids.length === 0) return new Map()
  const rows = await request.withClient((client) =>
    client.salesOrderLine.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, unitPrice: true, styleRevisionId: true, order: { select: { id: true, number: true, customerRef: true, orderDate: true } }, sizes: { select: { size: true, quantity: true } } },
    }),
  )
  const revisionIds = [...new Set(rows.flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])))]
  const revisions = revisionIds.length === 0 ? new Map<string, number>() : await reader.inTenant(async (db) => new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision])))
  // W2b-5 (B-W2b-280): a fee line is never a reorder's source.
  return new Map(
    rows.filter(isGoodsLine).map((row) => [
      row.id,
      {
        orderLineId: row.id,
        orderId: row.order.id,
        orderNumber: row.order.number,
        customerRef: row.order.customerRef,
        orderDate: dayText(row.order.orderDate)!,
        line: {
          kind: row.kind,
          unitPrice: row.unitPrice.toString(),
          revision: row.styleRevisionId ? (revisions.get(row.styleRevisionId) ?? null) : null,
          sizes: row.sizes.filter((size) => size.size !== null && size.quantity > 0).map((size) => ({ size: size.size!, quantity: size.quantity })),
        },
      },
    ]),
  )
}

/** The party's delivery addresses (partner scope): every SHIP_TO one, active first. */
export async function shipToAddresses(request: FastifyRequest) {
  const rows = await request.withClient((client) =>
    client.partyAddress.findMany({
      where: { kinds: { has: 'SHIP_TO' } },
      select: { id: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true, deliveryNotes: true, isDefaultShipTo: true, status: true, approvalStatus: true, refuseReason: true, version: true },
      orderBy: [{ status: 'asc' }, { isDefaultShipTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  return rows
}

const sizesOf = (line: LineRow): SizeAsk[] => line.sizes.map((row) => ({ size: row.size, quantity: row.quantity }))

/** One line as the customer sees it. */
function lineView(line: LineRow, catalogue: CustomerCatalogue, source: SourceFacts | null, seesPrices: boolean) {
  const facts = factsOf(catalogue, line.styleId, line.colourwayId)
  const style = catalogue.styles.get(line.styleId)
  const code = catalogue.codes.get(line.styleId)
  const colourway = catalogue.colourways.get(line.colourwayId)
  const sizes = sizesOf(line)
  const shown = priceOrNull(line.unitPriceShown)
  const pieces = piecesOfSizes(sizes)
  const range = style?.range ?? []
  const ordered = [...sizes].sort((a, b) => (range.indexOf(a.size) === -1 ? 999 : range.indexOf(a.size)) - (range.indexOf(b.size) === -1 ? 999 : range.indexOf(b.size)))
  return {
    id: line.id,
    seq: line.seq,
    version: line.version,
    style: { id: line.styleId, code: code?.code ?? '', name: code?.name ?? '' },
    colourway: { id: line.colourwayId, code: colourway?.code ?? '', name: colourway?.name ?? '' },
    sizes: ordered.map((row) => ({ size: row.size, quantity: row.quantity, offered: facts?.offered.includes(row.size) ?? false })),
    /** The sizes the colourway offers today (the grid's columns), in range order. */
    offered: [...(facts?.offered ?? [])],
    /** The style's other colours the customer may choose (a discontinued colour). */
    colours: style ? style.colourways.filter((entry) => entry.available).map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })) : [],
    pieces,
    unitPriceShown: asMoney('price', shown === null ? null : priceShown(shown)),
    priceNow: asMoney('price', facts?.priceNow ? priceShown(facts.priceNow) : null),
    amount: asMoney('price', lineAmount(shown, pieces)),
    note: line.note,
    source: source ? { orderLineId: source.orderLineId, orderId: source.orderId, orderNumber: source.orderNumber, customerRef: source.customerRef, orderDate: source.orderDate } : null,
    /** A reorder line's differences from the order it came from (named again whenever the draft is read). */
    notices: source ? [...reorderPlan(source.line, facts, seesPrices).notices] : [],
    problems: lineProblems({ id: line.id, sizes, unitPriceShown: shown }, facts, seesPrices).map(problemView),
  }
}

const problemView = (problem: Problem) => ({ code: problem.code, lineId: problem.lineId, size: problem.size, words: problem.words })

/** The request as the customer reads it (any status). */
export async function requestView(app: FastifyInstance, request: FastifyRequest, reader: PortalReader, row: RequestRow) {
  const day = today(app)
  const lines = await request.withClient((client) => readLines(client, [row.id]))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day, styleIds: lines.map((line) => line.styleId) }))
  const sources = await sourcesOf(request, reader, lines)
  const addresses = await shipToAddresses(request)
  const views = lines.map((line) => lineView(line, catalogue, line.sourceOrderLineId ? (sources.get(line.sourceOrderLineId) ?? null) : null, reader.seesPrices))
  const draft = row.status === 'DRAFT'
  const shipTo = row.shipToAddressId ? addresses.find((address) => address.id === row.shipToAddressId) : undefined
  const problems = draft
    ? [...headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : shipTo?.status === 'ACTIVE', lineCount: lines.length }, day).map(problemView), ...views.flatMap((line) => line.problems)]
    : []
  const totals = draftTotals(lines.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown) })), reader.seesPrices)
  const outcome = await outcomeOf(request, row)
  return {
    request: {
      id: row.id,
      number: row.number,
      status: row.status as RequestStatus,
      words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
      source: row.source as RequestSource,
      customerRef: row.customerRef,
      shipToAddressId: row.shipToAddressId,
      requestedDate: dayText(row.requestedDate),
      note: row.note,
      currency: row.currency,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
      sentAt: iso(row.sentAt),
      decidedAt: iso(row.decidedAt),
      refuseReason: row.refuseReason,
      withdrawnAt: iso(row.withdrawnAt),
      salesOrder: outcome.salesOrder,
      quote: outcome.quote,
      version: row.version,
      lines: views,
      summary: { lines: totals.lines, pieces: totals.pieces, net: asMoney('price', totals.net) },
      problems,
      held: heldWords(problems.length),
      pricesChanged: views.filter((line) => line.problems.some((problem) => problem.code === 'PRICE_CHANGED')).length,
      notice: REQUEST_NOTICE,
    },
    addresses: addresses.map(({ approvalStatus, refuseReason, ...address }) => ({ ...address, isDefault: address.isDefaultShipTo, approval: approvalView({ approvalStatus, refuseReason }) })),
    seesPrices: reader.seesPrices,
  }
}

/** The order or quote a request became (partner reads: their number). */
async function outcomeOf(request: FastifyRequest, row: Pick<RequestRow, 'salesOrderId' | 'quoteId'>) {
  const salesOrder = row.salesOrderId ? await request.withClient((client) => client.salesOrder.findUnique({ where: { id: row.salesOrderId! }, select: { id: true, number: true } })) : null
  const quote = row.quoteId ? await request.withClient((client) => client.quote.findUnique({ where: { id: row.quoteId! }, select: { id: true, number: true } })) : null
  return { salesOrder: salesOrder ?? null, quote: quote ?? null }
}

export async function listRequests(app: FastifyInstance, request: FastifyRequest, query: { readonly status: RequestStatus | 'ALL' }) {
  const reader = portalReader(app, request)
  const rows = await request.withClient((client) =>
    client.portalOrderRequest.findMany({
      where: { companyId: reader.session.company.id, ...(query.status === 'ALL' ? {} : { status: query.status }) },
      select: REQUEST_COLUMNS,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: LIST_MAX,
    }),
  )
  const ordered = [...rows.filter((row) => row.status === 'DRAFT'), ...rows.filter((row) => row.status !== 'DRAFT')]
  const lines = await request.withClient((client) => readLines(client, ordered.map((row) => row.id)))
  const orders = await request.withClient((client) => client.salesOrder.findMany({ where: { id: { in: ordered.flatMap((row) => (row.salesOrderId ? [row.salesOrderId] : [])) } }, select: { id: true, number: true } }))
  const quotes = await request.withClient((client) => client.quote.findMany({ where: { id: { in: ordered.flatMap((row) => (row.quoteId ? [row.quoteId] : [])) } }, select: { id: true, number: true } }))
  return {
    requests: ordered.map((row) => {
      const own = lines.filter((line) => line.requestId === row.id)
      const totals = draftTotals(own.map((line) => ({ sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown) })), reader.seesPrices)
      return {
        id: row.id,
        number: row.number,
        status: row.status as RequestStatus,
        words: REQUEST_STATUS_WORDS[row.status as RequestStatus],
        source: row.source as RequestSource,
        customerRef: row.customerRef,
        requestedDate: dayText(row.requestedDate),
        lines: totals.lines,
        pieces: totals.pieces,
        net: asMoney('price', totals.net),
        currency: row.currency,
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
        sentAt: iso(row.sentAt),
        decidedAt: iso(row.decidedAt),
        salesOrder: orders.find((order) => order.id === row.salesOrderId) ?? null,
        quote: quotes.find((quote) => quote.id === row.quoteId) ?? null,
        version: row.version,
      }
    }),
    seesPrices: reader.seesPrices,
  }
}

export async function getRequest(app: FastifyInstance, request: FastifyRequest, requestId: string) {
  const reader = portalReader(app, request)
  return requestView(app, request, reader, await ownRequest(request, reader, requestId))
}

// ---- the draft's header ------------------------------------------------------------------------------------------------

export interface HeaderBody {
  readonly customerRef?: string | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** The header's own problems (400): an address of the party for deliveries, active; a date from today. */
async function headerIssues(request: FastifyRequest, body: HeaderBody, day: BusinessDate): Promise<Issue[]> {
  const issues: Issue[] = []
  if (body.shipToAddressId) {
    const address = isUuid(body.shipToAddressId) ? await request.withClient((client) => client.partyAddress.findUnique({ where: { id: body.shipToAddressId! }, select: { status: true, kinds: true } })) : null
    if (!address || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) issues.push({ path: 'body/shipToAddressId', message: 'Choose one of your active delivery addresses.' })
  }
  if (body.requestedDate && body.requestedDate < day) issues.push({ path: 'body/requestedDate', message: 'The requested delivery date is today or later.' })
  if (body.customerRef && body.customerRef.trim().length > ORDERING_LIMITS.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${ORDERING_LIMITS.customerRef} characters.` })
  if (body.note && body.note.trim().length > ORDERING_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${ORDERING_LIMITS.note} characters.` })
  return issues
}

const headerData = (body: HeaderBody) => ({
  ...(body.customerRef !== undefined ? { customerRef: blankToNull(body.customerRef) } : {}),
  ...(body.shipToAddressId !== undefined ? { shipToAddressId: body.shipToAddressId } : {}),
  ...(body.requestedDate !== undefined ? { requestedDate: body.requestedDate === null ? null : dayValue(body.requestedDate) } : {}),
  ...(body.note !== undefined ? { note: blankToNull(body.note) } : {}),
})

export async function createDraft(app: FastifyInstance, request: FastifyRequest, body: HeaderBody & { readonly source?: RequestSource | undefined }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  const day = today(app)
  const issues = await headerIssues(request, body, day)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const drafts = await request.withClient((client) => client.portalOrderRequest.count({ where: { companyId: session.company.id, status: 'DRAFT' } }))
  if (drafts >= MAX_DRAFTS) throw new ConflictError(`You keep ${drafts} drafts already: send or discard one first.`)
  const currency = await reader.inTenant(async (db) => (await db.company.findUnique({ where: { id: session.company.id }, select: { currency: true } }))?.currency ?? 'EUR')
  const id = newId()
  await commandOn(app, request, { name: 'portalOrdering.createDraft', idempotencyKey, input: { ...body } }, async (tools) => {
    // The party's default delivery address when none is asked.
    const shipTo = body.shipToAddressId === undefined ? ((await tools.tx.partyAddress.findFirst({ where: { status: 'ACTIVE', isDefaultShipTo: true, kinds: { has: 'SHIP_TO' } }, select: { id: true } }))?.id ?? null) : body.shipToAddressId
    await tools.tx.portalOrderRequest.create({
      data: { id, companyId: session.company.id, partyId: session.partyId, source: body.source ?? 'PICKER', currency, ...headerData(body), shipToAddressId: shipTo, createdById: session.userId, createdAt: tools.now, updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: id, companyId: session.company.id, after: { status: 'DRAFT', source: body.source ?? 'PICKER', ...headerData(body), shipToAddressId: shipTo } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, id))!)
}

/** The draft of the party, for a change by its own session: DRAFT, or 409 in words. */
async function ownDraft(request: FastifyRequest, reader: PortalReader, requestId: string): Promise<RequestRow> {
  const row = await ownRequest(request, reader, requestId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(row.status === 'SENT' ? 'This request was sent: withdraw it to change it, or ask us.' : 'This request is no longer a draft.')
  return row
}

/** A change of the draft in the partner scope: its version checked and moved (command's record guard), then the work. */
function onDraft<Result>(app: FastifyInstance, request: FastifyRequest, name: `${string}.${string}`, row: RequestRow, version: number, input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools) => Promise<Result>) {
  return commandOn(app, request, { name, idempotencyKey, input, record: { type: 'PortalOrderRequest', id: row.id, expectedVersion: version } }, async (tools) => {
    const current = await readRequest(tools.tx, row.id)
    if (current?.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
    return work(tools)
  })
}

export async function changeHeader(app: FastifyInstance, request: FastifyRequest, requestId: string, body: HeaderBody & { readonly version: number }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const { version, ...header } = body
  const issues = await headerIssues(request, header, today(app))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  await onDraft(app, request, 'portalOrdering.changeDraft', row, version, { requestId, ...body }, idempotencyKey, async (tools) => {
    const data = headerData(header)
    if (Object.keys(data).length > 0) await tools.tx.portalOrderRequest.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { customerRef: row.customerRef, shipToAddressId: row.shipToAddressId, requestedDate: dayText(row.requestedDate), note: row.note }, after: data })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

// ---- lines -------------------------------------------------------------------------------------------------------------

export interface NewLine extends LineInput {
  readonly sourceOrderLineId?: string | null | undefined
}

/** The lines asked, checked against the catalogue today: each style sold, the colour available, every size offered. */
export function checkNewLines(lines: readonly NewLine[], catalogue: CustomerCatalogue, at = 'body/lines'): Issue[] {
  const issues: Issue[] = []
  for (const [index, line] of lines.entries()) {
    for (const message of lineShapeProblems(line)) issues.push({ path: `${at}/${index}`, message })
    const facts = factsOf(catalogue, line.styleId, line.colourwayId)
    if (!facts || !facts.sold) issues.push({ path: `${at}/${index}/styleId`, message: 'Not a style of your catalogue.' })
    else if (catalogue.colourways.get(line.colourwayId)?.styleId !== line.styleId || !facts.colourwayActive) issues.push({ path: `${at}/${index}/colourwayId`, message: `Not an available colour of ${facts.styleCode}.` })
    else for (const ask of line.sizes) if (!facts.offered.includes(ask.size.trim())) issues.push({ path: `${at}/${index}/sizes`, message: `Size ${ask.size} is not offered for ${facts.styleCode}.` })
  }
  return issues
}

/** Writes one line and its sizes (partner scope, inside the draft's command). */
async function insertLine(tx: CommandTx, row: RequestRow, line: NewLine, seq: number, price: string | null, actorId: string, now: Date): Promise<string> {
  const id = newId()
  await tx.portalOrderRequestLine.create({
    data: { id, partyId: row.partyId, requestId: row.id, seq, styleId: line.styleId, colourwayId: line.colourwayId, sourceOrderLineId: line.sourceOrderLineId ?? null, unitPriceShown: price, note: blankToNull(line.note), createdById: actorId, createdAt: now, updatedAt: now },
    select: { id: true },
  })
  await tx.portalOrderRequestSize.createMany({ data: line.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId: id, size: ask.size.trim(), quantity: ask.quantity, createdById: actorId, createdAt: now, updatedAt: now })) })
  return id
}

export interface AddOutcome {
  readonly added: readonly string[]
  /** Sizes added to a line the draft already had for that style and colour. */
  readonly merged: readonly { readonly lineId: string; readonly size: string }[]
  /** Sizes a line of the draft already had: the draft's quantity was kept. */
  readonly kept: readonly { readonly lineId: string; readonly size: string }[]
}

/**
 * Inside the draft's command: the lines added. `merge`: a style and colour the draft already has takes the sizes it did
 * not have (an upload, a reorder); otherwise it is refused (the picker: change the line's sizes there).
 */
export async function addLinesInCommand(tools: CommandTools, row: RequestRow, lines: readonly NewLine[], prices: ReadonlyMap<string, string | null>, actorId: string, merge: boolean): Promise<AddOutcome> {
  const { tx, now } = tools
  const existing = await readLines(tx, [row.id])
  const byKey = new Map(existing.map((line) => [`${line.styleId}|${line.colourwayId}`, { id: line.id, seq: line.seq, sizes: new Set(line.sizes.map((size) => size.size)) }]))
  let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0)
  const added: string[] = []
  const merged: { lineId: string; size: string }[] = []
  const kept: { lineId: string; size: string }[] = []
  for (const [index, line] of lines.entries()) {
    const key = `${line.styleId}|${line.colourwayId}`
    const same = byKey.get(key)
    if (same) {
      if (!merge) throw new ValidationError('This style and colour is already on the request: change its sizes there.', [{ path: `body/lines/${index}`, message: `Already on line ${same.seq}: change its sizes there.` }])
      const fresh = line.sizes.filter((ask) => !same.sizes.has(ask.size))
      for (const ask of line.sizes) if (same.sizes.has(ask.size)) kept.push({ lineId: same.id, size: ask.size })
      if (fresh.length > 0) {
        await tx.portalOrderRequestSize.createMany({ data: fresh.map((ask) => ({ id: newId(), partyId: row.partyId, lineId: same.id, size: ask.size, quantity: ask.quantity, createdById: actorId, createdAt: now, updatedAt: now })) })
        await tx.portalOrderRequestLine.update({ where: { id: same.id }, data: { version: { increment: 1 } }, select: { id: true } })
        for (const ask of fresh) {
          same.sizes.add(ask.size)
          merged.push({ lineId: same.id, size: ask.size })
        }
      }
      continue
    }
    if (byKey.size >= ORDERING_LIMITS.lines) throw new ValidationError(`At most ${ORDERING_LIMITS.lines} lines per request.`, [{ path: 'body/lines', message: `At most ${ORDERING_LIMITS.lines} lines per request.` }])
    seq += 1
    const id = await insertLine(tx, row, line, seq, prices.get(key) ?? null, actorId, now)
    added.push(id)
    byKey.set(key, { id, seq, sizes: new Set(line.sizes.map((ask) => ask.size)) })
  }
  return { added, merged, kept }
}

/** Today's price per style and colour of the lines (only for a person who sees prices: else none is shown). */
export function pricesFor(lines: readonly { readonly styleId: string; readonly colourwayId: string }[], catalogue: CustomerCatalogue, seesPrices: boolean): Map<string, string | null> {
  return new Map(lines.map((line) => [`${line.styleId}|${line.colourwayId}`, seesPrices ? (factsOf(catalogue, line.styleId, line.colourwayId)?.priceNow ?? null) : null]))
}

const trimmed = (lines: readonly NewLine[]): NewLine[] => lines.map((line) => ({ ...line, sizes: line.sizes.map((ask) => ({ size: ask.size.trim(), quantity: ask.quantity })) }))

export async function addLines(app: FastifyInstance, request: FastifyRequest, requestId: string, body: { readonly version: number; readonly lines: readonly NewLine[] }, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const lines = trimmed(body.lines.map((line) => ({ ...line, sourceOrderLineId: null })))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: lines.map((line) => line.styleId) }))
  const issues = checkNewLines(lines, catalogue)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const prices = pricesFor(lines, catalogue, reader.seesPrices)
  await onDraft(app, request, 'portalOrdering.addLines', row, body.version, { requestId, lines }, idempotencyKey, async (tools) => {
    const outcome = await addLinesInCommand(tools, row, lines, prices, reader.session.userId, false)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { added: outcome.added, lines: lines.map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPriceShown: markMoney('price', prices.get(`${line.styleId}|${line.colourwayId}`) ?? null) })) } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

async function ownLine(tx: Reader, row: RequestRow, lineId: string): Promise<LineRow> {
  const line = isUuid(lineId) ? (await readLines(tx, [row.id])).find((entry) => entry.id === lineId) : undefined
  if (!line) throw new NotFoundError('Line not found.')
  return line
}

export async function changeLine(
  app: FastifyInstance,
  request: FastifyRequest,
  requestId: string,
  lineId: string,
  body: { readonly version: number; readonly colourwayId?: string | undefined; readonly sizes?: readonly SizeAsk[] | undefined; readonly note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  const line = await request.withClient((client) => ownLine(client, row, lineId))
  const next: NewLine = { styleId: line.styleId, colourwayId: body.colourwayId ?? line.colourwayId, sizes: (body.sizes ?? sizesOf(line)).map((ask) => ({ size: ask.size.trim(), quantity: ask.quantity })), note: body.note === undefined ? line.note : body.note }
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: [line.styleId] }))
  // Only a change of sizes or colour is checked against today's catalogue: a note alone keeps the line as it was.
  const touchesCatalogue = body.sizes !== undefined || body.colourwayId !== undefined
  const issues = touchesCatalogue ? checkNewLines([next], catalogue, 'body/line') : lineShapeProblems(next).filter((message) => message.includes('note')).map((message) => ({ path: 'body/note', message }))
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const colourChanged = next.colourwayId !== line.colourwayId
  if (colourChanged) {
    const duplicate = (await request.withClient((client) => readLines(client, [row.id]))).find((entry) => entry.id !== line.id && entry.styleId === line.styleId && entry.colourwayId === next.colourwayId)
    if (duplicate) throw new ValidationError('This colour is already on the request.', [{ path: 'body/colourwayId', message: `Already on line ${duplicate.seq}.` }])
  }
  const price = colourChanged ? (pricesFor([next], catalogue, reader.seesPrices).get(`${next.styleId}|${next.colourwayId}`) ?? null) : priceOrNull(line.unitPriceShown)
  await onDraft(app, request, 'portalOrdering.changeLine', row, body.version, { requestId, lineId, ...body }, idempotencyKey, async (tools) => {
    const { tx, now } = tools
    const current = await ownLine(tx, row, lineId)
    if (body.sizes !== undefined) {
      await tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
      await tx.portalOrderRequestSize.createMany({ data: next.sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId, size: ask.size, quantity: ask.quantity, createdById: reader.session.userId, createdAt: now, updatedAt: now })) })
    }
    await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { colourwayId: next.colourwayId, note: blankToNull(next.note), unitPriceShown: price, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      recordType: 'PortalOrderRequest',
      recordId: row.id,
      companyId: row.companyId,
      before: { lineId, colourwayId: current.colourwayId, sizes: sizesOf(current), note: current.note, unitPriceShown: markMoney('price', priceOrNull(current.unitPriceShown)) },
      after: { lineId, colourwayId: next.colourwayId, sizes: next.sizes, note: blankToNull(next.note), unitPriceShown: markMoney('price', price) },
    })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

export async function removeLine(app: FastifyInstance, request: FastifyRequest, requestId: string, lineId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await onDraft(app, request, 'portalOrdering.removeLine', row, version, { requestId, lineId, version }, idempotencyKey, async (tools) => {
    const line = await ownLine(tools.tx, row, lineId)
    await tools.tx.portalOrderRequestSize.deleteMany({ where: { lineId } })
    await tools.tx.portalOrderRequestLine.delete({ where: { id: lineId }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { lineId, seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizesOf(line) }, after: { lineId: null } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

/** "Prices changed since you started — Review": every line takes the customer's price today. */
export async function takeTodaysPrices(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  if (!reader.seesPrices) throw new InvalidStateError('Prices are not part of your access: the factory confirms them.')
  const lines = await request.withClient((client) => readLines(client, [row.id]))
  const catalogue = await reader.inTenant((db) => readCatalogue(db, { companyId: row.companyId, partyId: row.partyId, day: today(app), styleIds: lines.map((line) => line.styleId) }))
  const prices = pricesFor(lines, catalogue, true)
  await onDraft(app, request, 'portalOrdering.takePrices', row, version, { requestId, version }, idempotencyKey, async (tools) => {
    const changed: { lineId: string; before: string | null; after: string | null }[] = []
    for (const line of await readLines(tools.tx, [row.id])) {
      const now = prices.get(`${line.styleId}|${line.colourwayId}`) ?? null
      const before = priceOrNull(line.unitPriceShown)
      if (now === null || (before !== null && Number(before) === Number(now))) continue
      await tools.tx.portalOrderRequestLine.update({ where: { id: line.id }, data: { unitPriceShown: now, version: { increment: 1 } }, select: { id: true } })
      changed.push({ lineId: line.id, before, after: now })
    }
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, after: { prices: markMoney('price', changed) } })
    return null
  })
  return requestView(app, request, reader, (await ownRequest(request, reader, requestId))!)
}

export async function discardDraft(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownDraft(request, reader, requestId)
  await commandOn(app, request, { name: 'portalOrdering.discardDraft', idempotencyKey, input: { requestId, version } }, async (tools) => {
    const current = await readRequest(tools.tx, row.id)
    if (!current || current.status !== 'DRAFT') throw new InvalidStateError('This request is no longer a draft.')
    if (current.version !== version) throw new ConflictError(`This draft changed since you read it (now version ${current.version}). Read it again.`)
    const lines = await readLines(tools.tx, [row.id])
    await tools.tx.portalOrderRequestSize.deleteMany({ where: { lineId: { in: lines.map((line) => line.id) } } })
    await tools.tx.portalOrderRequestLine.deleteMany({ where: { requestId: row.id } })
    await tools.tx.portalOrderRequest.delete({ where: { id: row.id }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: row.id, companyId: row.companyId, before: { status: 'DRAFT', lines: lines.length }, after: { discarded: true } })
    return null
  })
  return { discarded: true as const }
}

// ---- send and withdraw -------------------------------------------------------------------------------------------------

/** The problems of a draft today (the send's check): its header's and every line's, as the record shows them. */
async function sendProblems(tx: CommandTx, row: RequestRow, lines: readonly LineRow[], day: BusinessDate, seesPrices: boolean): Promise<Problem[]> {
  const catalogue = await readCatalogue(tx, { companyId: row.companyId, partyId: row.partyId, day, styleIds: lines.map((line) => line.styleId) })
  const shipTo = row.shipToAddressId ? await tx.partyAddress.findUnique({ where: { id: row.shipToAddressId }, select: { status: true } }) : null
  return [
    ...headerProblems({ requestedDate: dayText(row.requestedDate), shipToActive: row.shipToAddressId === null ? null : shipTo?.status === 'ACTIVE', lineCount: lines.length }, day),
    ...lines.flatMap((line) => lineProblems({ id: line.id, sizes: sizesOf(line), unitPriceShown: priceOrNull(line.unitPriceShown) }, factsOf(catalogue, line.styleId, line.colourwayId), seesPrices)),
  ]
}

/**
 * The send: in the tenant's office scope as the portal person (the numbering grant; the office role may move a DRAFT to
 * SENT with its number and nothing else, the guard holds it), checked again inside the command (the catalogue today, the
 * prices shown), the PORTAL_REQUEST number, SENT, its audit row and portal_order_request.sent. The answer says when the
 * factory confirms: the next working day of the company's calendar.
 */
export async function sendRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  const row = await ownDraft(request, reader, requestId)
  if (row.version !== version) throw new ConflictError(`This draft changed since you read it (now version ${row.version}). Read it again.`)
  const p = portalOf(app)
  const outcome = await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalOrdering.send', idempotencyKey, input: { requestId, version, sessionId: session.id } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRequest(tx, requestId, version)
    if (current.partyId !== session.partyId || current.companyId !== session.company.id) throw new NotFoundError('Order request not found.')
    if (current.status !== 'DRAFT') throw new InvalidStateError('This request was already sent.')
    const day = businessDate(now)
    const lines = await readLines(tx, [current.id])
    const problems = await sendProblems(tx, current, lines, day, reader.seesPrices)
    if (problems.length > 0) throw new DomainError('invalid_state', `${problems.length === 1 ? '1 problem holds' : `${problems.length} problems hold`} the send: fix ${problems.length === 1 ? 'it' : 'them'} first.`, problems.map((entry) => ({ path: entry.lineId ? `lines/${entry.lineId}` : 'request', message: entry.words.en })))
    const number = await allocateNumber(tools, { companyId: current.companyId, kind: 'PORTAL_REQUEST' }, { type: 'PortalOrderRequest', id: current.id, date: day })
    await tx.portalOrderRequest.update({ where: { id: current.id }, data: { status: 'SENT', number: number.formatted, sentAt: now, sentById: session.userId, version: current.version + 1 }, select: { id: true } })
    const pieces = lines.reduce((sum, line) => sum + piecesOfSizes(sizesOf(line)), 0)
    tools.audit({ recordType: 'PortalOrderRequest', recordId: current.id, companyId: current.companyId, before: { status: 'DRAFT' }, after: { status: 'SENT', number: number.formatted, lines: lines.length, pieces, byPartner: true } })
    tools.emit({ type: 'portal_order_request.sent', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, number: number.formatted, partyId: current.partyId, source: current.source, lines: lines.length, pieces } })
    const confirmBy = (await addWorkingDaysFor(tx, { scope: 'COMPANY', id: current.companyId }, day, 1)).date
    return { number: number.formatted, confirmBy }
  })
  const sent = await ownRequest(request, reader, requestId)
  const { number, confirmBy } = outcome.result
  const po = sent.customerRef
  return {
    ...(await requestView(app, request, reader, sent)),
    sent: {
      number,
      confirmBy,
      words: {
        it: `Richiesta d'ordine inviata${po ? ` — il vostro ordine ${po}` : ''}, la nostra richiesta ${number}.${confirmBy ? ` Confermiamo entro il ${confirmBy.split('-').reverse().join('/')}.` : ''}`,
        en: `Order request sent${po ? ` — your PO ${po}` : ''}, our request ${number}.${confirmBy ? ` We confirm by ${confirmBy}.` : ''}`,
      },
    },
  }
}

export async function withdrawRequest(app: FastifyInstance, request: FastifyRequest, requestId: string, version: number, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const row = await ownRequest(request, reader, requestId)
  const problem = withdrawProblem(row.status as RequestStatus)
  if (problem) throw new InvalidStateError(problem)
  await commandOn(app, request, { name: 'portalOrdering.withdraw', idempotencyKey, input: { requestId, version } }, async (tools) => {
    const current = await lockRequest(tools.tx, requestId, version)
    const again = withdrawProblem(current.status as RequestStatus)
    if (again) throw new InvalidStateError(again)
    await tools.tx.portalOrderRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, version: current.version + 1 }, select: { id: true } })
    tools.audit({ recordType: 'PortalOrderRequest', recordId: requestId, companyId: current.companyId, before: { status: 'SENT' }, after: { status: 'WITHDRAWN', byPartner: true } })
    tools.emit({ type: 'portal_order_request.withdrawn', subject: requestId, companyId: current.companyId, payload: { requestId, number: current.number!, partyId: current.partyId } })
    return null
  })
  return requestView(app, request, reader, await ownRequest(request, reader, requestId))
}

export type { RequestRow }
export { sizesOf }
