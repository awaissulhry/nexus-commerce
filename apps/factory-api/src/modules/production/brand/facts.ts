import type { Prisma } from '@nexus/factory-db'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { riskOf, type RiskState } from '@nexus/factory-domain/planning/promise-keep/risk'
import { computedHealth, type BrandHealth } from '@nexus/factory-domain/production-brand/health'
import { orderStageOf, type LineStageFacts, type OrderStage } from '@nexus/factory-domain/production-brand/stages'
import { waitingOn, type Blocker, type Waiting } from '@nexus/factory-domain/production-brand/waiting'
import type { OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import { depositGate, type DepositStatus } from '@nexus/factory-domain/production/work-orders/release'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { SYSTEM_ACTOR_ID, type OfficeContext } from '../../../core/context'
import { promiseLinesOf, LINES_LIMIT } from '../../planning/promise-keep/lines'
import { dayOf, SITE_COLUMNS, type SiteRow } from '../../planning/store'
import { ORDER_DEPOSIT_ONLY } from '../../sales/deposits/deposits'
import { readStages, stageOfLine } from '../../sales/order-changes/stages'
import { readOrderFacts, type Reader } from '../../sales/orders/store'

/**
 * B-PR-17 (production plan §4 "5 plain stages", "Health", "Waiting on"; 08-backend §3 "Keeper"; review fixes R-21, R-31, R-35;
 * the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well."): the facts of ONE sales order in production, as its customer
 * reads them, from the order's OWN lines and their own cells only — the keeper (keeper.ts) writes them on the order's
 * BrandOrderProduction row; the customer's reads (B-PR-18) reuse `readOrderProductionFacts` for what the row does not keep
 * ("N lines ahead", "sewing not counted here", "Partly shipped"). Read in the tenant's system scope (the worker, the scheduler);
 * nothing here names a line, a work order, a worker, a site, a workshop, a supplier or another customer to the customer.
 *
 *   stage    factory-domain production-brand/stages over each goods line (SIZE_GRID, MADE_TO_MEASURE; a FEE is never made):
 *            `reached` = the furthest freeze stage of its cells (sales/order-changes/stages readStages: RELEASED < CUT < SEWING <
 *            FINISHED < SHIPPED), `allReleased` = every size still to ship is released by quality (the order's own READY rule,
 *            sales/orders orderProgress: released + closed short ≥ ordered), `done` = nothing left to make or ship (shipped in
 *            full, closed short), `sewingCounted` = a live work order of the line has a scanned operation at a SEWING work centre
 *            (the only place a SEWING signal comes from; none: "sewing not counted here"). The order = its slowest unfinished
 *            line, so on a partly shipped order its open lines decide (R-35) and read READY once all their cells are released.
 *   health   planning's promise-keep risk per open line (planning/promise-keep/lines promiseLinesOf: the promise against the
 *            day the plan says it is ready), read for THIS order's lines alone (`lineRisksOf`, per making site): the board's
 *            finish of its work orders, its planned orders, and the promise engine's earliest day for its pieces nothing makes
 *            yet asked for this order alone — so another customer's orders or urgency never move it (R-40, R-69), and the
 *            nightly run and an event read give the same answer. A line no plant plans (no site, several plants) or a
 *            planning read that fails falls back to its promise alone (riskOf with no finish: LATE once passed, AT_RISK while
 *            nothing says when, NO_DATE unpromised). A gate still waiting after its target day makes a better health AT_RISK.
 *   waiting  the order's blockers from real data (production-brand/waiting): the CUSTOMER (an open approval asked of it on the
 *            order or a sample round of its gates; an open portal task on the order; its unpaid deposit while nothing is
 *            released; its accepted pause = an ACTIVE BRAND hold), a SUPPLIER (a trims gate waiting; a work order the plan moves
 *            later for its material), a WORKSHOP (an operation out at a subcontractor), US (its request or reported problem
 *            waiting for our answer, a gate we own, a quality hold, our own production hold; B-PR-28: a new date it did not
 *            accept while the follow-up task is open). Customer-supplied material has no record yet (left out).
 *   held     a live work order of the order's lines is ON_HOLD (the customer's "On hold" mark; brand_production.hold_changed).
 */

/** The orders the keeper keeps: confirmed and not yet shipped in full (a partly shipped order with open work stays, R-35). */
export const KEEPER_ORDER_STATES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
export type KeeperOrderState = (typeof KEEPER_ORDER_STATES)[number]
export const isKeptState = (status: string): status is KeeperOrderState => (KEEPER_ORDER_STATES as readonly string[]).includes(status)

/** The lines a customer's stage reads: the goods (a FEE line is never made). */
export const GOODS_LINE_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const

/** Subcontract orders whose pieces are out at the workshop. */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

/** One open order line's planning risk, and whether the plan moves one of its work orders later for its material. */
export interface LineRisk {
  readonly risk: RiskState | null
  readonly materialLate: boolean
  /** From the line's promise alone (no plant plans it, or the planning read failed). */
  readonly promiseOnly: boolean
}

export interface OrderProductionFacts {
  readonly order: { readonly id: string; readonly companyId: string; readonly partyId: string; readonly number: string; readonly status: string }
  /** The order is one the keeper keeps (KEEPER_ORDER_STATES). */
  readonly kept: boolean
  /** The plain stage (its slowest unfinished line, how many lines are ahead, the next stage, "sewing not counted here"); null:
   * no goods line is open, the order left My production. */
  readonly stage: OrderStage | null
  /** The order is PARTLY_SHIPPED (the "Partly shipped" mark beside the stage). */
  readonly partlyShipped: boolean
  /** The computed health (null: nothing left to make); `undefined` when the read was asked without health. */
  readonly computed: BrandHealth | null | undefined
  readonly waiting: Waiting
  /** A live work order of the order's lines is ON_HOLD. */
  readonly held: boolean
  /** The risks came from the promise alone for at least one line (no plant plans it, or the planning read failed). */
  readonly promiseOnly: boolean
  /** The planning risk of each open goods line the health was computed from (empty: read without health). */
  readonly risks: ReadonlyMap<string, LineRisk>
}

export interface FactsOptions {
  /** Read the health too (planning's risk per line). Default true. */
  readonly health?: boolean
  /** The risks already read for these lines (the keeper's command reuses the read it planned with). */
  readonly risks?: ReadonlyMap<string, LineRisk>
}

/** The office context the planning read takes for its scope: every company, site and customer (the system reads them all). */
export function keeperPlanningContext(tenantId: string, requestId: string): OfficeContext {
  const every: Grant = { permissions: [ORDERS_VIEW], companies: 'all', sites: 'all', parties: 'all' }
  const context: OfficeContext = { audience: 'office', tenantId, actorId: SYSTEM_ACTOR_ID, requestId, grants: [every] }
  return Object.freeze(context)
}

interface RiskLine {
  readonly id: string
  readonly companyId: string
  readonly siteId: string | null
  /** The promise of the line, else of its order (the fallback's). */
  readonly promise: BusinessDate | null
  /** Pieces still to ship (the fallback's: 0 = no risk). */
  readonly open: number
}

/** The fallback: the line's promise alone (nothing says when it is ready). */
const promiseOnlyRisk = (line: RiskLine, today: BusinessDate): LineRisk => ({ risk: riskOf({ open: line.open, promise: line.promise, finish: null, today }), materialLate: false, promiseOnly: true })

/**
 * Planning's risk of each open line of ONE order (promise-keep, per making site: a line of no site belongs to its company's
 * only active plant), at most LINES_LIMIT lines per call. A line no site plans, or a site whose read fails, takes its promise
 * alone.
 */
async function lineRisksOf(db: Reader, context: OfficeContext, lines: readonly RiskLine[], now: Date): Promise<Map<string, LineRisk>> {
  const risks = new Map<string, LineRisk>()
  const open = lines.filter((line) => line.open > 0)
  if (open.length === 0) return risks
  const siteIds = [...new Set(open.flatMap((line) => (line.siteId ? [line.siteId] : [])))]
  const sites = new Map<string, SiteRow>((siteIds.length > 0 ? await db.site.findMany({ where: { id: { in: siteIds } }, select: SITE_COLUMNS }) : []).map((site) => [site.id, site]))
  const plantOf = new Map<string, SiteRow | null>()
  for (const companyId of new Set(open.filter((line) => line.siteId === null).map((line) => line.companyId))) {
    const plants = await db.site.findMany({ where: { companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 })
    plantOf.set(companyId, plants.length === 1 ? plants[0]! : null)
  }
  const bySite = new Map<string, { site: SiteRow; lines: RiskLine[] }>()
  for (const line of open) {
    const site = line.siteId ? (sites.get(line.siteId) ?? null) : (plantOf.get(line.companyId) ?? null)
    if (!site) continue
    const group = bySite.get(site.id) ?? { site, lines: [] }
    group.lines.push(line)
    bySite.set(site.id, group)
  }
  for (const { site, lines: ofSite } of bySite.values()) {
    for (let at = 0; at < ofSite.length; at += LINES_LIMIT) {
      const chunk = ofSite.slice(at, at + LINES_LIMIT)
      try {
        const read = await promiseLinesOf(db, context, site, now, { orderLineIds: chunk.map((line) => line.id), limit: LINES_LIMIT })
        for (const line of read.lines) {
          const materialLate = line.sizes.some((size) => size.open > 0 && size.workOrders.some((workOrder) => workOrder.delayDays > 0))
          risks.set(line.id, { risk: line.risk, materialLate, promiseOnly: false })
        }
      } catch {
        // The planning read failed (a site with no calendar, a broken plan): the lines take their promise alone below.
      }
    }
  }
  const today = businessDate(now)
  for (const line of open) {
    if (!risks.has(line.id)) risks.set(line.id, promiseOnlyRisk(line, today))
  }
  return risks
}

/** One size row of a line as the order's progress counts it (sales/orders orderProgress). */
export interface LineSizeRow {
  readonly ordered: number
  readonly released: number
  readonly closedShort: number
  readonly toShip: number
}

/**
 * One goods line's stage facts: done when nothing is left to ship of any size (shipped in full, closed short); all released
 * when every size still to ship is released by quality (the order's own READY rule) — so the open lines of a partly shipped
 * order read READY once all their cells are released (R-35).
 */
export function lineStageFactsOf(rows: readonly LineSizeRow[], reached: OrderFreezeStage | null, sewingCounted: boolean): LineStageFacts {
  const done = rows.length === 0 || rows.every((row) => row.toShip === 0)
  return { reached, allReleased: !done && rows.filter((row) => row.toShip > 0).every((row) => row.released + row.closedShort >= row.ordered), done, sewingCounted }
}

const ORDER_SELECT = { id: true, companyId: true, partyId: true, number: true, status: true, depositRequired: true, quoteVersionId: true } as const satisfies Prisma.SalesOrderSelect

/**
 * The facts of one order (null: no such order). `context` is the planning read's scope (keeperPlanningContext); `now` the
 * moment the facts are read at.
 */
export async function readOrderProductionFacts(db: Reader, context: OfficeContext, orderId: string, now: Date, options: FactsOptions = {}): Promise<OrderProductionFacts | null> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT })
  if (!order) return null
  const today = businessDate(now)
  const facts = await readOrderFacts(db, order)
  const goods = facts.lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind))
  const goodsIds = goods.map((line) => line.id)
  const rowsOf = (lineId: string) => facts.progress.rows.filter((row) => row.lineId === lineId)

  // The live work orders of the goods lines (not a REPAIR, not CANCELLED), per line.
  const cells = goodsIds.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: goodsIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { workOrderId: true, salesOrderLineId: true } }) : []
  const workOrderIds = [...new Set(cells.map((cell) => cell.workOrderId))]
  const workOrdersOf = (lineId: string) => new Set(cells.filter((cell) => cell.salesOrderLineId === lineId).map((cell) => cell.workOrderId))
  const workOrders = workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, status: true, releasedAt: true, heldAt: true, holdRecordType: true } }) : []
  const sewing = new Set(
    workOrderIds.length > 0
      ? (await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds }, scanRequired: true, workCentre: { kind: 'SEWING' } }, select: { workOrderId: true }, distinct: ['workOrderId'] })).map((row) => row.workOrderId)
      : [],
  )

  // ── the stage ──
  const stages = await readStages(db, goodsIds)
  const lineFacts: LineStageFacts[] = goods.map((line) => {
    const mine = workOrdersOf(line.id)
    return lineStageFactsOf(rowsOf(line.id), stageOfLine(stages, line.id).stage, mine.size === 0 || [...mine].some((id) => sewing.has(id)))
  })
  const stage = orderStageOf(lineFacts)
  const openLines = goods.filter((_, index) => !lineFacts[index]!.done)

  // ── the health ──
  let computed: BrandHealth | null | undefined
  let promiseOnly = false
  const used = new Map<string, LineRisk>()
  const gates = await db.orderGate.findMany({ where: { salesOrderId: order.id, passedAt: null, overriddenAt: null }, select: { kind: true, targetDate: true, sampleRoundId: true, createdAt: true } })
  let materialLate = false
  if (options.health !== false) {
    const wanted: RiskLine[] = openLines.map((line) => {
      const rows = rowsOf(line.id)
      return { id: line.id, companyId: order.companyId, siteId: line.siteId, promise: line.promiseDate ? dayOf(line.promiseDate) : null, open: rows.reduce((sum, row) => sum + row.toShip, 0) }
    })
    const known = options.risks
    const missing = wanted.filter((line) => !known?.has(line.id))
    // Given the risks (the keeper's command, inside its transaction), a line they lack takes its promise alone: no planning read
    // runs inside the transaction (a failed read there would abort it).
    const read =
      missing.length === 0
        ? new Map<string, LineRisk>()
        : known
          ? new Map((await withOrderPromise(db, order.id, missing)).map((line) => [line.id, promiseOnlyRisk(line, today)] as const))
          : await lineRisksOf(db, context, await withOrderPromise(db, order.id, missing), now)
    const riskOfLine = (lineId: string): LineRisk | undefined => known?.get(lineId) ?? read.get(lineId)
    for (const line of wanted) {
      const risk = riskOfLine(line.id)
      if (risk) used.set(line.id, risk)
    }
    promiseOnly = [...used.values()].some((risk) => risk.promiseOnly)
    materialLate = wanted.some((line) => riskOfLine(line.id)?.materialLate === true)
    const gateOverdue = gates.some((gate) => gate.targetDate !== null && dayOf(gate.targetDate) < today)
    computed = computedHealth({ lineRisks: wanted.map((line) => riskOfLine(line.id)?.risk ?? null), gateOverdue })
  }

  // ── what it waits on ──
  const blockers: Blocker[] = []
  const live = workOrders.filter((row) => row.status !== 'CANCELLED')
  const liveIds = live.map((row) => row.id)
  const roundApprovals = await roundApprovalIds(db, gates.flatMap((gate) => (gate.sampleRoundId ? [gate.sampleRoundId] : [])))
  const approvals = await db.approvalRequest.findMany({
    where: { partyId: order.partyId, status: 'OPEN', OR: [{ recordType: 'SalesOrder', recordId: order.id }, ...(roundApprovals.length > 0 ? [{ id: { in: roundApprovals } }] : [])] },
    select: { createdAt: true },
  })
  for (const row of approvals) blockers.push({ kind: 'APPROVAL', since: row.createdAt })
  const tasks = await db.partnerTask.findMany({ where: { partyId: order.partyId, status: 'OPEN', recordType: 'SalesOrder', recordId: order.id }, select: { createdAt: true } })
  for (const row of tasks) blockers.push({ kind: 'PARTNER_TASK', since: row.createdAt })
  if (order.depositRequired && !live.some((row) => row.releasedAt !== null)) {
    const deposits = await db.depositRequest.findMany({
      where: { AND: [{ OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ orderId: null, quoteVersionId: order.quoteVersionId }] : [])] }, ORDER_DEPOSIT_ONLY] },
      select: { status: true, dueDate: true, createdAt: true },
    })
    const gate = depositGate({ orderId: order.id, orderNumber: order.number, depositRequired: true, requests: deposits.map((row) => ({ status: row.status as DepositStatus, dueDate: dayOf(row.dueDate) })) })
    if (!gate.passed) {
      const open = deposits.filter((row) => row.status === 'OPEN').map((row) => row.createdAt.getTime())
      blockers.push({ kind: 'DEPOSIT', since: open.length > 0 ? new Date(Math.min(...open)) : null })
    }
  }
  const holds = liveIds.length > 0 ? await db.workOrderHold.findMany({ where: { workOrderId: { in: liveIds }, status: 'ACTIVE' }, select: { workOrderId: true, kind: true, placedAt: true } }) : []
  for (const hold of holds) blockers.push({ kind: hold.kind === 'BRAND' ? 'BRAND_PAUSE' : 'NO_MOVE', since: hold.placedAt })
  // A work order held by quality (or a nonconformance): not one only our plain holds hold.
  for (const row of live) if (row.status === 'ON_HOLD' && row.holdRecordType !== 'WorkOrderHold') blockers.push({ kind: 'QUALITY_HOLD', since: row.heldAt })
  for (const gate of gates) blockers.push({ kind: gate.kind === 'TRIMS_IN' ? 'MATERIAL_SHORT' : 'GATE', since: gate.createdAt })
  if (materialLate) blockers.push({ kind: 'MATERIAL_SHORT', since: null })
  const outside = liveIds.length > 0 ? await db.subcontractOrder.findMany({ where: { workOrderId: { in: liveIds }, status: { in: [...AT_WORKSHOP] } }, select: { issuedAt: true } }) : []
  for (const row of outside) blockers.push({ kind: 'SUBCONTRACT', since: row.issuedAt })
  const requests = await db.orderChangeRequest.findMany({ where: { orderId: order.id, status: 'OPEN' }, select: { createdAt: true } })
  for (const row of requests) blockers.push({ kind: 'BRAND_REQUEST', since: row.createdAt })
  // B-PR-26: a request we countered waits on the customer while our counter-offer is open (an approval), and on us again once
  // they said yes (we accept it to carry it out) or the counter lapsed (we answer it); a no withdraws it.
  const countered = await db.orderChangeRequest.findMany({ where: { orderId: order.id, status: 'COUNTERED' }, select: { counterApprovalId: true, counteredAt: true } })
  const counterIds = countered.flatMap((row) => (row.counterApprovalId ? [row.counterApprovalId] : []))
  const counters = new Map((counterIds.length > 0 ? await db.approvalRequest.findMany({ where: { id: { in: counterIds } }, select: { id: true, status: true, answeredAt: true, updatedAt: true } }) : []).map((row) => [row.id, row]))
  for (const row of countered) {
    const counter = row.counterApprovalId ? counters.get(row.counterApprovalId) : undefined
    if (counter?.status === 'OPEN') blockers.push({ kind: 'APPROVAL', since: row.counteredAt })
    else if (counter?.status !== 'REFUSED') blockers.push({ kind: 'BRAND_REQUEST', since: counter?.answeredAt ?? counter?.updatedAt ?? row.counteredAt })
  }
  const reported = await db.productionIssue.findMany({ where: { salesOrderId: order.id, status: 'OPEN', source: 'BRAND' }, select: { raisedAt: true } })
  for (const row of reported) blockers.push({ kind: 'BRAND_REQUEST', since: row.raisedAt })
  // B-PR-28: a new date the customer did not accept waits for us while its follow-up task is open (the task's id is the
  // request's; the date stands: planning/promise-keep/brand-answer).
  const refusedDates = await db.approvalRequest.findMany({ where: { partyId: order.partyId, kind: 'REPROMISE', recordType: 'SalesOrder', recordId: order.id, status: 'REFUSED', reversedAt: null }, select: { id: true, answeredAt: true } })
  if (refusedDates.length > 0) {
    const followUps = new Set((await db.task.findMany({ where: { id: { in: refusedDates.map((row) => row.id) }, status: 'OPEN' }, select: { id: true } })).map((task) => task.id))
    for (const row of refusedDates) if (followUps.has(row.id)) blockers.push({ kind: 'BRAND_REQUEST', since: row.answeredAt })
  }

  return {
    order: { id: order.id, companyId: order.companyId, partyId: order.partyId, number: order.number, status: order.status },
    kept: isKeptState(order.status),
    stage,
    partlyShipped: order.status === 'PARTLY_SHIPPED',
    computed,
    waiting: waitingOn(blockers),
    held: live.some((row) => row.status === 'ON_HOLD'),
    promiseOnly,
    risks: used,
  }
}

/** The lines with the order's promise where the line has none (the fallback's promise). */
async function withOrderPromise(db: Reader, orderId: string, lines: readonly RiskLine[]): Promise<RiskLine[]> {
  if (lines.every((line) => line.promise !== null)) return [...lines]
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { promiseDate: true } })
  const promise = order?.promiseDate ? dayOf(order.promiseDate) : null
  return lines.map((line) => (line.promise === null ? { ...line, promise } : line))
}

/** The approval requests of the sample rounds the order's gates wait for. */
async function roundApprovalIds(db: Reader, roundIds: readonly string[]): Promise<string[]> {
  if (roundIds.length === 0) return []
  const rounds = await db.sampleRound.findMany({ where: { id: { in: [...new Set(roundIds)] }, approvalRequestId: { not: null } }, select: { approvalRequestId: true } })
  return rounds.flatMap((round) => (round.approvalRequestId ? [round.approvalRequestId] : []))
}

/** The sales orders whose lines a work order's cells make (a legacy mixed work order: orders of several customers). */
export async function ordersOfWorkOrders(db: Reader, workOrderIds: readonly string[]): Promise<string[]> {
  if (workOrderIds.length === 0) return []
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: [...new Set(workOrderIds)] }, salesOrderLineId: { not: null } }, select: { salesOrderLineId: true } })
  const lineIds = [...new Set(cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])))]
  if (lineIds.length === 0) return []
  const lines = await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { orderId: true } })
  return [...new Set(lines.map((line) => line.orderId))].sort()
}

/** The sales orders of a work order cell's line. */
export async function orderOfCell(db: Reader, workOrderSizeId: string): Promise<string[]> {
  const cell = await db.workOrderSize.findUnique({ where: { id: workOrderSizeId }, select: { salesOrderLine: { select: { orderId: true } } } })
  return cell?.salesOrderLine ? [cell.salesOrderLine.orderId] : []
}
