import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, Uom } from '@nexus/factory-db'
import { PORTAL_UPLOAD } from '@nexus/factory-domain/auth/partners/permissions'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { requirementSentence } from '@nexus/factory-domain/files/required/rules'
import { NUMBER_FORMATS, type NumberFormat } from '@nexus/factory-domain/imports/cells'
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import { SHEET_TYPES, sheetTypeProblem } from '@nexus/factory-domain/imports/job'
import { parseRow } from '@nexus/factory-domain/imports/plan'
import { importTemplate } from '@nexus/factory-domain/imports/templates'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { hideInputOf, PORTAL_PACKING_LIST } from '@nexus/factory-domain/purchasing/ship-notices/importer'
import {
  blankText,
  differencesNeedNote,
  isEditableNotice,
  isShippableOrder,
  lineProblems,
  NOTICE_STATES,
  NOTICE_STATE_WORDS,
  noticeStateOf,
  placeHides,
  sendProblems,
  SHIP_NOTICE_LIMITS,
  TERM_FIELDS,
  termsProblems,
  type HideInput,
  type LineInput,
  type NoticeState,
  type NoticeTerms,
  type PackingLine,
  type PlacedHide,
  type Reason,
  type TermField,
  type Verdict,
} from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { requiredDocumentsProblems, assertRequiredDocuments } from '../../../platform/files/required/check'
import { systemCallerOf } from '../../../platform/files/files'
import { readSheet, SheetError } from '../../../platform/imports/sheet'
import { templateFile } from '../../../platform/imports/templates/template'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { dayOf, dayValue, type Reader } from '../store'
import { checkOf, crViEvidenceOf, noticeView, openOf, orderLinesOf, readNotice, readNoticeLines, type NoticeHideRow, type NoticeLineRow, type NoticeRow, type OrderLineView } from './store'

/**
 * The supplier's ship notices in the portal (B-W2b-182; SCM-106 "Create ship notice from PO", SCM-107 "Leather packing list
 * on the ASN"; design portal.supplier.asn): the deliveries announced and how each was received, the lines of confirmed orders
 * it may ship, a new notice from an order (lines, lots, dye batches, transport), the tannery's packing list by hand or from
 * its sheet with a verdict per row BEFORE anything is kept, the send, the cancel. Never a price (Owner answer C2).
 *
 * The person needs the page (portal.shipNotices.view, the routes') AND the capability to send us things (portal.upload,
 * checked here: B-W2b-162); an office preview never writes. A draft, its lines and hides are written in the session's own
 * scope (factory_partner_runtime: the party's wall and the …_portal_supply_w2b_guards triggers that let a partner change its
 * notice until it is received and cancel a sent one); the SEND runs as the tenant's system (the partner role holds no
 * numbering grant, B-W2b-158): the required documents of the move (B-W2b-177: a BLOCK refuses it, a WARN is said), the
 * number from the company's ASN series, SENT. Every audit row names the person (`byPartner`).
 */

const LIST_MAX = 500
const ORDERS_MAX = 50
/** A sheet sent inline (base64 in the JSON body under the 1 MiB body limit). */
const SHEET_MAX_BYTES = 700 * 1024

const system = (request: FastifyRequest, session: PortalSession): CommandCaller => systemCallerOf(request)(session.tenantId)
const personOf = (session: PortalSession) => ({ id: session.userId, name: session.person.displayName })

/** May this person send us things (the capability over the company and party; never an office preview)? */
export function mayWrite(request: FastifyRequest, session: PortalSession): boolean {
  if (session.preview) return false
  return can(actorOf(requireContext(request)), PORTAL_UPLOAD, { companyId: session.company.id, partyId: session.partyId })
}

function assertMayWrite(request: FastifyRequest, session: PortalSession): void {
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never announces a delivery for the supplier.')
  if (!mayWrite(request, session)) throw new ForbiddenError('Your access lets you read your deliveries, not announce them: ask your admin for the right to upload.')
}

/** The notice in the session's own scope (another party's is as unknown as a wrong id), of the portal's company. */
async function heldNotice(db: Reader, session: PortalSession, noticeId: string): Promise<NoticeRow> {
  const notice = isUuid(noticeId) ? await readNotice(db, noticeId) : null
  if (!notice || notice.companyId !== session.company.id) throw new NotFoundError('Ship notice not found.')
  return notice
}

const ORDER_SELECT = { id: true, number: true, status: true, revision: true, companyId: true, siteId: true, partyId: true } as const satisfies Prisma.PurchaseOrderSelect
type HeldOrder = Prisma.PurchaseOrderGetPayload<{ select: typeof ORDER_SELECT }>

async function heldOrder(db: Reader, session: PortalSession, orderId: string): Promise<HeldOrder> {
  const order = isUuid(orderId) ? await db.purchaseOrder.findFirst({ where: { id: orderId, companyId: session.company.id }, select: ORDER_SELECT }) : null
  if (!order) throw new NotFoundError('Purchase order not found.')
  return order
}

function assertEditable(notice: Pick<NoticeRow, 'status' | 'number'>): void {
  if (!isEditableNotice(notice.status)) {
    throw new InvalidStateError(notice.status === 'RECEIVED' ? `Ship notice ${notice.number} was received by our warehouse: it changes no more.` : `Ship notice ${notice.number ?? ''} was cancelled: announce the delivery again.`.replace('  ', ' '))
  }
}

const termsOf = (notice: NoticeRow): Required<{ [K in TermField]: NoticeTerms[K] }> => ({
  supplierRef: notice.supplierRef,
  ddtNumber: notice.ddtNumber,
  ddtDate: dayOf(notice.ddtDate),
  shipDate: dayOf(notice.shipDate),
  expectedDate: dayOf(notice.expectedDate),
  carrier: notice.carrier,
  trackingNumber: notice.trackingNumber,
  parcels: notice.parcels,
  note: notice.note,
})

/** The term columns a body gives (a key left out stays; null or '' clears it). */
function termColumns(body: NoticeTerms): Prisma.ShipNoticeUncheckedUpdateInput {
  const data: Record<string, unknown> = {}
  for (const field of TERM_FIELDS) {
    if (!(field in body) || body[field] === undefined) continue
    const value = body[field]
    if (field === 'parcels') data[field] = value === null ? null : value
    else if (field === 'ddtDate' || field === 'shipDate' || field === 'expectedDate') data[field] = typeof value === 'string' && value ? dayValue(value) : null
    else data[field] = typeof value === 'string' ? blankText(value) : null
  }
  return data as Prisma.ShipNoticeUncheckedUpdateInput
}

function mergedTerms(current: Required<{ [K in TermField]: NoticeTerms[K] }>, body: NoticeTerms): Required<{ [K in TermField]: NoticeTerms[K] }> {
  const merged: Record<string, unknown> = { ...current }
  for (const field of TERM_FIELDS) if (field in body && body[field] !== undefined) merged[field] = field === 'parcels' ? body[field] : typeof body[field] === 'string' ? blankText(body[field] as string) : null
  return merged as Required<{ [K in TermField]: NoticeTerms[K] }>
}

/** Today in the business calendar of the app's clock. */
const todayAt = (now: Date) => businessDate(now)

// ---- reads -----------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly state?: NoticeState | undefined
  readonly purchaseOrderId?: string | undefined
  readonly q?: string | undefined
}

/** GET /portal/ship-notices: every notice of the portal's company, newest first, its state in the design's words. */
export async function listNotices(request: FastifyRequest, query: ListQuery, now: Date) {
  const session = portalSessionOf(request)
  const today = todayAt(now)
  const text = query.q?.trim()
  const rows = await request.withClient(async (client) =>
    client.shipNotice.findMany({
      where: {
        AND: [
          { companyId: session.company.id },
          query.purchaseOrderId && isUuid(query.purchaseOrderId) ? { purchaseOrderId: query.purchaseOrderId } : {},
          text
            ? {
                OR: [
                  { number: { contains: text, mode: 'insensitive' } },
                  { supplierRef: { contains: text, mode: 'insensitive' } },
                  { ddtNumber: { contains: text, mode: 'insensitive' } },
                  { trackingNumber: { contains: text, mode: 'insensitive' } },
                  { purchaseOrder: { number: { contains: text, mode: 'insensitive' } } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_MAX + 1,
      select: {
        id: true,
        number: true,
        status: true,
        purchaseOrderId: true,
        shipDate: true,
        expectedDate: true,
        carrier: true,
        trackingNumber: true,
        ddtNumber: true,
        supplierRef: true,
        parcels: true,
        sentAt: true,
        version: true,
        purchaseOrder: { select: { number: true } },
        lines: { select: { quantity: true, receivedQuantity: true } },
        _count: { select: { lines: true } },
      },
    }),
  )
  const hides = rows.length === 0 ? [] : await request.withClient((client) => client.shipNoticeHide.groupBy({ by: ['shipNoticeId'], where: { shipNoticeId: { in: rows.slice(0, LIST_MAX).map((row) => row.id) } }, _count: { _all: true } }))
  const hideCounts = new Map(hides.map((row) => [row.shipNoticeId, row._count._all]))
  const items = rows.slice(0, LIST_MAX).map((row) => {
    const lines = row.lines.map((line) => ({ quantity: line.quantity.toString(), receivedQuantity: line.receivedQuantity === null ? null : line.receivedQuantity.toString() }))
    const state = noticeStateOf({ status: row.status, shipDate: dayOf(row.shipDate), lines }, today)
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      state,
      words: NOTICE_STATE_WORDS[state],
      purchaseOrder: { id: row.purchaseOrderId, number: row.purchaseOrder.number },
      shipDate: dayOf(row.shipDate),
      expectedDate: dayOf(row.expectedDate),
      carrier: row.carrier,
      trackingNumber: row.trackingNumber,
      ddtNumber: row.ddtNumber,
      supplierRef: row.supplierRef,
      parcels: row.parcels,
      sentAt: row.sentAt === null ? null : toUtcIso(row.sentAt),
      lines: row._count.lines,
      hides: hideCounts.get(row.id) ?? 0,
      differing: lines.filter((line) => line.receivedQuantity !== null && !new Dec(line.receivedQuantity).equals(new Dec(line.quantity))).length,
      version: row.version,
    }
  })
  const counts = Object.fromEntries(NOTICE_STATES.map((state) => [state, items.filter((item) => item.state === state).length])) as Record<NoticeState, number>
  return {
    asOf: toUtcIso(now),
    mayWrite: mayWrite(request, session),
    counts,
    items: query.state ? items.filter((item) => item.state === query.state) : items,
    more: rows.length > LIST_MAX,
    live: { events: ['ship_notice.sent', 'ship_notice.changed', 'ship_notice.cancelled', 'ship_notice.received', 'ship_notice.reopened'] },
  }
}

const lineChoice = (line: OrderLineView) => ({
  purchaseOrderLineId: line.id,
  seq: line.seq,
  item: { code: line.item.code, name: line.item.name, leather: line.item.leather },
  supplierArticleCode: line.supplierArticleCode,
  colour: line.colour?.name ?? null,
  uom: line.uom,
  expected: line.facts.expected,
  received: line.facts.received,
  inTransit: line.facts.inTransit,
  open: openOf(line.facts).toFixed(4),
  needDate: line.needDate,
  confirmedDate: line.confirmedDate,
  grade: line.facts.grade,
  thicknessMinMm: line.facts.thicknessMinMm,
  thicknessMaxMm: line.facts.thicknessMaxMm,
  oneDyeBatch: line.facts.oneDyeBatch,
  tolerancePct: line.facts.tolerancePct,
  estimatedHides: line.facts.estimatedHides,
  requiresCrViTest: line.facts.requiresCrViTest,
})

/** GET /portal/ship-notices/shippable: the open lines of our confirmed orders (design step 1 "What you ship"). */
export async function shippableLines(request: FastifyRequest, query: { readonly purchaseOrderId?: string | undefined }) {
  const session = portalSessionOf(request)
  const orders = await request.withClient((client) =>
    client.purchaseOrder.findMany({
      where: { companyId: session.company.id, status: { in: ['CONFIRMED', 'PARTLY_RECEIVED'] }, ...(query.purchaseOrderId && isUuid(query.purchaseOrderId) ? { id: query.purchaseOrderId } : {}) },
      orderBy: { number: 'asc' },
      take: ORDERS_MAX,
      select: ORDER_SELECT,
    }),
  )
  const out = []
  for (const order of orders) {
    const lines = await system(request, session).withClient((client) => orderLinesOf(client, order.id, null))
    const open = lines.filter((line) => !line.ended && openOf(line.facts).greaterThan(0))
    if (open.length === 0) continue
    out.push({ id: order.id, number: order.number, documentNumber: purchaseOrderDocumentNumber(order.number, order.revision), status: order.status, lines: open.map(lineChoice) })
  }
  return { mayWrite: mayWrite(request, session), orders: out }
}

/** The notice's page: the notice with its checks, the order's lines it may still add, what the send would need. */
async function pageOf(request: FastifyRequest, session: PortalSession, noticeId: string, now: Date) {
  const today = todayAt(now)
  const { notice, lines, hides, orderNumber } = await request.withClient(async (client) => {
    const found = await heldNotice(client, session, noticeId)
    const order = await client.purchaseOrder.findUnique({ where: { id: found.purchaseOrderId }, select: { number: true } })
    return { notice: found, ...(await readNoticeLines(client, found.id)), orderNumber: order?.number ?? '' }
  })
  const facts = await system(request, session).withClient(async (client) => {
    const db = client
    const order = await orderLinesOf(db, notice.purchaseOrderId, notice.id)
    const crVi = await crViEvidenceOf(db, notice.id, notice.partyId, today)
    const site = await db.site.findUnique({ where: { id: notice.siteId }, select: { id: true, code: true, name: true } })
    const required = notice.status === 'DRAFT' ? await requiredDocumentsProblems(db as Parameters<typeof requiredDocumentsProblems>[0], { recordType: 'ShipNotice', recordId: notice.id, toStatus: 'SENT', today }) : null
    return { order, crVi, site, required }
  })
  const check = checkOf(facts.order, lines, hides, facts.crVi)
  const view = noticeView(notice, lines, hides, facts.order, check, orderNumber, today)
  const writable = mayWrite(request, session)
  const editable = isEditableNotice(notice.status)
  const sendIssues = notice.status === 'DRAFT' ? sendProblems({ lines: lines.length, shipDate: dayOf(notice.shipDate), expectedDate: dayOf(notice.expectedDate) }) : []
  const blocks = facts.required?.blocks.map(requirementSentence) ?? []
  return {
    notice: view,
    site: facts.site ? { id: facts.site.id, code: facts.site.code, name: facts.site.name } : null,
    mayWrite: writable,
    canEdit: writable && editable,
    canSend: writable && notice.status === 'DRAFT' && sendIssues.length === 0 && blocks.length === 0,
    canCancel: writable && editable,
    /** What still holds the send, in words (empty: it may go). */
    sendHeld: [...sendIssues.map((issue) => issue.message), ...blocks],
    /** Documents the send asks for but does not hold for (B-W2b-177 WARN rules). */
    warnings: facts.required?.warnings.map(requirementSentence) ?? [],
    /** The order lines it may still add (open, not on this notice). */
    addable: facts.order.filter((line) => !line.ended && !lines.some((own) => own.purchaseOrderLineId === line.id) && openOf(line.facts).greaterThan(0)).map(lineChoice),
    live: { events: ['ship_notice.changed', 'ship_notice.cancelled', 'ship_notice.received', 'ship_notice.reopened'] },
  }
}

/** GET /portal/ship-notices/:shipNoticeId */
export async function portalNotice(request: FastifyRequest, noticeId: string, now: Date) {
  return pageOf(request, portalSessionOf(request), noticeId, now)
}

// ---- a new notice, its lines and terms ---------------------------------------------------------------------------------------

export interface CreateBody extends NoticeTerms {
  readonly purchaseOrderId: string
  readonly lines: readonly LineInput[]
}

export interface UpdateBody extends NoticeTerms {
  readonly version: number
  readonly lines?: readonly LineInput[] | undefined
}

function linesIssues(lines: readonly LineInput[] | undefined, order: readonly OrderLineView[]): Issue[] {
  if (lines === undefined) return []
  if (lines.length === 0) return [{ path: 'body/lines', message: 'Pick at least one line to ship.' }]
  const open = new Set(order.filter((line) => !line.ended).map((line) => line.id))
  return lineProblems(lines, open)
}

/** Writes the notice's lines as given: kept by their order line (updated), new ones added, the rest removed with their hides. */
async function writeLines(tools: CommandTools, notice: Pick<NoticeRow, 'id' | 'siteId' | 'partyId'>, lines: readonly LineInput[], order: readonly OrderLineView[]): Promise<void> {
  const { tx } = tools
  const current = await tx.shipNoticeLine.findMany({ where: { shipNoticeId: notice.id }, select: { id: true, seq: true, purchaseOrderLineId: true } })
  const units = new Map(order.map((line) => [line.id, line.uom]))
  const wanted = new Set(lines.map((line) => line.purchaseOrderLineId))
  const gone = current.filter((line) => !wanted.has(line.purchaseOrderLineId)).map((line) => line.id)
  if (gone.length > 0) {
    await tx.shipNoticeHide.deleteMany({ where: { shipNoticeLineId: { in: gone } } })
    await tx.shipNoticeLine.deleteMany({ where: { id: { in: gone } } })
  }
  let next = current.reduce((max, line) => Math.max(max, line.seq), 0)
  for (const line of lines) {
    const own = current.find((entry) => entry.purchaseOrderLineId === line.purchaseOrderLineId)
    const data = { quantity: new Dec(line.quantity).toFixed(4), supplierLot: blankText(line.supplierLot), dyeBatch: blankText(line.dyeBatch), note: blankText(line.note) }
    if (own) await tx.shipNoticeLine.update({ where: { id: own.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    else {
      next += 10
      await tx.shipNoticeLine.create({ data: { id: newId(), siteId: notice.siteId, partyId: notice.partyId, shipNoticeId: notice.id, seq: next, purchaseOrderLineId: line.purchaseOrderLineId, uom: units.get(line.purchaseOrderLineId)! as Uom, ...data, createdAt: tools.now, updatedAt: tools.now }, select: { id: true } })
    }
  }
}

/**
 * POST /portal/ship-notices: a draft from one of our confirmed orders (design "Announce delivery", step 1). No createdById: the
 * partner role holds no grant on it (the audit row names the person).
 */
export async function createNotice(app: FastifyInstance, request: FastifyRequest, body: CreateBody, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const order = await request.withClient((client) => heldOrder(client, session, body.purchaseOrderId))
  if (!isShippableOrder(order.status)) throw new InvalidStateError(`Purchase order ${order.number} is not confirmed: confirm it first, then announce what you ship.`)
  const lines = await system(request, session).withClient((client) => orderLinesOf(client, order.id, null))
  const issues = [...linesIssues(body.lines, lines), ...termsProblems(mergedTerms(termsOf({ supplierRef: null, ddtNumber: null, ddtDate: null, shipDate: null, expectedDate: null, carrier: null, trackingNumber: null, parcels: null, note: null } as NoticeRow), body))]
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'Some fields need a fix.', issues)
  const person = personOf(session)
  const { result } = await commandOn(app, request, { name: 'purchasing.shipNoticeDraft', idempotencyKey, input: body }, async (tools) => {
    const current = await heldOrder(tools.tx, session, order.id)
    if (!isShippableOrder(current.status)) throw new InvalidStateError(`Purchase order ${current.number} is not confirmed: confirm it first, then announce what you ship.`)
    const id = newId()
    await tools.tx.shipNotice.create({
      data: { id, companyId: current.companyId, siteId: current.siteId, partyId: current.partyId, purchaseOrderId: current.id, ...(termColumns(body) as object), createdAt: tools.now, updatedAt: tools.now } as Prisma.ShipNoticeUncheckedCreateInput,
      select: { id: true },
    })
    await writeLines(tools, { id, siteId: current.siteId, partyId: current.partyId }, body.lines, lines)
    tools.audit({
      action: 'purchasing.shipNoticeDraft',
      recordType: 'ShipNotice',
      recordId: id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { status: 'DRAFT', byPartner: true, personId: person.id, byName: person.name, purchaseOrderId: current.id, lines: body.lines.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity, dyeBatch: blankText(line.dyeBatch), supplierLot: blankText(line.supplierLot) })) },
    })
    return { id }
  })
  return pageOf(request, session, result.id, now)
}

/** PATCH /portal/ship-notices/:shipNoticeId: its terms and lines until it is received. */
export async function updateNotice(app: FastifyInstance, request: FastifyRequest, noticeId: string, body: UpdateBody, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const notice = await request.withClient((client) => heldNotice(client, session, noticeId))
  assertEditable(notice)
  const lines = body.lines === undefined ? [] : await system(request, session).withClient((client) => orderLinesOf(client, notice.purchaseOrderId, notice.id))
  const issues = [...linesIssues(body.lines, lines), ...termsProblems(mergedTerms(termsOf(notice), body))]
  if (notice.status === 'SENT') {
    const merged = mergedTerms(termsOf(notice), body)
    issues.push(...sendProblems({ lines: body.lines?.length ?? 1, shipDate: merged.shipDate ?? null, expectedDate: merged.expectedDate ?? null }).filter((issue) => issue.path !== 'body/lines' || body.lines !== undefined))
  }
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'Some fields need a fix.', issues)
  const person = personOf(session)
  await commandOn(app, request, { name: 'purchasing.shipNoticeChange', idempotencyKey, input: { noticeId, ...body }, record: { type: 'ShipNotice', id: notice.id, expectedVersion: body.version } }, async (tools) => {
    const current = await heldNotice(tools.tx, session, notice.id)
    assertEditable(current)
    const data = termColumns(body)
    if (Object.keys(data).length > 0) await tools.tx.shipNotice.update({ where: { id: current.id }, data, select: { id: true } })
    if (body.lines !== undefined) await writeLines(tools, current, body.lines, lines)
    const after = await readNotice(tools.tx, current.id)
    tools.audit({
      action: 'purchasing.shipNoticeChange',
      recordType: 'ShipNotice',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { ...termsOf(current) },
      after: { ...termsOf(after!), byPartner: true, personId: person.id, byName: person.name, ...(body.lines ? { lines: body.lines.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity })) } : {}) },
    })
    if (current.status === 'SENT') {
      tools.emit({
        type: 'ship_notice.changed',
        subject: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        payload: { shipNoticeId: current.id, number: current.number!, purchaseOrderId: current.purchaseOrderId, partyId: current.partyId, status: 'SENT', what: body.lines !== undefined ? 'LINES' : 'TERMS', expectedDate: dayOf(after!.expectedDate) },
      })
    }
    return { id: current.id }
  })
  return pageOf(request, session, notice.id, now)
}

// ---- the packing list ------------------------------------------------------------------------------------------------------

/** The notice's leather lines, as the packing list's rows find them. */
function leatherLinesOf(lines: readonly NoticeLineRow[], order: readonly OrderLineView[]): PackingLine[] {
  const orders = new Map(order.map((line) => [line.id, line]))
  return lines.flatMap((line) => {
    const orderLine = orders.get(line.purchaseOrderLineId)
    return orderLine?.item.leather ? [{ id: line.id, orderSeq: orderLine.seq, uom: line.uom }] : []
  })
}

/** Replaces the notice's hides with the placed rows (seq per line in the list's order). */
async function writeHides(tools: CommandTools, notice: Pick<NoticeRow, 'id' | 'siteId' | 'partyId'>, hides: readonly PlacedHide[]): Promise<void> {
  await tools.tx.shipNoticeHide.deleteMany({ where: { shipNoticeId: notice.id } })
  const seqs = new Map<string, number>()
  for (const hide of hides) {
    const seq = (seqs.get(hide.lineId) ?? 0) + 1
    seqs.set(hide.lineId, seq)
    await tools.tx.shipNoticeHide.create({
      data: { id: newId(), siteId: notice.siteId, partyId: notice.partyId, shipNoticeId: notice.id, shipNoticeLineId: hide.lineId, seq, hideNumber: hide.hideNumber, area: hide.area, areaUom: hide.areaUom, grade: hide.grade, thicknessMm: hide.thicknessMm, dyeBatch: hide.dyeBatch, note: hide.note, createdAt: tools.now, updatedAt: tools.now },
      select: { id: true },
    })
  }
}

/** The placed rows as the checks read stored hides (nothing written). */
const asRows = (hides: readonly PlacedHide[]): NoticeHideRow[] => {
  const seqs = new Map<string, number>()
  return hides.map((hide) => {
    const seq = (seqs.get(hide.lineId) ?? 0) + 1
    seqs.set(hide.lineId, seq)
    return { id: `row-${hide.index}`, shipNoticeLineId: hide.lineId, seq, hideNumber: hide.hideNumber, area: new Dec(hide.area), areaUom: hide.areaUom, grade: hide.grade, thicknessMm: hide.thicknessMm === null ? null : new Dec(hide.thicknessMm), dyeBatch: hide.dyeBatch, note: hide.note } as unknown as NoticeHideRow
  })
}

async function savePackingList(app: FastifyInstance, request: FastifyRequest, session: PortalSession, notice: NoticeRow, version: number, hides: readonly PlacedHide[], via: 'HAND' | 'SHEET', idempotencyKey: string | undefined, input: unknown) {
  const person = personOf(session)
  await commandOn(app, request, { name: 'purchasing.shipNoticePackingList', idempotencyKey, input, record: { type: 'ShipNotice', id: notice.id, expectedVersion: version } }, async (tools) => {
    const current = await heldNotice(tools.tx, session, notice.id)
    assertEditable(current)
    await writeHides(tools, current, hides)
    tools.audit({
      action: 'purchasing.shipNoticePackingList',
      recordType: 'ShipNotice',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { byPartner: true, personId: person.id, byName: person.name, via, hides: hides.length, area: hides.reduce((sum, hide) => sum.plus(hide.area), new Dec(0)).toString() },
    })
    if (current.status === 'SENT') {
      tools.emit({ type: 'ship_notice.changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipNoticeId: current.id, number: current.number!, purchaseOrderId: current.purchaseOrderId, partyId: current.partyId, status: 'SENT', what: 'PACKING_LIST', expectedDate: dayOf(current.expectedDate) } })
    }
    return { id: current.id }
  })
}

async function packingContext(request: FastifyRequest, session: PortalSession, noticeId: string, now: Date) {
  const notice = await request.withClient((client) => heldNotice(client, session, noticeId))
  assertEditable(notice)
  const { lines } = await request.withClient((client) => readNoticeLines(client, notice.id))
  const { order, crVi } = await system(request, session).withClient(async (client) => {
    const db = client
    return { order: await orderLinesOf(db, notice.purchaseOrderId, notice.id), crVi: await crViEvidenceOf(db, notice.id, notice.partyId, todayAt(now)) }
  })
  return { notice, lines, order, crVi, leather: leatherLinesOf(lines, order) }
}

/** PUT /portal/ship-notices/:shipNoticeId/packing-list: the packing list typed by hand (replaces the list). */
export async function setPackingList(app: FastifyInstance, request: FastifyRequest, noticeId: string, body: { readonly version: number; readonly rows: readonly HideInput[] }, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const context = await packingContext(request, session, noticeId, now)
  const placed = placeHides(body.rows, context.leather)
  if (placed.issues.length > 0) throw new ValidationError(placed.issues.length === 1 ? placed.issues[0]!.message : `${placed.issues.length} problems in the packing list: each is named at its row.`, placed.issues)
  await savePackingList(app, request, session, context.notice, body.version, placed.hides, 'HAND', idempotencyKey, { noticeId, ...body })
  return pageOf(request, session, noticeId, now)
}

export interface SheetBody {
  readonly version: number
  readonly fileName: string
  /** The file, base64. */
  readonly content: string
  readonly numberFormat?: NumberFormat | undefined
  readonly sheetName?: string | null | undefined
  /** false: read and judge only (nothing kept); true: keep the list when every row reads. */
  readonly apply: boolean
}

export interface SheetRowAnswer {
  readonly rowNumber: number
  readonly hideNumber: string | null
  readonly line: number | null
  readonly area: string | null
  readonly unit: Uom | null
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly dyeBatch: string | null
  /** The row could not be read or placed: why, in words (nothing of the list is kept while any row has one). */
  readonly errors: { column: string | null; message: string }[]
  readonly verdict: Verdict | null
  readonly reasons: Reason[]
}

const contentTypeOf = (fileName: string): string => (/\.xlsx$/i.test(fileName) ? SHEET_TYPES.xlsx : SHEET_TYPES.csv)

/**
 * POST /portal/ship-notices/:shipNoticeId/packing-list/sheet: the tannery's sheet (CSV or Excel), read with the packing list
 * importer of the imports registry (its columns, Italian and English headers and numbers), placed on the notice's leather
 * lines and judged against the order row by row (design "ImportFlow inline: per-row verdicts before anything lands"). With
 * `apply` and no row in error, the list replaces the notice's packing list. The file itself is never stored.
 */
export async function readPackingSheet(app: FastifyInstance, request: FastifyRequest, noticeId: string, body: SheetBody, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const typeProblem = sheetTypeProblem(contentTypeOf(body.fileName), body.fileName)
  if (typeProblem) throw new ValidationError(typeProblem, [{ path: 'body/fileName', message: typeProblem }])
  const bytes = Buffer.from(body.content, 'base64')
  if (bytes.length === 0) throw new ValidationError('The file is empty.', [{ path: 'body/content', message: 'The file is empty.' }])
  if (bytes.length > SHEET_MAX_BYTES) throw new ValidationError(`The sheet is larger than ${Math.floor(SHEET_MAX_BYTES / 1024)} KB: split the delivery's list.`, [{ path: 'body/content', message: 'Too large.' }])
  const context = await packingContext(request, session, noticeId, now)
  let sheet
  try {
    sheet = await readSheet(bytes, { contentType: contentTypeOf(body.fileName), sheetName: body.sheetName ?? null, maxRows: SHIP_NOTICE_LIMITS.hides })
  } catch (error) {
    if (error instanceof SheetError) throw new ValidationError(error.message, error.issues.map((issue) => ({ ...issue, path: `body/${issue.path}` })))
    throw error
  }
  const mapping = mapHeaders(PORTAL_PACKING_LIST.columns, sheet.headers)
  if (mapping.issues.length > 0) throw new ValidationError(mapping.issues.map((issue) => issue.message).join(' '), mapping.issues.map((issue) => ({ ...issue, path: `body/headers/${issue.path}` })))
  const numberFormat: NumberFormat = body.numberFormat && (NUMBER_FORMATS as readonly string[]).includes(body.numberFormat) ? body.numberFormat : session.person.locale === 'en' ? 'en' : 'it'
  const parsed = sheet.rows.map((row) => parseRow(PORTAL_PACKING_LIST, mapping.columns, row, { numberFormat }))
  // Rows that read are placed on the lines together (each hide number once across them).
  const readable = parsed.filter((row) => row.errors.length === 0)
  const placed = placeHides(readable.map((row) => hideInputOf(row.values)), context.leather)
  const placeErrors = new Map<number, { column: string | null; message: string }[]>()
  for (const issue of placed.issues) {
    const match = /^body\/rows\/(\d+)\/?(\w+)?/.exec(issue.path)
    if (!match) continue
    const rowNumber = readable[Number(match[1])]!.rowNumber
    placeErrors.set(rowNumber, [...(placeErrors.get(rowNumber) ?? []), { column: match[2] ?? null, message: issue.message }])
  }
  const check = checkOf(context.order, context.lines, asRows(placed.hides), context.crVi)
  const verdictOf = new Map(placed.hides.map((hide, index) => [readable[hide.index]!.rowNumber, check.hides.find((row) => row.hideNumber === hide.hideNumber && row.lineId === hide.lineId) ?? check.hides[index]]))
  const rows: SheetRowAnswer[] = parsed.map((row) => {
    const values = hideInputOf(row.values)
    const errors = [...row.errors.map((issue) => ({ column: issue.column ?? null, message: issue.message })), ...(placeErrors.get(row.rowNumber) ?? [])]
    const verdict = errors.length === 0 ? verdictOf.get(row.rowNumber) : undefined
    return {
      rowNumber: row.rowNumber,
      hideNumber: values.hideNumber || null,
      line: values.line ?? null,
      area: values.area || null,
      unit: values.unit ?? null,
      grade: values.grade ?? null,
      thicknessMm: values.thicknessMm ?? null,
      dyeBatch: values.dyeBatch ?? null,
      errors,
      verdict: verdict?.verdict ?? null,
      reasons: [...(verdict?.reasons ?? [])],
    }
  })
  const unreadable = rows.filter((row) => row.errors.length > 0).length
  let applied = false
  if (body.apply && unreadable === 0) {
    await savePackingList(app, request, session, context.notice, body.version, placed.hides, 'SHEET', idempotencyKey, { noticeId, version: body.version, fileName: body.fileName, rows: rows.length })
    applied = true
  }
  return {
    fileName: body.fileName,
    format: sheet.format,
    sheet: sheet.sheet,
    numberFormat,
    columns: mapping.columns.map((entry) => entry.column),
    ignored: mapping.ignored.filter((entry) => entry.reason !== 'blank').map((entry) => entry.header),
    rows,
    unreadable,
    verdict: unreadable > 0 ? null : check.verdict,
    lines: check.lines.map((line) => ({ ...line, reasons: [...line.reasons] })),
    applied,
    page: applied ? await pageOf(request, session, noticeId, now) : null,
  }
}

/** GET /portal/ship-notices/template: the packing list's template (CSV or Excel), made-up example rows. */
export async function packingTemplate(request: FastifyRequest, query: { readonly format?: 'csv' | 'xlsx' | undefined; readonly numberFormat?: NumberFormat | undefined }) {
  const session = portalSessionOf(request)
  const numberFormat: NumberFormat = query.numberFormat ?? (session.person.locale === 'en' ? 'en' : 'it')
  const examples = [
    { hideNumber: '2231-001', area: '21.40', unit: 'FT2', line: '10', grade: 'A', thicknessMm: '1.20', dyeBatch: '2231' },
    { hideNumber: '2231-002', area: '19.85', unit: 'FT2', line: '10', grade: 'A', thicknessMm: '1.25', dyeBatch: '2231' },
  ]
  const template = importTemplate(PORTAL_PACKING_LIST, { numberFormat, grains: [], examples, formatted: false })
  return templateFile(template, query.format ?? 'xlsx')
}

// ---- send and cancel ---------------------------------------------------------------------------------------------------------

/**
 * POST /portal/ship-notices/:shipNoticeId/send: the draft checked (a line, its dates; the documents the move needs; a note
 * when something is not as ordered), numbered from the company's ASN series and SENT, in ONE command as the tenant's system
 * (the partner role holds no numbering grant). The answer is the page with the end state's words ("We expect it on …").
 */
export async function sendNotice(app: FastifyInstance, request: FastifyRequest, noticeId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const notice = await request.withClient((client) => heldNotice(client, session, noticeId))
  if (notice.status !== 'DRAFT') throw new InvalidStateError(notice.status === 'SENT' ? `Ship notice ${notice.number} was sent already.` : 'Only a draft is sent.')
  const person = personOf(session)
  const note = body.note === undefined ? notice.note : blankText(body.note)
  if (note !== null && note.length > SHIP_NOTICE_LIMITS.note) throw new ValidationError(`At most ${SHIP_NOTICE_LIMITS.note} characters.`, [{ path: 'body/note', message: `At most ${SHIP_NOTICE_LIMITS.note} characters.` }])
  const { result } = await commandOn(app, system(request, session), { name: 'purchasing.shipNoticeSend', idempotencyKey, input: { noticeId, ...body, by: person.id }, record: { type: 'ShipNotice', id: notice.id, expectedVersion: body.version } }, async (tools) => {
    const current = await readNotice(tools.tx, notice.id)
    if (!current || current.partyId !== session.partyId || current.companyId !== session.company.id) throw new NotFoundError('Ship notice not found.')
    if (current.status !== 'DRAFT') throw new InvalidStateError('Only a draft is sent.')
    const { lines, hides } = await readNoticeLines(tools.tx, current.id)
    const issues = sendProblems({ lines: lines.length, shipDate: dayOf(current.shipDate), expectedDate: dayOf(current.expectedDate) })
    const order = await orderLinesOf(tools.tx, current.purchaseOrderId, current.id)
    const orderRow = await tools.tx.purchaseOrder.findUnique({ where: { id: current.purchaseOrderId }, select: { number: true, status: true } })
    if (!orderRow || !isShippableOrder(orderRow.status)) throw new InvalidStateError(`Purchase order ${orderRow?.number ?? ''} no longer takes goods: ask the buyer.`)
    const ended = lines.filter((line) => order.find((entry) => entry.id === line.purchaseOrderLineId)?.ended)
    for (const line of ended) issues.push({ path: `body/lines/${line.seq}`, message: `Line ${line.seq}: the buyer ended this order line; take it off the notice.` })
    const today = todayAt(tools.now)
    const check = checkOf(order, lines, hides, await crViEvidenceOf(tools.tx, current.id, current.partyId, today))
    const needNote = differencesNeedNote(check, note)
    if (needNote) issues.push(needNote)
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The notice cannot be sent yet: each problem is named.', issues)
    // The documents the move needs (B-W2b-177): a BLOCK refuses it in words, a WARN goes with the answer.
    const documents = await assertRequiredDocuments(tools, { recordType: 'ShipNotice', recordId: current.id, toStatus: 'SENT', companyId: current.companyId })
    const issued = await allocateNumber(tools, { companyId: current.companyId, kind: 'ASN' }, { type: 'ShipNotice', id: current.id, date: today })
    await tools.tx.shipNotice.update({ where: { id: current.id }, data: { status: 'SENT', number: issued.formatted, sentAt: tools.now, note }, select: { id: true } })
    tools.audit({
      action: 'purchasing.shipNoticeSend',
      recordType: 'ShipNotice',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: 'DRAFT' },
      after: { status: 'SENT', number: issued.formatted, byPartner: true, personId: person.id, byName: person.name, verdict: check.verdict, counts: check.counts, lines: lines.length, hides: hides.length, note, warnings: documents.sentences },
    })
    tools.emit({
      type: 'ship_notice.sent',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { shipNoticeId: current.id, number: issued.formatted, purchaseOrderId: current.purchaseOrderId, partyId: current.partyId, status: 'SENT', shipDate: dayOf(current.shipDate)!, expectedDate: dayOf(current.expectedDate)!, lines: lines.length, hides: hides.length, verdict: check.verdict },
    })
    return { number: issued.formatted, warnings: documents.sentences, expectedDate: dayOf(current.expectedDate)! }
  })
  const page = await pageOf(request, session, notice.id, now)
  const site = page.site?.name ?? ''
  return {
    ...page,
    warnings: result.warnings,
    done: {
      it: `Consegna annunciata con ${result.number}. La aspettiamo il ${result.expectedDate} a ${site}.`,
      en: `Delivery announced as ${result.number}. We expect it on ${result.expectedDate} at ${site}.`,
    },
  }
}

/**
 * POST /portal/ship-notices/:shipNoticeId/cancel: before it is received (design "Cancel this ship notice? The lines become open
 * again."). A sent notice is CANCELLED with the reason (the supplier's own session may); a draft is simply removed.
 */
export async function cancelNotice(app: FastifyInstance, request: FastifyRequest, noticeId: string, body: { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey: string | undefined, now: Date) {
  const session = portalSessionOf(request)
  assertMayWrite(request, session)
  const notice = await request.withClient((client) => heldNotice(client, session, noticeId))
  assertEditable(notice)
  const reason = blankText(body.reason)
  if (notice.status === 'SENT' && !reason) throw new ValidationError('Say why the delivery is cancelled: our dock reads it.', [{ path: 'body/reason', message: 'Required.' }])
  if (reason && reason.length > SHIP_NOTICE_LIMITS.note) throw new ValidationError(`At most ${SHIP_NOTICE_LIMITS.note} characters.`, [{ path: 'body/reason', message: 'Too long.' }])
  const person = personOf(session)
  const { result } = await commandOn(app, request, { name: 'purchasing.shipNoticeCancel', idempotencyKey, input: { noticeId, ...body }, ...(notice.status === 'SENT' ? { record: { type: 'ShipNotice', id: notice.id, expectedVersion: body.version } } : {}) }, async (tools) => {
    const current = await heldNotice(tools.tx, session, notice.id)
    if (current.version !== body.version && current.status === 'DRAFT') throw new InvalidStateError('The draft changed since it was read: read it again.')
    assertEditable(current)
    const audit = { recordType: 'ShipNotice', recordId: current.id, companyId: current.companyId, siteId: current.siteId }
    if (current.status === 'DRAFT') {
      await tools.tx.shipNoticeHide.deleteMany({ where: { shipNoticeId: current.id } })
      await tools.tx.shipNoticeLine.deleteMany({ where: { shipNoticeId: current.id } })
      await tools.tx.shipNotice.delete({ where: { id: current.id }, select: { id: true } })
      tools.audit({ action: 'purchasing.shipNoticeDiscard', ...audit, before: { status: 'DRAFT' }, after: { removed: true, byPartner: true, personId: person.id, byName: person.name } })
      return { removed: true as const }
    }
    await tools.tx.shipNotice.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason }, select: { id: true } })
    tools.audit({ action: 'purchasing.shipNoticeCancel', ...audit, reason: reason!, before: { status: 'SENT' }, after: { status: 'CANCELLED', byPartner: true, personId: person.id, byName: person.name } })
    tools.emit({ type: 'ship_notice.cancelled', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipNoticeId: current.id, number: current.number!, purchaseOrderId: current.purchaseOrderId, partyId: current.partyId, status: 'CANCELLED' } })
    return { removed: false as const }
  })
  if (result.removed) return { removed: true, page: null }
  return { removed: false, page: await pageOf(request, session, notice.id, now) }
}
