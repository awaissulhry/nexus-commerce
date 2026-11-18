import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
// B-PR-46a: the partner read of many orders at once.
import type { FastifyRequest } from 'fastify'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { PortalReader } from '../../sales/portal-orders/access'
import type { ProductionShareLevel } from '@nexus/factory-domain/production-brand/levels'
import {
  answeredInOf,
  brandGateStateOf,
  isBrandGate,
  PAUSED_WORDS,
  plannedDatesOf,
  swatchStateOf,
  type ApprovalState,
  type BrandGate,
  type BrandHoldRead,
  type PlannedDates,
  type ReportedProblem,
} from '@nexus/factory-domain/production-brand/portal-read'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { reasonWords } from '../../../platform/reasons/service'
import { dayOf, type PortalLine } from '../../sales/portal-orders/store'
import { GOODS_LINE_KINDS, KEEPER_ORDER_STATES } from '../brand/facts'

/**
 * B-PR-18: the reads behind the customer's production pages, in two kinds never mixed in one query (the portal-orders pattern,
 * modules/sales/portal-orders/store.ts):
 *
 *   the PARTNER's own (the session's party scope, factory_partner_runtime, row-level security by party), FIRST: its orders in
 *   production in the portal's company, their production state (BrandOrderProduction: only the columns the partner role reads —
 *   never the office's note on a raise, who raised it, who set or locked an urgency, the supervisor or since when), its lines,
 *   its open requests, its swatches and their approvals. Another customer's order is never found here.
 *
 *   the TENANT's (the office scope, read as the person), only AFTER the partner read and keyed by exactly the order ids it
 *   returned and the customer's own party: its PortalSettings (level, urgency switch, quota), the problems it reported
 *   (ProductionIssue: office only, the partner role has no grant on it; R-65) and where we answered them, the work orders of its
 *   own lines and their holds, its gates, and its own work orders' slots in the PUBLISHED plan (Owner P3).
 *
 * Every figure is of the customer's own cells (a legacy work order that mixed customers gives it only its own cells); nothing
 * returned names a line, a lane, a load, a lot, a work order, a worker, a site, a workshop, an office person or another customer.
 */

// ---- the partner's own ------------------------------------------------------------------------------------------------------

export const BRAND_ORDER_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  number: true,
  customerRef: true,
  customerSeq: true,
  status: true,
  orderDate: true,
  promiseDate: true,
  originalPromiseDate: true,
  createdAt: true,
} as const satisfies Prisma.SalesOrderSelect
export type BrandOrderRow = Prisma.SalesOrderGetPayload<{ select: typeof BRAND_ORDER_SELECT }>

/** The columns of BrandOrderProduction the partner role reads (ownership brand-production.json: never a hidden one). */
export const PARTNER_PRODUCTION_SELECT = {
  salesOrderId: true,
  partyId: true,
  stage: true,
  stageAt: true,
  health: true,
  healthSet: true,
  healthReasonCode: true,
  healthSetUntil: true,
  waitingOn: true,
  waitingSince: true,
  urgency: true,
  urgentRank: true,
  urgencySetBy: true,
  urgencyLocked: true,
  urgencyLockReason: true,
} as const satisfies Prisma.BrandOrderProductionSelect
export type PartnerProductionRow = Prisma.BrandOrderProductionGetPayload<{ select: typeof PARTNER_PRODUCTION_SELECT }>

/** The party's orders in production in the portal's company (row-level security keeps them the party's): every one, no cut. */
export const readProductionOrders = (db: FactoryClient, companyId: string): Promise<BrandOrderRow[]> =>
  db.salesOrder.findMany({ where: { companyId, status: { in: [...KEEPER_ORDER_STATES] } }, select: BRAND_ORDER_SELECT, orderBy: [{ orderDate: 'asc' }, { createdAt: 'asc' }, { number: 'asc' }] })

/** The production state of these orders, by order (the party's own rows only). */
export async function readProductionRows(db: FactoryClient, orderIds: readonly string[]): Promise<Map<string, PartnerProductionRow>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.brandOrderProduction.findMany({ where: { salesOrderId: { in: [...orderIds] } }, select: PARTNER_PRODUCTION_SELECT })
  return new Map(rows.map((row) => [row.salesOrderId, row]))
}

/** The kinds of the requests still open on each order (a change, a cancel, an "Urgent – asked" …). */
export async function readOpenRequests(db: FactoryClient, orderIds: readonly string[]): Promise<Map<string, Set<string>>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.orderChangeRequest.findMany({ where: { orderId: { in: [...orderIds] }, status: 'OPEN' }, select: { orderId: true, kind: true } })
  const open = new Map<string, Set<string>>()
  for (const row of rows) open.set(row.orderId, (open.get(row.orderId) ?? new Set<string>()).add(row.kind))
  return open
}

/** Its own orders among these ids (the order a problem was answered in), as it names them. */
export async function readOwnOrderNames(db: FactoryClient, orderIds: readonly string[]) {
  if (orderIds.length === 0) return new Map<string, { id: string; number: string; customerRef: string | null; customerSeq: number | null }>()
  const rows = await db.salesOrder.findMany({ where: { id: { in: [...orderIds] } }, select: { id: true, number: true, customerRef: true, customerSeq: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export interface SwatchAnswer {
  readonly kind: string
  readonly state: ApprovalState
  readonly sentOn: BusinessDate | null
  readonly answeredOn: BusinessDate | null
}

/** Its sent swatches of these styles (colour, leather …) with their answers: approvals, not gates. */
export async function readSwatchAnswers(db: FactoryClient, styleIds: readonly string[]): Promise<SwatchAnswer[]> {
  if (styleIds.length === 0) return []
  const swatches = await db.sampleSwatch.findMany({
    where: { styleId: { in: [...styleIds] }, sentAt: { not: null } },
    select: { kind: true, sentAt: true, approvalRequestId: true, decision: true, decidedAt: true },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
  })
  const requestIds = swatches.flatMap((swatch) => (swatch.approvalRequestId ? [swatch.approvalRequestId] : []))
  const requests = requestIds.length > 0 ? await db.approvalRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, status: true, answeredAt: true } }) : []
  const requestOf = new Map(requests.map((row) => [row.id, row]))
  return swatches.flatMap((swatch) => {
    const request = swatch.approvalRequestId ? requestOf.get(swatch.approvalRequestId) : undefined
    const state = swatchStateOf({ decision: swatch.decision, requestStatus: request?.status ?? null })
    if (state === null) return []
    const answeredAt = swatch.decidedAt ?? request?.answeredAt ?? null
    return [{ kind: swatch.kind as string, state, sentOn: swatch.sentAt ? businessDate(swatch.sentAt) : null, answeredOn: state === 'WAITING_YOU' || answeredAt === null ? null : businessDate(answeredAt) }]
  })
}

// ---- the tenant's (office scope, after the partner read, keyed by its order ids and its party) ----------------------------

export interface ProductionSettings {
  readonly level: ProductionShareLevel
  readonly urgencyOn: boolean
  readonly urgentMax: number
}

/** The customer's limits (PortalSettings, office only): no row → Status only, urgency off. */
export async function readProductionSettings(db: FactoryClient, partyId: string): Promise<ProductionSettings> {
  const row = await db.portalSettings.findUnique({ where: { id: partyId }, select: { partyId: true, productionLevel: true, productionUrgencyOn: true, productionUrgentMax: true } })
  if (!row || row.partyId !== partyId) return { level: 'STATUS', urgencyOn: false, urgentMax: 0 }
  return { level: row.productionLevel, urgencyOn: row.productionUrgencyOn, urgentMax: row.productionUrgentMax }
}

/**
 * The problems the customer reported on these orders (ProductionIssue, source BRAND, its own party), each with the order whose
 * thread holds our answer (R-42, R-43): the first shared message of the office after it was raised in its own order's thread,
 * else in another order's thread of its batch (a batch is one customer's).
 */
export async function readProblems(db: FactoryClient, partyId: string, orderIds: readonly string[]): Promise<ReportedProblem[]> {
  if (orderIds.length === 0) return []
  const issues = await db.productionIssue.findMany({
    where: { partyId, source: 'BRAND', salesOrderId: { in: [...orderIds] }, status: { in: ['OPEN', 'ANSWERED'] } },
    select: { salesOrderId: true, partyId: true, status: true, raisedAt: true, answeredAt: true, batchId: true },
    orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
  })
  const answered = issues.filter((issue) => issue.status === 'ANSWERED' && issue.salesOrderId !== null)
  const batchIds = [...new Set(answered.flatMap((issue) => (issue.batchId ? [issue.batchId] : [])))]
  const siblings = batchIds.length > 0 ? await db.productionIssue.findMany({ where: { partyId, source: 'BRAND', batchId: { in: batchIds }, salesOrderId: { not: null } }, select: { batchId: true, salesOrderId: true } }) : []
  const batchOrders = new Map<string, string[]>()
  for (const sibling of siblings) if (sibling.batchId && sibling.salesOrderId) batchOrders.set(sibling.batchId, [...(batchOrders.get(sibling.batchId) ?? []), sibling.salesOrderId])
  const askedOrders = [...new Set([...answered.map((issue) => issue.salesOrderId!), ...siblings.flatMap((sibling) => (sibling.salesOrderId ? [sibling.salesOrderId] : []))])]
  const since = answered.reduce<Date | null>((least, issue) => (least === null || issue.raisedAt < least ? issue.raisedAt : least), null)
  const answers = since === null ? new Map<string, Date[]>() : await officeAnswers(db, partyId, askedOrders, since)
  return issues.flatMap((issue) => {
    if (issue.salesOrderId === null) return []
    const problem = { orderId: issue.salesOrderId, raisedAt: issue.raisedAt, answeredAt: issue.answeredAt }
    return [
      {
        ...problem,
        partyId: issue.partyId,
        status: issue.status,
        answeredInOrderId: issue.status === 'ANSWERED' ? answeredInOf(problem, issue.batchId ? (batchOrders.get(issue.batchId) ?? []) : [], answers) : null,
      },
    ]
  })
}

/** Per order, when the office wrote to the customer in the order's thread (shared, sent, by a person) since `since`. */
async function officeAnswers(db: FactoryClient, partyId: string, orderIds: readonly string[], since: Date): Promise<Map<string, Date[]>> {
  if (orderIds.length === 0) return new Map()
  const threads = await db.thread.findMany({ where: { recordType: 'SalesOrder', recordId: { in: [...orderIds] }, partyId }, select: { id: true, recordId: true } })
  if (threads.length === 0) return new Map()
  const orderOf = new Map(threads.map((thread) => [thread.id, thread.recordId]))
  const messages = await db.message.findMany({
    where: { threadId: { in: threads.map((thread) => thread.id) }, audience: 'PARTNER', direction: 'OUTBOUND', authorKind: 'USER', held: false, at: { gte: since } },
    select: { threadId: true, at: true },
  })
  const answers = new Map<string, Date[]>()
  for (const message of messages) {
    const orderId = orderOf.get(message.threadId)
    if (orderId) answers.set(orderId, [...(answers.get(orderId) ?? []), message.at])
  }
  return answers
}

export interface BrandHold {
  readonly kind: BrandHoldRead
  readonly since: BusinessDate
  readonly words: Words
}

export interface OrderWork {
  /** The live work orders of its goods lines (not a repair, not cancelled): a legacy mixed one included, for its own cells. */
  readonly workOrderIds: readonly string[]
  /** Its OWN work orders (WorkOrder.partyId = the customer): the published plan's dates come from them only (PW-P03). */
  readonly ownWorkOrderIds: readonly string[]
  readonly onHold: boolean
  readonly paused: boolean
  /** What holds its work, in plain words (with `words: true`); the earliest of each. */
  readonly holds: readonly BrandHold[]
}

const NO_WORK: OrderWork = Object.freeze({ workOrderIds: [], ownWorkOrderIds: [], onHold: false, paused: false, holds: [] })
// B-PR-19: exported for the quality read (./quality.ts), the same fallback words.
export const QUALITY_HOLD_WORDS: Words = Object.freeze({ it: 'Controllo qualità', en: 'Quality check' })
export const PRODUCTION_HOLD_WORDS: Words = Object.freeze({ it: 'Fermo di produzione', en: 'Production hold' })

/**
 * The work of these lines' orders and what holds it: a work order ON_HOLD (the "On hold" mark), its own accepted pause (an ACTIVE
 * BRAND hold: "Paused at your request"), and with `words` each hold in plain words — a quality hold by its reason's words, our
 * production hold by the words meant for the customer when the work order is its own (else the reason's words), its pause in
 * its words. Never the office's note, never who placed it.
 */
export async function readWork(db: FactoryClient, partyId: string, lines: readonly PortalLine[], options: { readonly words: boolean }): Promise<Map<string, OrderWork>> {
  const goods = lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind))
  if (goods.length === 0) return new Map()
  const orderOfLine = new Map(goods.map((line) => [line.id, line.orderId]))
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: goods.map((line) => line.id) }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { workOrderId: true, salesOrderLineId: true } })
  if (cells.length === 0) return new Map()
  const ordersOf = new Map<string, Set<string>>()
  for (const cell of cells) {
    const orderId = cell.salesOrderLineId ? orderOfLine.get(cell.salesOrderLineId) : undefined
    if (orderId) ordersOf.set(cell.workOrderId, (ordersOf.get(cell.workOrderId) ?? new Set<string>()).add(orderId))
  }
  const workOrderIds = [...ordersOf.keys()]
  const workOrders = await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, status: true, partyId: true } })
  const plain = await db.workOrderHold.findMany({ where: { workOrderId: { in: workOrderIds }, status: 'ACTIVE' }, select: { workOrderId: true, kind: true, reasonCode: true, brandWords: true, partyId: true, placedAt: true } })
  const quality = await db.qualityHold.findMany({ where: { status: 'ACTIVE', subjectType: 'WorkOrder', subjectIds: { hasSome: workOrderIds } }, select: { subjectIds: true, reasonCode: true, placedAt: true } })
  const qualityWords = options.words && quality.length > 0 ? await reasonWords(db, 'HOLD') : new Map()
  const plainWords = options.words && plain.some((hold) => hold.kind === 'PRODUCTION') ? await reasonWords(db, 'PRODUCTION_HOLD') : new Map()
  const wordsOf = (fact: { labelIt: string; labelEn: string } | undefined, fallback: Words): Words => (fact ? { it: fact.labelIt, en: fact.labelEn } : fallback)

  const out = new Map<string, { workOrderIds: string[]; ownWorkOrderIds: string[]; onHold: boolean; paused: boolean; holds: Map<string, BrandHold> }>()
  const entryOf = (orderId: string) => {
    const known = out.get(orderId)
    if (known) return known
    const made = { workOrderIds: [] as string[], ownWorkOrderIds: [] as string[], onHold: false, paused: false, holds: new Map<string, BrandHold>() }
    out.set(orderId, made)
    return made
  }
  const addHold = (orderIds: Iterable<string>, hold: BrandHold) => {
    for (const orderId of orderIds) {
      const entry = entryOf(orderId)
      const key = `${hold.kind}|${hold.words.en}`
      const known = entry.holds.get(key)
      if (!known || hold.since < known.since) entry.holds.set(key, hold)
    }
  }
  for (const workOrder of workOrders) {
    for (const orderId of ordersOf.get(workOrder.id) ?? []) {
      const entry = entryOf(orderId)
      entry.workOrderIds.push(workOrder.id)
      if (workOrder.partyId === partyId) entry.ownWorkOrderIds.push(workOrder.id)
      if (workOrder.status === 'ON_HOLD') entry.onHold = true
    }
  }
  for (const hold of plain) {
    const orderIds = ordersOf.get(hold.workOrderId) ?? new Set<string>()
    if (hold.kind === 'BRAND') for (const orderId of orderIds) entryOf(orderId).paused = true
    if (!options.words) continue
    const since = businessDate(hold.placedAt)
    if (hold.kind === 'BRAND') addHold(orderIds, { kind: 'BRAND', since, words: PAUSED_WORDS })
    else {
      // The words meant for the customer only on its own work order (a legacy mixed one reads the reason's words).
      const meant = hold.partyId === partyId ? hold.brandWords?.trim() : undefined
      addHold(orderIds, { kind: 'PRODUCTION', since, words: meant ? { it: meant, en: meant } : wordsOf(plainWords.get(hold.reasonCode), PRODUCTION_HOLD_WORDS) })
    }
  }
  if (options.words) {
    for (const hold of quality) {
      const orderIds = new Set(hold.subjectIds.flatMap((workOrderId) => [...(ordersOf.get(workOrderId) ?? [])]))
      addHold(orderIds, { kind: 'QUALITY', since: businessDate(hold.placedAt), words: wordsOf(qualityWords.get(hold.reasonCode), QUALITY_HOLD_WORDS) })
    }
  }
  return new Map(
    [...out].map(([orderId, entry]) => [
      orderId,
      { workOrderIds: entry.workOrderIds, ownWorkOrderIds: entry.ownWorkOrderIds, onHold: entry.onHold, paused: entry.paused, holds: [...entry.holds.values()].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)) },
    ]),
  )
}

/** An order's work, or none yet. */
export const workOf = (work: ReadonlyMap<string, OrderWork>, orderId: string): OrderWork => work.get(orderId) ?? NO_WORK

/**
 * The customer's real gates of these orders (OrderGate of its party; OTHER, a gate in the office's words, stays the office's):
 * waiting on it while the gate's sample round waits for its answer, else on us; passed or started before with the day.
 */
export async function readGates(db: FactoryClient, partyId: string, orderIds: readonly string[]): Promise<Map<string, BrandGate[]>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.orderGate.findMany({ where: { salesOrderId: { in: [...orderIds] }, partyId }, select: { salesOrderId: true, kind: true, targetDate: true, passedAt: true, overriddenAt: true, sampleRoundId: true } })
  const roundIds = [...new Set(rows.flatMap((row) => (row.sampleRoundId && row.passedAt === null && row.overriddenAt === null ? [row.sampleRoundId] : [])))]
  const rounds = roundIds.length > 0 ? await db.sampleRound.findMany({ where: { id: { in: roundIds }, approvalRequestId: { not: null } }, select: { id: true, approvalRequestId: true } }) : []
  const requestIds = rounds.flatMap((round) => (round.approvalRequestId ? [round.approvalRequestId] : []))
  const open = new Set(requestIds.length > 0 ? (await db.approvalRequest.findMany({ where: { id: { in: requestIds }, partyId, status: 'OPEN' }, select: { id: true } })).map((row) => row.id) : [])
  const roundOpen = new Set(rounds.filter((round) => round.approvalRequestId !== null && open.has(round.approvalRequestId)).map((round) => round.id))
  const gates = new Map<string, BrandGate[]>()
  for (const row of rows) {
    const kind: string = row.kind
    if (!isBrandGate(kind)) continue
    const done = row.passedAt ?? row.overriddenAt
    const gate: BrandGate = {
      kind,
      state: brandGateStateOf({ passedAt: row.passedAt, overriddenAt: row.overriddenAt, waitsOnYou: row.sampleRoundId !== null && roundOpen.has(row.sampleRoundId) }),
      targetDate: row.targetDate ? dayOf(row.targetDate) : null,
      doneOn: done ? businessDate(done) : null,
    }
    gates.set(row.salesOrderId, [...(gates.get(row.salesOrderId) ?? []), gate])
  }
  return gates
}

/**
 * The published plan's dates of each order's OWN work orders (Owner P3: the working plan never reaches a customer; PW-P03: never a
 * legacy mixed work order's slots): the slots of each site's newest published version, read as days only.
 */
export async function readPlanned(db: FactoryClient, ownWorkOrders: ReadonlyMap<string, readonly string[]>): Promise<Map<string, PlannedDates>> {
  const workOrderIds = [...new Set([...ownWorkOrders.values()].flat())]
  if (workOrderIds.length === 0) return new Map()
  const sites = [...new Set((await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { siteId: true } })).map((row) => row.siteId))]
  const versionIds: string[] = []
  for (const siteId of sites) {
    const version = await db.planVersion.findFirst({ where: { siteId, kind: 'PUBLISHED', publishedAt: { not: null } }, select: { id: true }, orderBy: { number: 'desc' } })
    if (version) versionIds.push(version.id)
  }
  if (versionIds.length === 0) return new Map()
  const slots = await db.scheduleSlot.findMany({
    where: { planVersionId: { in: versionIds }, planKind: 'PUBLISHED', workOrderId: { in: workOrderIds } },
    select: { workOrderId: true, startAt: true, endAt: true, operation: { select: { workCentre: { select: { kind: true } } } } },
  })
  const planned = new Map<string, PlannedDates>()
  for (const [orderId, ids] of ownWorkOrders) {
    const mine = new Set(ids)
    const own = slots.filter((slot) => mine.has(slot.workOrderId))
    if (own.length === 0) continue
    planned.set(orderId, plannedDatesOf(own.map((slot) => ({ centre: slot.operation?.workCentre.kind ?? null, start: businessDate(slot.startAt), end: businessDate(slot.endAt) }))))
  }
  return planned
}

// ── B-PR-46a: the partner read of many orders at once ───────────────────────────────────────────────────────────────────────────

/** One of the customer's own orders a bulk action names, where it stood in the body (results come back in the body's order). */
export interface OwnOrder {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly status: string
  readonly index: number
}

/**
 * The set form of sales/portal-orders/access partnerOrder (B-PR-46a; plan §2, L25 "each id checked with partnerOrder()"): the
 * customer's own orders among these ids, in the portal's company, read in the PARTNER scope (row-level security by party) and
 * checked once more against the session's party — another customer's order is as unknown as an id that names nothing. They come
 * back in the body's order; every other id is only counted (`notFound`), never named. Used by every bulk action of My production
 * (the urgency marks, Ask N, Report a problem's rule, B-PR-46b's Approve N and files).
 */
export async function partnerOrders(request: FastifyRequest, reader: PortalReader, orderIds: readonly string[]): Promise<{ readonly orders: OwnOrder[]; readonly notFound: number }> {
  const wanted = [...new Set(orderIds.filter((orderId) => isUuid(orderId)))]
  const rows =
    wanted.length === 0
      ? []
      : await request.withClient((client) =>
          client.salesOrder.findMany({ where: { id: { in: wanted }, companyId: reader.session.company.id }, select: { id: true, number: true, customerRef: true, status: true, partyId: true } }),
        )
  // The wall: only the session's party's (row-level security already keeps it so; checked again, fail closed).
  const byId = new Map(rows.filter((row) => row.partyId === reader.session.partyId).map((row) => [row.id, row]))
  const orders = orderIds.flatMap((orderId, index) => {
    const row = byId.get(orderId)
    return row ? [{ orderId, number: row.number, customerRef: row.customerRef, status: row.status as string, index }] : []
  })
  return { orders, notFound: orderIds.length - orders.length }
}
// ── end B-PR-46a ──
