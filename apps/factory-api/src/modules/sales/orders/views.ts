import type { MinorUnits } from '@nexus/factory-domain/core/money'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { cancelBlocksOf, cancelImpact, dailyActions } from '@nexus/factory-domain/sales/orders/daily'
import { CANCEL_STATUSES, daysLate, orderActions, type Progress, type SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { priceBasisOf, priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { Dec, HUNDRED } from '@nexus/factory-domain/tax/decimal'
import { serverClock } from '../../../core/time'
import { depositViewOf, DEPOSIT_COLUMNS } from '../deposits/deposits'
import { readCancelFacts } from './impact'
import { dayOf, dayOrNull, moveFactsOf, readOrderFacts, type OrderFacts, type OrderRow, type Reader } from './store'
// B-OP-023 (order page plan N5): each shipment's carrier, tracking, DDT and whether its number may be typed in place.
import { readShipmentDetails, type ShipmentDetails, type ShipmentLink } from './store'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { trackingPageOf } from '@nexus/factory-domain/shipping/labels/tracking'
import { trackingRefusal, type OwnTransportRefusalCode } from '@nexus/factory-domain/shipping/own-transport/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { isTestLabel } from '@nexus/factory-domain/shipping/test-mode/rules'
// B-SA-034 (Sales page plan P17): the order read names its own live watch list and who changed each part last.
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { LAST_CHANGE_PARTS, type LastChangePart, type OrderPagePart } from './contract'
// B-SA-035 (Sales page plan N2, N8): each line's picture and the artwork the reader may open.
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can } from '@nexus/factory-domain/core/permissions'
import { linePictureKey, type LinePictureFile } from '../../product/images/small-pictures'
import { artworkOf } from '../configurator/artwork'
// B-SA-035b: the made-to-measure line's rider, only under sales.measurements.view over the customer (never a measurement).
import type { Prisma } from '@nexus/factory-db'
import { holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
// B-OP-020 (order page plan N1): the order's open requests for a yes, by the approval engine's own list rule and row builder.
import { APPROVALS_VIEW } from '@nexus/factory-domain/approvals/permissions'
import { actorOf, type OfficeContext } from '../../../core/context'
import { approverRolesOf, customerWall, TASK_COLUMNS, visibleTasks, type TaskRow } from '../../../platform/approvals/store'
import { openTaskRows, type ViewContext } from '../../../platform/approvals/views'
// B-PT-011 (order production tab R11): a first promise or a move, and each line's day before a lines' move — one rule.
import { fromByLineOf, promiseMoveKindOf } from '@nexus/factory-domain/sales/orders/promise-moves'

/**
 * The order record as the office reads it (A2 SCR-039; the design's Order record): the header with its dates (the
 * first promise beside the promise now, days late), the lines with their size grids and per-size progress (ordered, in
 * work orders, made (null until the floor's scans), released, shipped, invoiced, to ship), the record chain (quote and
 * version → order → deposit requests → work orders → shipments → invoices), every promise change with who and why,
 * whether it is settled, and what may be done next. Prices are marked price, costs cost: the API drops what the
 * caller's grains do not reach.
 */

const text = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))
const instantOrNull = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

interface PromiseAudit {
  promiseDate?: unknown
  previous?: unknown
  lineIds?: unknown
  originalPromiseDate?: unknown
}

/**
 * Every promise change of the order, newest first (from its audit rows: who, when, from → to, which lines, why). B-PT-011: + its
 * kind — SET (the order's first promise: never counted as a move) or MOVED, by the production read's own rule — and, for a lines'
 * move, each line's own day before it (`fromByLine`; null: a move of the whole order).
 */
async function promiseHistory(db: Reader, orderId: string) {
  const rows = await db.auditLog.findMany({
    where: { recordType: 'SalesOrder', recordId: orderId, action: 'orders.changePromise' },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    select: { at: true, actorId: true, after: true, reason: true, /* B-PT-011 */ before: true },
  })
  return rows.map((row) => {
    const after = (row.after ?? {}) as PromiseAudit
    return {
      at: toUtcIso(row.at),
      actorId: row.actorId,
      from: typeof after.previous === 'string' ? after.previous : null,
      to: typeof after.promiseDate === 'string' ? after.promiseDate : '',
      lineIds: Array.isArray(after.lineIds) ? after.lineIds.filter((id): id is string => typeof id === 'string') : [],
      reason: row.reason,
      // ── B-PT-011 ──
      kind: promiseMoveKindOf(row.before),
      fromByLine: fromByLineOf(row.before),
      // ── end B-PT-011 ──
    }
  })
}

/** Margin % of the net (4 places, as the quotes write it), or null without a cost or a net. */
function marginPctOf(net: MinorUnits, cost: MinorUnits | null): string | null {
  if (cost === null || net === 0) return null
  const pct = new Dec(net - cost).times(HUNDRED).dividedBy(net).toDecimalPlaces(4, Dec.ROUND_HALF_UP)
  return pct.abs().gte(100_000) ? null : decimalText(pct)
}

/** Each request's payments placed on it (allocations less their reversals) and its latest DEPOSIT_INFO page. */
async function depositFacts(db: Reader, requestIds: readonly string[], now: Date) {
  if (requestIds.length === 0) return { paid: new Map<string, number>(), links: new Map<string, { sentAt: string; to: string | null; expiresAt: string; state: ReturnType<typeof linkState> }>() }
  const placed = await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: [...requestIds] } }, _sum: { amount: true } })
  const links = await db.oneOffLink.findMany({
    where: { purpose: 'DEPOSIT_INFO', recordType: 'DepositRequest', recordId: { in: [...requestIds] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { recordId: true, email: true, createdAt: true, expiresAt: true, revokedAt: true, uses: true, maxUses: true },
  })
  const latest = new Map<string, { sentAt: string; to: string | null; expiresAt: string; state: ReturnType<typeof linkState> }>()
  for (const link of links) {
    if (latest.has(link.recordId)) continue
    latest.set(link.recordId, { sentAt: toUtcIso(link.createdAt), to: link.email, expiresAt: toUtcIso(link.expiresAt), state: linkState(link, now) })
  }
  return { paid: new Map(placed.flatMap((row) => (row.depositRequestId ? [[row.depositRequestId, row._sum.amount ?? 0] as const] : []))), links: latest }
}

// ── B-SA-034 (Sales page plan P17; 13-backend B13b) ───────────────────────────────────────────────────────────────────────────
/**
 * The order page's live watch list, the server's (the portal pattern, production/brand-portal read.ts LIVE): each declared event
 * type the page listens to and the parts of the page it re-reads — so a new event (S4's work_order_change.*) joins the list here,
 * with no change in the browser. Matched by the order's own record ids (`live.ids`); party ids never reach the browser (the live
 * wall, factory-domain events/live.ts, already sends a person limited to some customers only their own customers' events).
 */
const LIVE_RULES: readonly { readonly match: (type: string) => boolean; readonly parts: readonly OrderPagePart[] }[] = [
  { match: (type) => ['sales_order.', 'order_change_request.', 'work_order_change.'].some((prefix) => type.startsWith(prefix)), parts: ['order', 'lines', 'changes'] },
  {
    match: (type) => ['brand_production.stage_reached', 'brand_production.health_changed', 'brand_production.hold_changed', 'brand_production.urgency_changed', 'brand_production.supervisor_changed'].includes(type),
    parts: ['headline', 'people'],
  },
  { match: (type) => type.startsWith('workorder.') || type.startsWith('work_order_hold.') || type === 'change_order.changed', parts: ['work', 'headline'] },
  // B-OO-008 (N8): a work order made, released, moved to a line, closed or cancelled changes "Where it's made" (People). The owner
  // of the order's conversation emits no event: the page re-reads People after its own change.
  { match: (type) => type.startsWith('workorder.'), parts: ['people'] },
  {
    match: (type) => ['production.cut_logged', 'production.cut_reversed', 'production.bundle_created', 'production.bundle_voided', 'production.bundle_split', 'production.scan_recorded', 'quality.garments_released', 'quality.release_reversed'].includes(type),
    parts: ['lines', 'headline'],
  },
  { match: (type) => type.startsWith('production_issue.'), parts: ['quality'] },
  { match: (type) => type.startsWith('order_promise.') || type === 'order_gate.changed', parts: ['dates'] },
  { match: (type) => ['shipment.', 'deposit_request.', 'payment.', 'invoice.'].some((prefix) => type.startsWith(prefix)), parts: ['money', 'shipments'] },
  { match: (type) => type === 'file.available', parts: ['files'] },
  // B-OP-020: a request for a yes of the order asked, decided, taken back or found changed (matched by `approvalTaskIds`, and a new
  // one by its record). These name no customer: only readers of every customer get them; a limited approver re-reads by sales_order.*.
  { match: (type) => type.startsWith('approval.') && type !== 'approval.rule_changed', parts: ['order', 'changes'] },
  // ── B-PT-017 (order production tab C3) ──
  // A promise moved: the Production tab's dates and the headline's "moved N×" re-read too (not only the order, lines and changes).
  { match: (type) => type === 'sales_order.promise_changed', parts: ['dates', 'headline'] },
  // A work order made, changed (its due day) or moved on: the dates' forecast re-reads. Office acts, never the floor's scans.
  { match: (type) => ['workorder.created', 'workorder.changed', 'workorder.status_changed'].includes(type), parts: ['dates'] },
  // The customer's own materials planned or counted again: the Production tab's Materials re-reads (its live fields: orderId, number).
  { match: (type) => type === 'customer_material.changed', parts: ['materials'] },
  // ── end B-PT-017 ──
  // ── B-OC-008 (order changes tab R4d; 13-backend §3): what moves the Changes tab's Waiting and Still to do ──
  // A yes we asked of the customer — on the order, on one of its revisions (an amendment: `changeIds`), our counter-offer (a request:
  // `requestIds`) — asked, answered, withdrawn, expired, decided for it or put back: the order (its wait for the yes), the headline
  // (the ONE waiting list) and the changes. Live only to readers with partners.approvals.view; others re-read on the next order event.
  { match: (type) => type.startsWith('approval_request.'), parts: ['order', 'headline', 'changes'] },
  // A production task done or changed on one of its work orders, a scrap posted or decided there (`workOrderIds`): Still to do.
  { match: (type) => ['task.completed', 'task.changed', 'production.scrap_posted', 'production.scrap_over_limit_decided'].includes(type), parts: ['changes'] },
  // A style change one of its DESIGN requests raised moved on (`styleChangeIds`): Still to do.
  { match: (type) => type === 'change_request.changed', parts: ['changes'] },
  // ── end B-OC-008 ──
]

/** Each declared event the order page re-reads on, with its parts (declared types only, sorted). */
export const ORDER_LIVE_EVENTS: readonly { readonly type: string; readonly parts: readonly OrderPagePart[] }[] = Object.freeze(
  EVENT_CATALOGUE.types().flatMap((type) => {
    const parts = [...new Set(LIVE_RULES.filter((rule) => rule.match(type)).flatMap((rule) => rule.parts))]
    return parts.length > 0 ? [{ type, parts }] : []
  }),
)

const FLOOR_WORDS: Words = Object.freeze({ it: 'Il reparto', en: 'The floor' })
const SYSTEM_WORDS: Words = Object.freeze({ it: 'Nexus', en: 'Nexus' })

/** The records each part's last change is read from (their audit rows). */
interface PartRecords {
  readonly order: readonly string[]
  readonly changes: readonly string[]
  readonly work: readonly string[]
  readonly shipments: readonly string[]
  readonly money: { readonly invoices: readonly string[]; readonly deposits: readonly string[] }
}

/**
 * The order's ids the page matches its live messages by, and who changed each part last — from the newest audit row: an office
 * person by name, the order's OWN customer by name, "the floor" (never a worker: Statuto dei Lavoratori art. 4) or "Nexus" (a job).
 * A row written by another partner (a workshop on a work order) is passed over: the answer names nobody else. Work orders: only
 * those the reader reaches (a work order of several customers, made before the rule, only for every-customer readers).
 */
async function liveOf(db: Reader, order: OrderRow, facts: OrderFacts, depositIds: readonly string[], viewer: Actor | null, approvalTaskIds: readonly string[] /* B-OP-020 */) {
  const workOrderIds = facts.workOrders.map((row) => row.id)
  const reach = viewer && workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds }, status: { not: 'CANCELLED' } }, select: { id: true, companyId: true, siteId: true, partyId: true }, orderBy: { id: 'asc' } }) : []
  const reachedWorkOrders = viewer ? reach.filter((row) => reachesWorkOrder(viewer, WORKORDERS_VIEW, row)).map((row) => row.id) : []
  const requests = await db.orderChangeRequest.findMany({ where: { orderId: order.id }, select: { id: true, /* B-OC-008 */ kind: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const requestIds = requests.map((row) => row.id)
  const changeIds = (await db.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { id: true }, orderBy: { revision: 'asc' } })).map((row) => row.id)
  // B-OC-008: the product change requests this order's DESIGN requests raised (their change_request.changed moves Still to do).
  const designIds = requests.filter((row) => row.kind === 'DESIGN').map((row) => row.id)
  const styleChangeIds = designIds.length > 0 ? (await db.changeRequest.findMany({ where: { orderChangeRequestId: { in: designIds } }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id) : []
  const ids = {
    workOrderIds: reachedWorkOrders,
    shipmentIds: facts.shipments.map((row) => row.id),
    invoiceIds: facts.invoices.map((row) => row.id),
    depositRequestIds: [...depositIds],
    requestIds,
    changeIds,
    approvalTaskIds: [...approvalTaskIds], // B-OP-020
    styleChangeIds, // B-OC-008
  }
  const records: PartRecords = { order: [order.id], changes: requestIds, work: reachedWorkOrders, shipments: ids.shipmentIds, money: { invoices: ids.invoiceIds, deposits: ids.depositRequestIds } }
  return { live: { events: ORDER_LIVE_EVENTS.map((entry) => ({ type: entry.type, parts: [...entry.parts] })), ids }, lastChange: await lastChangeOf(db, order, records) }
}

async function lastChangeOf(db: Reader, order: OrderRow, records: PartRecords) {
  const where = (part: LastChangePart): { recordType: string; recordId: { in: string[] } }[] => {
    switch (part) {
      case 'order':
        return [{ recordType: 'SalesOrder', recordId: { in: [...records.order] } }]
      case 'changes':
        return records.changes.length > 0 ? [{ recordType: 'OrderChangeRequest', recordId: { in: [...records.changes] } }] : []
      case 'work':
        return records.work.length > 0 ? [{ recordType: 'WorkOrder', recordId: { in: [...records.work] } }] : []
      case 'shipments':
        return records.shipments.length > 0 ? [{ recordType: 'Shipment', recordId: { in: [...records.shipments] } }] : []
      case 'money':
        return [
          ...(records.money.invoices.length > 0 ? [{ recordType: 'Invoice', recordId: { in: [...records.money.invoices] } }] : []),
          ...(records.money.deposits.length > 0 ? [{ recordType: 'DepositRequest', recordId: { in: [...records.money.deposits] } }] : []),
        ]
    }
  }
  // Only who may be named: the office, the floor, a job, or a partner of the order's own customer.
  const named = { OR: [{ audience: { in: ['OFFICE' as const, 'FLOOR' as const, 'SYSTEM' as const] } }, { audience: { in: ['PARTNER' as const, 'LINK' as const] }, partyId: order.partyId }] }
  const rows = new Map<LastChangePart, { audience: string; actorId: string; at: Date } | null>()
  for (const part of LAST_CHANGE_PARTS) {
    const of = where(part)
    rows.set(part, of.length === 0 ? null : await db.auditLog.findFirst({ where: { AND: [{ OR: of }, named] }, select: { audience: true, actorId: true, at: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] }))
  }
  const officeIds = [...new Set([...rows.values()].flatMap((row) => (row && row.audience === 'OFFICE' ? [row.actorId] : [])))]
  const people = new Map((officeIds.length > 0 ? await db.user.findMany({ where: { id: { in: officeIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
  const customer = [...rows.values()].some((row) => row && (row.audience === 'PARTNER' || row.audience === 'LINK')) ? await db.party.findUnique({ where: { id: order.partyId }, select: { legalName: true, tradeName: true } }) : null
  const customerName = customer ? (customer.tradeName ?? customer.legalName) : ''
  const byOf = (row: { audience: string; actorId: string }) => {
    if (row.audience === 'OFFICE') {
      const name = people.get(row.actorId) ?? ''
      return { kind: 'OFFICE' as const, name, words: { it: name, en: name } }
    }
    if (row.audience === 'PARTNER' || row.audience === 'LINK') return { kind: 'CUSTOMER' as const, name: customerName, words: { it: customerName, en: customerName } }
    if (row.audience === 'FLOOR') return { kind: 'FLOOR' as const, name: null, words: FLOOR_WORDS }
    return { kind: 'SYSTEM' as const, name: null, words: SYSTEM_WORDS }
  }
  const view = (part: LastChangePart) => {
    const row = rows.get(part)
    return row ? { by: byOf(row), at: toUtcIso(row.at) } : null
  }
  return { order: view('order'), changes: view('changes'), work: view('work'), shipments: view('shipments'), money: view('money') }
}
// ── end B-SA-034 ──

// ── B-SA-035 (Sales page plan N2, N8, picks P2, P13; 10-order-page §3 F2) ──────────────────────────────────────────────────────
/** A line's picture as the order read answers it: the file (files.read) and its small preview's address (null until made). */
export interface LinePicture {
  readonly fileId: string
  readonly contentType: string
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

/** B-SA-035b: one artwork file a line shows that the reader may open — what the thread's ONE viewer needs to show it. */
export interface LineArtwork {
  readonly fileId: string
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
}

/**
 * The artwork each line shows (its own and that of the quote line it was made from: configurator artworkOf) that the reader may
 * OPEN: AVAILABLE, and files.read over the file's company and the order's customer (the files' own record rule for a line of this
 * order). No reader (not an office read): none. B-SA-035b: the files themselves (newest first, each once), not only how many — the
 * Lines tab's artwork chip opens them in the thread's viewer.
 */
async function artworkFilesOf(db: Reader, order: OrderRow, lines: readonly { readonly id: string; readonly quoteLineId: string | null }[], viewer: Actor | null): Promise<Map<string, LineArtwork[]>> {
  const out = new Map<string, LineArtwork[]>()
  if (!viewer || lines.length === 0) return out
  const perLine = await Promise.all(lines.map(async (line) => ({ lineId: line.id, files: await artworkOf(db, { kind: 'ORDER', line: { id: line.id, quoteLineId: line.quoteLineId } }) })))
  const ids = [...new Set(perLine.flatMap((entry) => entry.files.filter((file) => file.status === 'AVAILABLE').map((file) => file.fileId)))]
  if (ids.length === 0) return out
  const companies = new Map((await db.storedFile.findMany({ where: { id: { in: ids }, status: 'AVAILABLE' }, select: { id: true, companyId: true } })).map((file) => [file.id, file.companyId]))
  const opens = (fileId: string) => companies.has(fileId) && can(viewer, FILES_READ, { companyId: companies.get(fileId) ?? null, partyId: order.partyId })
  for (const entry of perLine) {
    const seen = new Set<string>()
    const files: LineArtwork[] = []
    for (const file of entry.files) {
      if (seen.has(file.fileId) || !opens(file.fileId)) continue
      seen.add(file.fileId)
      files.push({ fileId: file.fileId, name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes })
    }
    out.set(entry.lineId, files)
  }
  return out
}

/** B-SA-035b: the rider a made-to-measure line is made for, as the profile names itself — never a measurement. */
export interface LineRider {
  readonly profileId: string
  readonly name: string
  readonly garmentType: string
  readonly revision: number
}

/**
 * The rider of each made-to-measure line's profile, only for a reader holding sales.measurements.view over the order's customer (the
 * rider data's own right, scoped by its party as the list's rider search is); without it nothing is read and the line says only
 * "Made to measure". The rider's name, the garment type and the profile's revision: never a measurement, a fit note or a photo.
 */
async function ridersOf(db: Reader, lines: readonly { readonly kind: string; readonly measurementProfileId: string | null }[], viewer: Actor | null): Promise<Map<string, LineRider>> {
  const out = new Map<string, LineRider>()
  const ids = [...new Set(lines.flatMap((line) => (line.kind === 'MADE_TO_MEASURE' && line.measurementProfileId ? [line.measurementProfileId] : [])))]
  if (!viewer || ids.length === 0 || !holds(viewer, SALES_MEASUREMENTS_VIEW)) return out
  const profiles = await db.measurementProfile.findMany({
    where: { AND: [scopeWhere(viewer, SALES_MEASUREMENTS_VIEW, { party: 'partyId' }) as Prisma.MeasurementProfileWhereInput, { id: { in: ids } }] },
    select: { id: true, riderName: true, garmentType: true, revision: true },
  })
  for (const profile of profiles) out.set(profile.id, { profileId: profile.id, name: profile.riderName, garmentType: profile.garmentType, revision: profile.revision })
  return out
}

/**
 * The lines' pictures put into an order read (after its database read: the small previews' addresses are presigned outside it,
 * one per distinct file — moves.ts recordAfter). A line without a picture the reader may open keeps `picture: null`.
 */
export function withLinePictures(view: OrderView, files: ReadonlyMap<string, LinePictureFile>, addresses: ReadonlyMap<string, { url: string; expiresAt: string }>): OrderView {
  return {
    ...view,
    lines: view.lines.map((line) => {
      const file = files.get(linePictureKey(line))
      return file ? { ...line, picture: { fileId: file.id, contentType: file.contentType, small: addresses.get(file.id) ?? null } } : line
    }),
  }
}
// ── end B-SA-035 ──

// ── B-OP-020 (order page plan N1; 13-backend §2; review R-22) ─────────────────────────────────────────────────────────────────
/** The kinds of request the order page decides: the order's own yes, an old change's yes (B-OP-010: never asked again), its credit hold. */
const ORDER_APPROVAL_KINDS = ['SALES_ORDER', 'SALES_ORDER_CHANGE', 'CREDIT_OVERRIDE'] as const

/**
 * The PENDING requests of the order, oldest first: on the order itself (SALES_ORDER, an old SALES_ORDER_CHANGE) and on its own
 * credit checks (CREDIT_OVERRIDE: a hold whose record is the order). Every one is the order's own.
 */
async function openApprovalTasksOf(db: Reader, orderId: string): Promise<TaskRow[]> {
  const checks = await db.creditCheck.findMany({ where: { recordType: 'SalesOrder', recordId: orderId }, select: { id: true } })
  return db.approvalTask.findMany({
    where: {
      status: 'PENDING',
      kind: { in: [...ORDER_APPROVAL_KINDS] },
      OR: [{ recordType: 'SalesOrder', recordId: orderId }, ...(checks.length > 0 ? [{ recordType: 'CreditCheck', recordId: { in: checks.map((check) => check.id) } }] : [])],
    },
    select: TASK_COLUMNS,
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  })
}

/**
 * The order's open requests as this reader may decide them on the order page: listed by the approval engine's own list rule
 * (approvals.view; asked by them, addressed to them, or of a kind they see; and the customer wall — GET /approvals/tasks's), each
 * row built by the engine (the yes never one's own: rule 42); the others counted, never named. No reader (no office read): none.
 */
async function openApprovalsOf(db: Reader, orderId: string, office: OfficeContext | null) {
  const tasks = await openApprovalTasksOf(db, orderId)
  const rows = office && tasks.length > 0 && holds(actorOf(office), APPROVALS_VIEW) ? await listedRows(db, tasks, office) : []
  return {
    openApprovals: rows.map((row) => ({
      taskId: row.id,
      kind: row.kind,
      kindLabel: row.kindLabel,
      requestedAt: row.requestedAt,
      requester: { name: row.requester.name, me: row.requester.me },
      approver: { kind: row.approver.kind, name: row.approver.name, me: row.approver.me },
      version: row.version,
      requireStepUp: row.requireStepUp,
      approve: row.approve,
      reject: row.reject,
      withdraw: row.withdraw,
    })),
    openApprovalsHidden: tasks.length - rows.length,
  }
}

/** The rows of the requests GET /approvals/tasks would list to this reader (its visibility and the customer wall), in their order. */
async function listedRows(db: Reader, tasks: readonly TaskRow[], office: OfficeContext) {
  const actor = actorOf(office)
  const now = serverClock.now()
  const view: ViewContext = { context: office, roles: await approverRolesOf(db, office.actorId, now), now }
  const listed = new Set(
    (await db.approvalTask.findMany({ where: { AND: [{ id: { in: tasks.map((task) => task.id) } }, visibleTasks(actor, office.actorId, view.roles), await customerWall(db, actor)] }, select: { id: true } })).map((row) => row.id),
  )
  return openTaskRows(db, tasks.filter((task) => listed.has(task.id)), view)
}
// ── end B-OP-020 ──

// ── B-OP-023 (order page plan N5; review R-7) ─────────────────────────────────────────────────────────────────────────────────
/** Typing a shipment's tracking number needs the right to manage shipments over its site. */
export const NO_TRACKING_RIGHT_WORDS = 'A warehouse person adds the tracking number: it needs the right to manage shipments.'

type MayTrack = { allowed: boolean; code: OwnTransportRefusalCode | 'NO_RIGHT' | null; why: string | null }
const NO_TRACKING_RIGHT: MayTrack = { allowed: false, code: 'NO_RIGHT', why: NO_TRACKING_RIGHT_WORDS }

/**
 * A shipment of the order as its Shipments tab shows it to this reader: how it travels, its expected delivery and live DDT for every
 * reader of the order; the carrier and its tracking only with shipping.view over its site (else withheld); and whether the reader
 * may type its tracking number here — the shipment's own refusal first (the warehouse's rule), then the right.
 */
function shipmentRowOf(link: ShipmentLink, details: ShipmentDetails, viewer: Actor | null) {
  // Read in the same client as the order's chain: every shipment of the chain is there.
  const row = details.shipments.get(link.id)!
  const place = { companyId: row.companyId, siteId: row.siteId }
  const sees = viewer !== null && can(viewer, SHIPPING_VIEW, place)
  const parcels = details.parcels.filter((parcel) => parcel.shipmentId === link.id)
  const labelled = parcels.filter((parcel) => parcel.trackingNumber !== null && !isTestLabel(parcel.carrierParcelId))
  const typed = row.manualTrackingNumber
  const tracking = !sees
    ? null
    : typed !== null
      ? { number: typed, source: 'TYPED' as const, parcels: [], live: false, /* F-OP-135: the link typed beside it (Track ›, https only) */ url: trackingPageOf(row.manualTrackingUrl) }
      : labelled.length > 0
        ? { number: null, source: 'PARCELS' as const, parcels: labelled.map((parcel) => ({ number: parcel.trackingNumber!, url: trackingPageOf(parcel.trackingUrl) })), live: true, url: null }
        : null
  const refusal = trackingRefusal({ status: row.status, transportBy: row.transportBy, manualTrackingNumber: typed, parcels: parcels.map((parcel) => ({ trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId })), liveDdts: 0 })
  const mayTypeTracking: MayTrack = !sees ? NO_TRACKING_RIGHT : refusal ? { allowed: false, code: refusal.code, why: refusal.message } : viewer !== null && can(viewer, SHIPPING_MANAGE, place) ? { allowed: true, code: null, why: null } : NO_TRACKING_RIGHT
  return {
    version: row.version,
    siteId: row.siteId,
    transportBy: row.transportBy,
    carrier: sees && (row.carrierCode !== null || row.carrierName !== null) ? { code: row.carrierCode, name: row.carrierName ?? carrierNameFor(row.transportBy, row.carrierCode) } : null,
    tracking,
    expectedDeliveryAt: row.expectedDeliveryAt ? toUtcIso(row.expectedDeliveryAt) : null,
    ddt: details.ddts.get(link.id) ?? null,
    mayTypeTracking,
    withheld: sees ? [] : ['shipments.detail' as const],
  }
}
// ── end B-OP-023 ──

export async function orderView(db: Reader, order: OrderRow, today: BusinessDate, settlement: SettlementAnswer, viewer: Actor | null = null /* B-SA-034 */, office: OfficeContext | null = null /* B-OP-020 */) {
  const facts = await readOrderFacts(db, order)
  const artwork = await artworkFilesOf(db, order, facts.lines, viewer) // B-SA-035 (B-SA-035b: the files, not only how many)
  const riders = await ridersOf(db, facts.lines, viewer) // B-SA-035b
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true } })
  const styleIds = [...new Set(facts.lines.map((line) => line.styleId))]
  const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, sizes: true } }) : []).map((row) => [row.id, row]))
  const colourwayIds = [...new Set(facts.lines.map((line) => line.colourwayId))]
  const colourways = new Map((colourwayIds.length > 0 ? await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const revisionIds = [...new Set(facts.lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const revisions = new Map((revisionIds.length > 0 ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } }) : []).map((row) => [row.id, row]))
  const version = order.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { id: true, quoteId: true, revision: true } }) : null
  const quote = version ? await db.quote.findUnique({ where: { id: version.quoteId }, select: { id: true, number: true } }) : null
  // ── B-OC-016 (order changes tab R12; 13-backend §5): the customer's portal order this order was made from (the threads' own
  // finder, platform/threads/summary.ts), and the customer's own portal person who sent it (never anyone else's name) ──
  const portalRequest = await db.portalOrderRequest.findFirst({ where: { salesOrderId: order.id, partyId: order.partyId }, select: { id: true, number: true, sentAt: true, sentById: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const portalSender = portalRequest?.sentById ? await db.user.findUnique({ where: { id: portalRequest.sentById }, select: { displayName: true, partyId: true } }) : null
  const portalOrder = portalRequest ? { id: portalRequest.id, number: portalRequest.number, sentAt: instantOrNull(portalRequest.sentAt), sentBy: portalSender && portalSender.partyId === order.partyId ? portalSender.displayName : null } : null
  // ── end B-OC-016 ──
  const deposits = await db.depositRequest.findMany({
    where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] },
    select: DEPOSIT_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const history = await promiseHistory(db, order.id)
  const placed = await depositFacts(db, deposits.map((row) => row.id), serverClock.now())
  // B-W2a-F2: which step of the schedule names each request (the deposit, or a before-shipping step's own).
  const stepKinds = new Map(
    (deposits.length > 0 ? await db.salesOrderMilestone.findMany({ where: { depositRequestId: { in: deposits.map((row) => row.id) } }, select: { depositRequestId: true, kind: true } }) : []).flatMap((row) =>
      row.depositRequestId && (row.kind === 'DEPOSIT' || row.kind === 'BEFORE_SHIPPING') ? [[row.depositRequestId, row.kind] as const] : [],
    ),
  )
  const peopleIds = [...new Set([order.createdById, ...history.map((entry) => entry.actorId), ...facts.lines.map((line) => line.closedShortById)].filter((id): id is string => id !== null))]
  const people = peopleIds.length > 0 ? await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true }, orderBy: { id: 'asc' } }) : []

  const progressOf = (lineId: string, size: string | null) => facts.progress.rows.find((row) => row.lineId === lineId && row.size === size)
  const strip = (row: Progress) => ({ ordered: row.ordered, inWorkOrders: row.inWorkOrders, made: row.made, released: row.released, shipped: row.shipped, invoiced: row.invoiced, toShip: row.toShip, closedShort: row.closedShort })
  // B-W2a-30: the amendments so far (the Changes tab reads them whole: GET …/amendments) and the daily actions.
  const amendments = await db.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true, createdAt: true }, orderBy: { revision: 'desc' } })
  // The cancel action is held by what the impact check says stops it (a shipment being packed, an invoice).
  const cancelBlocks = CANCEL_STATUSES.includes(order.status) ? cancelBlocksOf(cancelImpact(await readCancelFacts(db, order, facts))) : []
  const shortLines = facts.lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, shipped: facts.progress.lines.find((entry) => entry.lineId === line.id)?.shipped ?? 0, closedShort: line.closedShortQuantity !== null }))
  const promiseDate = dayOrNull(order.promiseDate)
  const approvals = await openApprovalsOf(db, order.id, office) // B-OP-020
  const shipmentDetails = await readShipmentDetails(db, facts.shipments.map((row) => row.id)) // B-OP-023

  return {
    id: order.id,
    number: order.number,
    companyId: order.companyId,
    partyId: order.partyId,
    party: party ? { code: party.code, legalName: party.legalName } : null,
    customerRef: order.customerRef,
    customerSeq: order.customerSeq ?? null, // B-SA-070b
    status: order.status,
    orderDate: dayOf(order.orderDate),
    currency: order.currency,
    language: order.language,
    taxMode: order.taxMode,
    priceBasis: priceBasisOf(order.taxMode),
    billTo: order.billTo as Record<string, unknown>,
    shipTo: order.shipTo as Record<string, unknown>,
    // B-OO-013: the Incoterm, its place and ship complete, read only (the office's Order facts; the portal's read has none).
    incoterm: order.incoterm,
    incotermPlace: order.incotermPlace,
    shipComplete: order.shipComplete,
    paymentTerms: order.paymentTerms,
    paymentTermsId: order.paymentTermsId,
    requestedDate: dayOrNull(order.requestedDate),
    promiseDate,
    originalPromiseDate: dayOrNull(order.originalPromiseDate),
    daysLate: daysLate(order.status, promiseDate, today),
    priority: order.priority,
    noWithdrawal: order.noWithdrawal,
    depositRequired: order.depositRequired,
    netAmount: asMoney('price', order.netAmount),
    vatAmount: asMoney('price', order.vatAmount),
    grossAmount: asMoney('price', order.grossAmount),
    costAmount: asMoney('cost', order.costAmount),
    marginPct: asMoney('margin', marginPctOf(order.netAmount, order.costAmount)),
    reapprovalNeededAt: instantOrNull(order.reapprovalNeededAt),
    cancelReason: order.cancelReason,
    closedAt: instantOrNull(order.closedAt),
    internalNote: order.internalNote,
    version: order.version,
    createdAt: toUtcIso(order.createdAt),
    updatedAt: toUtcIso(order.updatedAt),
    createdById: order.createdById,
    lines: facts.lines.map((line) => {
      const style = styles.get(line.styleId)
      const range = style?.sizes ?? []
      const place = (size: string) => (range.indexOf(size) === -1 ? range.length : range.indexOf(size))
      const sizes = [...line.sizes].sort((a, b) => place(a.size) - place(b.size) || a.size.localeCompare(b.size))
      const revision = line.styleRevisionId ? revisions.get(line.styleRevisionId) : undefined
      const colourway = colourways.get(line.colourwayId)
      const totals = facts.progress.lines.find((entry) => entry.lineId === line.id)!
      return {
        id: line.id,
        seq: line.seq,
        kind: line.kind,
        quoteLineId: line.quoteLineId,
        styleId: line.styleId,
        style: style ? { code: style.code, name: style.name } : null,
        styleRevisionId: line.styleRevisionId,
        styleRevision: revision ? { revision: revision.revision, status: revision.status } : null,
        colourwayId: line.colourwayId,
        colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
        measurementProfileId: line.measurementProfileId,
        baseSize: line.baseSize,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: asMoney('price', text(line.unitPrice)!),
        netAmount: asMoney('price', line.netAmount),
        vatRatePct: line.vatRatePct.toFixed(2),
        vatNature: line.vatNature,
        vatAmount: asMoney('price', line.vatAmount),
        unitCost: asMoney('cost', text(line.unitCost)),
        costAmount: asMoney('cost', line.costAmount),
        requestedDate: dayOrNull(line.requestedDate),
        promiseDate: dayOrNull(line.promiseDate),
        priority: line.priority,
        siteId: line.siteId,
        closedShort:
          line.closedShortQuantity === null
            ? null
            : { quantity: line.closedShortQuantity, at: instantOrNull(line.closedShortAt), byId: line.closedShortById, reason: line.closeShortReason, reasonCode: line.closedShortReasonCode },
        version: line.version,
        sizes:
          sizes.length > 0
            ? sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: asMoney('price', text(size.unitPrice)), progress: strip(progressOf(line.id, size.size)!) }))
            : [{ size: null, quantity: line.quantity, unitPrice: asMoney('price', null), progress: strip(progressOf(line.id, null)!) }],
        progress: strip(totals),
        // B-SA-035: the picture is put in after the read (withLinePictures); the artwork the reader may open, counted.
        picture: null as LinePicture | null,
        artworkCount: (artwork.get(line.id) ?? []).length,
        // B-SA-035b: the artwork files themselves (the chip opens them in the thread's viewer), and a made-to-measure line's rider.
        artwork: artwork.get(line.id) ?? [],
        rider: line.kind === 'MADE_TO_MEASURE' && line.measurementProfileId ? (riders.get(line.measurementProfileId) ?? null) : null,
      }
    }),
    progress: strip(facts.progress.totals),
    chain: {
      quote: quote && version ? { id: quote.id, number: quote.number, versionId: version.id, revision: version.revision } : null,
      portalOrder, // B-OC-016
      depositRequests: deposits.map((row) => {
        const view = depositViewOf(row)
        // The percentage as the database holds it ("30.0000" → "30"; deposits.ts's own text turns a whole "30" into "3").
        const depositPct = row.depositPct === null ? null : decimalText(row.depositPct.toString())
        return { ...view, depositPct, amount: asMoney('price', view.amount), paidAmount: asMoney('price', placed.paid.get(row.id) ?? 0), link: placed.links.get(row.id) ?? null, stepKind: stepKinds.get(row.id) ?? null, version: row.version }
      }),
      workOrders: facts.workOrders.map((row) => ({ id: row.id, number: row.number, status: row.status, siteId: row.siteId, releasedAt: instantOrNull(row.releasedAt) })),
      // B-OP-023: + each shipment's detail for this reader (carrier and tracking with shipping.view over its site).
      shipments: facts.shipments.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        shippedAt: instantOrNull(row.shippedAt),
        deliveredAt: instantOrNull(row.deliveredAt),
        ...shipmentRowOf(row, shipmentDetails, viewer),
        // ── B-OP-043 (order page N6): every order it carries, how it was made, the paper DDT of one made elsewhere ──
        orders: [...row.orders], // op-fx1: the contract's array (the store's is readonly)
        origin: row.origin,
        externalDdt: row.externalDdt ? { number: row.externalDdt.number, date: dayOf(row.externalDdt.date) } : null,
        // ── end B-OP-043 ──
      })),
      invoices: facts.invoices.map((row) => ({ id: row.id, number: row.number, docType: row.docType, status: row.status, issueDate: dayOrNull(row.issueDate), depositRequestId: row.depositRequestId })),
    },
    promiseHistory: history,
    people: people.map((user) => ({ id: user.id, name: user.displayName })),
    // B-OP-020 (B3): the words may name amounts (price grain); the codes reach every reader.
    settlement: { settled: settlement.settled, missing: settlement.missing.map((entry) => ({ code: entry.code, message: asMoney('price', entry.message) })), source: settlement.source },
    actions: orderActions(order.status, { ...moveFactsOf(facts, settlement), cancelBlocks }),
    dailyActions: dailyActions(order.status, shortLines),
    amendments: { count: amendments.length, latestRevision: amendments[0]?.revision ?? null, latestAt: amendments[0] ? toUtcIso(amendments[0].createdAt) : null },
    /** SAL-209: a confirmed order's lines change only through an amendment. */
    locked: true,
    // B-SA-034: the live watch list (the server's) and who changed each part last.
    ...(await liveOf(db, order, facts, deposits.map((row) => row.id), viewer, approvals.openApprovals.map((row) => row.taskId) /* B-OP-020 */)),
    // ── B-OP-020: the yes in place (F-OO-206, Owner D8: no badges — the web counts `chain` by the one rule, orderLinkCountsOf) ──
    openApprovals: approvals.openApprovals,
    openApprovalsHidden: approvals.openApprovalsHidden,
    // ── end B-OP-020 ──
  }
}

export type OrderView = Awaited<ReturnType<typeof orderView>>
