import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { effectiveHealth, type BrandHealth, type HealthRaise } from '@nexus/factory-domain/production-brand/health'
import { standingRaiseOf } from './production-columns' // B-SA-070
import { nextStageOf, type BrandStage } from '@nexus/factory-domain/production-brand/stages'
import type { BrandUrgency } from '@nexus/factory-domain/production-brand/urgency'
import { BLOCKER_OWNER, type Blocker, type BlockerKind, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { aheadWords, customerUrgencyChipWords, HEALTH_REASON_WORDS, HEALTH_WORDS, OFFICE_WAITING_WORDS, SEWING_NOT_COUNTED_WORDS, STAGE_WORDS, URGENCY_WORDS } from '@nexus/factory-domain/production-brand/words'
import { daysLate, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { OPEN_NCR_STAGES } from '@nexus/factory-domain/quality/ncr/rules'
import { PRIORITY_WORDS, type SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { PROGRESS_REFRESH_SECONDS } from '@nexus/factory-domain/sales/portal-orders/progress'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readWorld } from '../../planning/milestones/world'
import { LINES_LIMIT, promiseLinesOf } from '../../planning/promise-keep/lines'
import { SITE_COLUMNS, type SiteRow } from '../../planning/store'
import { GOODS_LINE_KINDS, readOrderProductionFacts } from '../../production/brand/facts'
import { countedUrgencyOf } from '../../production/brand/urgency-of'
import { readPlanned, readWork, workOf } from '../../production/brand-portal/access'
import { issueReadWhere, issuesOfOrderWhere, type OrderFilter } from '../../production/issues/list'
import { brandProductionKey, supervisorOfOrder } from '../../production/supervisor/resolver'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { ncrsOfOrderWhere } from '../../quality/ncr/reads'
import { ncrListWhere } from '../../quality/wall'
import { officeProgressFor, type CellCount } from '../portal-orders/progress'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import { PRODUCTION_PARTS, type ProductionPart, type WithheldKey } from './production-contract'
import { dayOf, dayOrNull, readLines, readOrderFacts, type LineRecord, type OrderRow } from './store'
// B-SA-043: the order's extra pieces (cut beyond what it now wants), office only.
import { madeExtraOf } from './made-extra'
// B-SA-050: Still to do, computed from the records.
import { stillToDoOf } from './still-to-do'

/**
 * B-SA-031 / B-SA-032 (Sales page plan P2, P3, P4, P15, P16; 13-backend B1, B12; 10-order-page OR1, OR2; review WP-3): the office's
 * read of ONE sales order's production, the office twin of the customer's `GET /portal/production/:orderId`, built from the
 * readers that answer the customer (reused, never copied): the facts of the order (production/brand facts: the plain stage,
 * "N lines ahead", "sewing not counted here", what it waits on), the keeper's stored state (health, its raise, waiting, the
 * customer's urgency, the supervisor), the counts of its OWN cells (portal-orders/progress readCellCounts, kept a minute under the
 * portal's own key), the holds in plain words (brand-portal readWork), the published plan's days (readPlanned), Time & action's
 * world under orders.view (planning/milestones readWorld: the gates, start and ship; no action), the issues and NCRs of the order
 * (B-SA-033's filters), and the supervisor resolver.
 *
 *   headline  the plain stage (since, ahead, sewing not counted), what is in work as counts (bundles; pieces between the steps),
 *             the health (its raise: the office's note and who raised it with workorders.view only), who it waits on and each
 *             blocker in words, the holds in words (their office notes with workorders.view), the promise and its slip, the
 *             three urgencies (the customer's own mark, the factory's rush, the office's priority)                  orders.view
 *   lines     per line and size the order's OWN pieces: ordered · cut (and bundled) · sewn · checked · packed · shipped orders.view
 *   work      the live work orders that make its lines, each with THIS order's share; "also makes" names only orders of this
 *             customer that the reader reaches (the rest of them counted); a work order made before the one-customer rule says
 *             "made together with other work" and a shared cut order "cut together with other work" — never another customer's
 *             name, number or count; made-to-measure units grouped per style × colourway; the work orders the reader does not
 *             reach counted ("1 work order not shown"), never named                                         workorders.view
 *   dates     the gates and milestones (read only), the published plan's days, the forecast per line   orders.view (+ planning.promise.view)
 *   quality   open issues (workorders.view), open NCRs behind the brand wall (quality.ncr.view), final inspections of the work
 *             orders the reader reaches (quality.inspections.view)
 *   people    the supervisor and where from, the customer's backup, who answers the customer (the order thread's owner), the
 *             places — a site and line (a team by name only), an outside workshop; never an operator, a count or an output
 *                                                                                                         workorders.view
 *   changes   the customer's requests still waiting; B-SA-050: Still to do after the accepted changes (./still-to-do: each row
 *             names the record that closes it, computed — never ticked)                                      orders.view
 *
 * About 35 indexed queries for every part; `?parts=` makes a live re-read 3–8. No planning engine runs for the health (the
 * keeper's stored row): the forecast is the only planning read, and only for a reader of promises. A read: no command, no event.
 */

type Db = FactoryClient

// ---- pure parts (unit-tested: ./production-read.vitest.test.ts) ----------------------------------------------------------------

/** The parts asked (`?parts=a,b`), in their own order; none: every part. An unknown name is refused in words. */
export function partsOf(text: string | undefined): ProductionPart[] {
  if (text === undefined) return [...PRODUCTION_PARTS]
  const asked = text.split(',').map((part) => part.trim()).filter((part) => part !== '')
  const unknown = asked.filter((part) => !(PRODUCTION_PARTS as readonly string[]).includes(part))
  if (asked.length === 0 || unknown.length > 0) {
    throw new ValidationError("Not a part of the order's production.", [{ path: 'querystring/parts', message: `Parts: ${PRODUCTION_PARTS.join(', ')}.` }])
  }
  return PRODUCTION_PARTS.filter((part) => asked.includes(part))
}

/** What each part, and each block of a part, needs beside orders.view. */
export const PART_RIGHTS: Readonly<Record<WithheldKey, Permission>> = Object.freeze({
  work: WORKORDERS_VIEW,
  people: WORKORDERS_VIEW,
  'headline.notes': WORKORDERS_VIEW,
  'quality.issues': WORKORDERS_VIEW,
  'quality.ncrs': QUALITY_NCR_VIEW,
  'quality.final': QUALITY_INSPECTIONS_VIEW,
  'dates.forecast': PLANNING_PROMISE_VIEW,
})

/** The blocks of the parts asked that the reader may not read (each named once, in the contract's order). */
export function withheldOf(parts: readonly ProductionPart[], may: (permission: Permission) => boolean): WithheldKey[] {
  const keys = Object.keys(PART_RIGHTS) as WithheldKey[]
  return keys.filter((key) => parts.includes(key.split('.')[0] as ProductionPart) && !may(PART_RIGHTS[key]))
}

/** A sum that stays null when nothing counts the step (never a made-up 0). */
export function sumOrNull(values: Iterable<number | null>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null) total = (total ?? 0) + value
  return total
}

/** THIS order's share of one work order: its own cells, their pieces and what the floor counted of them. */
export function ownShareOf(cells: readonly { readonly quantity: number; readonly cellId: string }[], counts: ReadonlyMap<string, Pick<CellCount, 'cut' | 'sewn' | 'inspected'>>) {
  return {
    cells: cells.length,
    pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0),
    cut: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.cut ?? null)),
    sewn: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.sewn ?? null)),
    checked: sumOrNull(cells.map((cell) => counts.get(cell.cellId)?.inspected ?? null)),
  }
}

/** One other order a work order also makes (of any customer: the reader's wall decides below). */
export interface OtherOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

/**
 * "Also makes": the other orders of THIS order's customer the reader reaches, by number; this customer's others counted (`more`);
 * another customer's order is neither named nor counted (a work order made before the rule says `sharedWithOtherCustomers`).
 */
export function alsoMakesOf(others: readonly OtherOrder[], partyId: string, reaches: (order: OtherOrder) => boolean): { orders: { id: string; number: string }[]; more: number } {
  const own = others.filter((order) => order.partyId === partyId)
  const named = own.filter(reaches).sort((a, b) => a.number.localeCompare(b.number))
  return { orders: named.map((order) => ({ id: order.id, number: order.number })), more: own.length - named.length }
}

/** Made-to-measure work orders (one per unit), grouped per style × colourway: one row with its units and statuses. */
export function mtmGroupsOf<T extends { readonly styleId: string; readonly colourwayId: string; readonly status: string; readonly units: number }>(rows: readonly T[]): { styleId: string; colourwayId: string; units: number; workOrders: number; byStatus: { status: string; count: number }[]; rows: T[] }[] {
  const groups = new Map<string, { styleId: string; colourwayId: string; rows: T[] }>()
  for (const row of rows) {
    const key = `${row.styleId}|${row.colourwayId}`
    const group = groups.get(key) ?? { styleId: row.styleId, colourwayId: row.colourwayId, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const statuses = new Map<string, number>()
    for (const row of group.rows) statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1)
    return {
      styleId: group.styleId,
      colourwayId: group.colourwayId,
      units: group.rows.reduce((sum, row) => sum + row.units, 0),
      workOrders: group.rows.length,
      byStatus: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => a.status.localeCompare(b.status)),
      rows: group.rows,
    }
  })
}

/** The pieces between the steps (what is in work now): counts only, from the order's own settled figures. */
export function inWorkPiecesOf(input: { readonly started: number; readonly cut: number | null; readonly sewn: number | null; readonly checked: number | null; readonly packed: number | null }) {
  const less = (from: number, minus: number) => Math.max(0, from - minus)
  const cut = input.cut ?? 0
  return {
    cutting: less(input.started, cut),
    sewing: input.sewn === null ? null : less(cut, input.sewn),
    checking: input.sewn === null ? null : less(input.sewn, input.checked ?? 0),
    packing: input.checked === null ? null : less(input.checked, input.packed ?? 0),
  }
}

/** Whole days from `from` to `to` (later: positive). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)

/** Each blocker in the office's words (tu): what the order waits for. */
export const BLOCKER_WORDS: Readonly<Record<BlockerKind, Words>> = Object.freeze({
  APPROVAL: { it: 'In attesa del sì del cliente', en: "Waiting for the customer's yes" },
  PARTNER_TASK: { it: 'Un compito aperto sul portale del cliente', en: "An open task on the customer's portal" },
  DEPOSIT: { it: 'Acconto non ancora pagato', en: 'Deposit not paid yet' },
  CUSTOMER_MATERIAL: { it: 'Materiale del cliente non ancora arrivato', en: "The customer's material is not in yet" },
  BRAND_PAUSE: { it: 'In pausa su richiesta del cliente', en: "Paused at the customer's request" },
  MATERIAL_SHORT: { it: 'Materiale mancante', en: 'Material short' },
  SUBCONTRACT: { it: 'Presso un laboratorio esterno', en: 'At an outside workshop' },
  BRAND_REQUEST: { it: 'Una richiesta del cliente aspetta la nostra risposta', en: 'A customer request waits for our answer' },
  GATE: { it: 'Un passaggio non è ancora superato', en: 'A gate is not passed yet' },
  RELEASE_CHECK: { it: 'Il controllo di rilascio non è superato', en: 'The release check is not passed' },
  QUALITY_HOLD: { it: 'In blocco qualità', en: 'On a quality hold' },
  NONCONFORMANCE: { it: 'Una non conformità aperta', en: 'An open nonconformance' },
  NO_MOVE: { it: 'Fermo di produzione', en: 'Production hold' },
})

// ---- the read ---------------------------------------------------------------------------------------------------------------------

/** Subcontract orders whose pieces are out at the workshop (production/brand facts' own set). */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
/** Work orders whose ACTIVE bundles are in work. */
const IN_WORK = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

const isGoods = (line: Pick<LineRecord, 'kind'>): boolean => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const named = (row: { readonly code: string; readonly name: string } | undefined | null) => (row ? { code: row.code, name: row.name } : null)

/** The order's own facts every part reads from, each read once and only when a part asks for it. */
function loaders(db: Db, context: OfficeContext, order: OrderRow, now: Date) {
  const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let kept: Promise<T> | null = null
    return () => (kept ??= read())
  }
  const lines = once(() => readLines(db, order.id))
  // The cells of its own lines in live work orders (not a repair, not cancelled), read now; their counts from the kept minute.
  const cells = once(async () => {
    const lineIds = (await lines()).map((line) => line.id)
    if (lineIds.length === 0) return []
    const rows = await db.workOrderSize.findMany({
      where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } },
      select: { id: true, workOrderId: true, salesOrderLineId: true, colourwayId: true, size: true, quantity: true },
      orderBy: { id: 'asc' },
    })
    return rows.flatMap((row) => (row.salesOrderLineId ? [{ cellId: row.id, workOrderId: row.workOrderId, lineId: row.salesOrderLineId, colourwayId: row.colourwayId, size: row.size, quantity: row.quantity }] : []))
  })
  const progress = once(async () => officeProgressFor(db, context.tenantId, order.id, await lines(), now))
  const counts = once(async () => new Map((await progress()).cells.cells.map((cell) => [cell.cellId, cell] as const)))
  const workOrders = once(async () => {
    const ids = unique((await cells()).map((cell) => cell.workOrderId))
    if (ids.length === 0) return []
    return db.workOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, lineId: true, partyId: true, styleId: true, rush: true, dueDate: true },
      orderBy: { number: 'asc' },
    })
  })
  const filter = once(async (): Promise<OrderFilter> => ({ id: order.id, workOrderIds: (await workOrders()).map((row) => row.id) }))
  return { lines, cells, progress, counts, workOrders, filter, orderFacts: once(() => readOrderFacts(db, order)) }
}
type Loaders = ReturnType<typeof loaders>

async function peopleById(db: Db, ids: readonly (string | null | undefined)[]) {
  const wanted = unique(ids.filter((value): value is string => typeof value === 'string'))
  const rows = wanted.length === 0 ? [] : await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, status: true }, orderBy: { id: 'asc' } })
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.displayName, active: row.status === 'ACTIVE' }]))
}

async function headlinePart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, now: Date, notes: boolean) {
  const actor = actorOf(context)
  const today = businessDate(now)
  const facts = await readOrderProductionFacts(db, context, order.id, now, { health: false })
  const row = await db.brandOrderProduction.findFirst({
    where: { key: brandProductionKey(order.id) },
    select: { stage: true, stageAt: true, health: true, healthSet: true, healthReasonCode: true, healthNote: true, healthSetAt: true, healthSetById: true, healthSetUntil: true, waitingOn: true, waitingSince: true },
  })
  // The stage the customer reads too (its kept state first), with "ahead" and "sewing not counted" from the live facts that agree.
  const live = facts?.stage ?? null
  const code: BrandStage | null = row ? (row.stage as BrandStage) : (live?.stage ?? null)
  const agreeing = live && code && live.stage === code ? live : null
  const next = code ? nextStageOf(code) : null
  const stage =
    code === null
      ? null
      : {
          code,
          words: STAGE_WORDS[code],
          since: row ? businessDate(row.stageAt) : null,
          ahead: agreeing?.ahead ?? 0,
          aheadWords: aheadWords(agreeing?.ahead ?? 0),
          sewingNotCounted: agreeing?.sewingNotCounted ?? false,
          sewingNotCountedWords: agreeing?.sewingNotCounted ? SEWING_NOT_COUNTED_WORDS : null,
          next: next ? { code: next, words: STAGE_WORDS[next] } : null,
          partlyShipped: order.status === 'PARTLY_SHIPPED',
        }

  // What is in work: the order's ACTIVE bundles of work orders past their draft, and its pieces between the steps.
  const cells = await load.cells()
  const workOrders = await load.workOrders()
  const statusOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder.status as string]))
  const started = cells.filter((cell) => (IN_WORK as readonly string[]).includes(statusOf.get(cell.workOrderId) ?? '') || statusOf.get(cell.workOrderId) === 'COMPLETED')
  const bundles = started.length === 0 ? 0 : await db.bundle.count({ where: { status: 'ACTIVE', workOrderSizeId: { in: started.filter((cell) => (IN_WORK as readonly string[]).includes(statusOf.get(cell.workOrderId) ?? '')).map((cell) => cell.cellId) } } })
  const whole = (await load.progress()).view.whole
  const inWork = { bundles, pieces: inWorkPiecesOf({ started: Math.min(whole.ordered, started.reduce((sum, cell) => sum + cell.quantity, 0)), cut: whole.cut, sewn: whole.sewn, checked: whole.inspected, packed: whole.packed }) }

  // The keeper's health, raised to At risk by a person while the raise stands (its note and who raised it: office only).
  const raise: HealthRaise | null = row ? standingRaiseOf(row, today) : null // B-SA-070: the one reading of a standing raise (./production-columns)
  const effective = row ? effectiveHealth(row.health as BrandHealth | null, raise) : null
  const raisedBy = row && notes && raise && row.healthSetById ? ((await peopleById(db, [row.healthSetById])).get(row.healthSetById) ?? null) : null
  const health =
    row && effective && effective.health !== null
      ? {
          code: effective.health,
          words: HEALTH_WORDS[effective.health],
          computed: (row.health as BrandHealth | null) ?? null,
          raise: raise ? { reasonCode: raise.reasonCode, words: HEALTH_REASON_WORDS[raise.reasonCode], until: raise.until, note: notes ? row.healthNote : null, by: raisedBy, at: notes && row.healthSetAt ? toUtcIso(row.healthSetAt) : null } : null,
        }
      : null

  // Who acts next (the kept state first, else the live facts) and each thing it waits for, in words.
  const on: WaitingOn = (row?.waitingOn as WaitingOn | null | undefined) ?? facts?.waiting.on ?? 'US'
  const since = row ? row.waitingSince : (facts?.waiting.since ?? null)
  const blockers = (facts?.blockers ?? []).map((blocker: Blocker) => ({ kind: blocker.kind, on: BLOCKER_OWNER[blocker.kind], words: BLOCKER_WORDS[blocker.kind], since: blocker.since ? toUtcIso(blocker.since) : null }))

  // The holds in plain words (the customer's own reader: a hold of a work order of several customers reads its reason's words).
  const lines = await load.lines()
  const work = workOf(await readWork(db, order.partyId, lines, { words: true }), order.id)
  const reached = workOrders.filter((workOrder) => reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const holdRows = notes && reached.length > 0 ? await db.workOrderHold.findMany({ where: { workOrderId: { in: reached.map((workOrder) => workOrder.id) }, status: 'ACTIVE', note: { not: null } }, select: { workOrderId: true, kind: true, note: true, placedAt: true }, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] }) : []
  const numberOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder.number]))

  // The promise and how far it moved, the three urgencies.
  const date = dayOrNull(order.promiseDate)
  const first = dayOrNull(order.originalPromiseDate)
  const moves = await db.auditLog.count({ where: { recordType: 'SalesOrder', recordId: order.id, action: 'orders.changePromise' } })
  const priority = await db.salesOrder.findUnique({ where: { id: order.id }, select: { priorityLevel: true, urgentReason: true } })
  const level = (priority?.priorityLevel ?? 'NORMAL') as SalesOrderPriorityLevel
  const customer = (await countedUrgencyOf(db, [order.id])).get(order.id) ?? null
  const customerUrgency = customer
    ? { code: customer.urgency as BrandUrgency, urgentRank: customer.urgentRank, words: customer.urgency === 'URGENT' ? customerUrgencyChipWords(customer.urgentRank) : URGENCY_WORDS.REGULAR }
    : null

  return {
    stage,
    inWork,
    health,
    waiting: { on, words: OFFICE_WAITING_WORDS[on], since: since ? toUtcIso(since) : null, blockers },
    held: work.onHold || (facts?.held ?? false),
    holds: work.holds.map((hold) => ({ kind: hold.kind, words: hold.words, since: hold.since })),
    holdNotes: notes ? holdRows.map((hold) => ({ workOrderId: hold.workOrderId, number: numberOf.get(hold.workOrderId) ?? '', kind: hold.kind as string, note: hold.note ?? '', since: toUtcIso(hold.placedAt) })) : null,
    promise: { date, first, moved: first !== null && date !== first, moves, slipDays: date !== null && first !== null ? daysBetween(first, date) : null },
    urgency: {
      customer: customerUrgency,
      factoryRush: workOrders.some((workOrder) => workOrder.rush && !['COMPLETED', 'CLOSED'].includes(workOrder.status)),
      officePriority: { level, words: PRIORITY_WORDS[level], reason: priority?.urgentReason ?? null },
    },
  }
}

async function linesPart(db: Db, load: Loaders, /* B-SA-043 */ context: OfficeContext, order: OrderRow) {
  const lines = await load.lines()
  // B-SA-043 (R1, review P6-4): pieces cut of the order's own cells beyond what the line now wants (office only: "Made extra: 4 M").
  const extra = await madeExtraOf(db, context.tenantId, order)
  // A sizeless line (a made-to-measure unit) reads its one piece's extra, of its base size.
  const extraOf = (lineId: string, size: string | null) => extra.find((entry) => entry.lineId === lineId && (size === null || entry.size === size))
  const extraOfLine = (lineId: string) => extra.filter((entry) => entry.lineId === lineId).reduce((sum, entry) => sum + entry.count, 0)
  const view = (await load.progress()).view
  const facts = await load.orderFacts()
  const cells = await load.cells()
  const inWork = new Map<string, number>()
  for (const cell of cells) inWork.set(cell.lineId, (inWork.get(cell.lineId) ?? 0) + cell.quantity)
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const shippedOf = (lineId: string, size: string | null) => facts.progress.rows.find((row) => row.lineId === lineId && row.size === size)?.shipped ?? 0
  return view.lines.map((entry) => {
    const line = lineOf.get(entry.lineId)
    return {
      lineId: entry.lineId,
      seq: entry.seq,
      kind: line?.kind ?? '',
      style: named(line ? styles.get(line.styleId) : undefined),
      colourway: named(line ? colourways.get(line.colourwayId) : undefined),
      ordered: entry.ordered,
      cut: entry.cut,
      sewn: entry.sewn,
      checked: entry.inspected,
      packed: entry.packed,
      shipped: facts.progress.lines.find((total) => total.lineId === entry.lineId)?.shipped ?? 0,
      inWorkOrders: inWork.get(entry.lineId) ?? 0,
      notInWorkOrders: !inWork.has(entry.lineId),
      sizes: entry.sizes.map((size) => ({ size: size.size, ordered: size.ordered, cut: size.cut, sewn: size.sewn, checked: size.inspected, packed: size.packed, shipped: shippedOf(entry.lineId, size.size), /* B-SA-043 */ madeExtra: extraOf(entry.lineId, size.size)?.count ?? 0, madeExtraWords: extraOf(entry.lineId, size.size)?.words ?? null })),
      // B-SA-043: the line's extra pieces, all sizes together.
      madeExtra: extraOfLine(entry.lineId),
    }
  })
}

async function workPart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, today: BusinessDate) {
  const actor = actorOf(context)
  const cells = await load.cells()
  const counts = await load.counts()
  const lines = await load.lines()
  const all = await load.workOrders()
  const reached = all.filter((workOrder) => reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const reachedIds = reached.map((workOrder) => workOrder.id)
  const ownLineIds = new Set(lines.map((line) => line.id))
  const ownCellIds = cells.map((cell) => cell.cellId)

  // The other orders each reached work order makes (its cells of other lines): named only when of this customer and reached.
  const others = reachedIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { workOrderId: { in: reachedIds }, salesOrderLineId: { not: null } }, select: { workOrderId: true, salesOrderLineId: true }, distinct: ['workOrderId', 'salesOrderLineId'] })
  const otherLineIds = unique(others.flatMap((cell) => (cell.salesOrderLineId && !ownLineIds.has(cell.salesOrderLineId) ? [cell.salesOrderLineId] : [])))
  const otherLines = otherLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: otherLineIds } }, select: { id: true, orderId: true } })
  const orderOfLine = new Map(otherLines.map((line) => [line.id, line.orderId]))
  const otherOrderIds = unique(otherLines.map((line) => line.orderId).filter((id) => id !== order.id))
  const otherOrders = new Map((otherOrderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: otherOrderIds } }, select: { id: true, number: true, companyId: true, partyId: true } })).map((row) => [row.id, row]))
  const othersOf = (workOrderId: string): OtherOrder[] =>
    unique(others.filter((cell) => cell.workOrderId === workOrderId && cell.salesOrderLineId && orderOfLine.has(cell.salesOrderLineId)).map((cell) => orderOfLine.get(cell.salesOrderLineId!)!))
      .filter((orderId) => orderId !== order.id)
      .flatMap((orderId) => (otherOrders.has(orderId) ? [otherOrders.get(orderId)!] : []))

  // A cut order of one of its cells that also cuts other work (no other id, no count).
  const cutLines = ownCellIds.length === 0 ? [] : await db.cutOrderLine.findMany({ where: { workOrderSizeId: { in: ownCellIds } }, select: { cutOrderId: true, workOrderId: true } })
  const cutOrderIds = unique(cutLines.map((line) => line.cutOrderId))
  const sharedCuts = new Set(
    cutOrderIds.length === 0 ? [] : (await db.cutOrderLine.findMany({ where: { cutOrderId: { in: cutOrderIds }, workOrderSizeId: { notIn: ownCellIds } }, select: { cutOrderId: true }, distinct: ['cutOrderId'] })).map((line) => line.cutOrderId),
  )

  // Where each is made: its site and line, the outside workshops its pieces are at now.
  const sites = new Map((reached.length === 0 ? [] : await db.site.findMany({ where: { id: { in: unique(reached.map((row) => row.siteId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineIds = unique(reached.flatMap((row) => (row.lineId ? [row.lineId] : [])))
  const floorLines = new Map((lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const outside = reachedIds.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { workOrderId: { in: reachedIds }, status: { in: [...AT_WORKSHOP] } }, select: { workOrderId: true, partyId: true } })
  const workshopNames = new Map((outside.length === 0 ? [] : await db.party.findMany({ where: { id: { in: unique(outside.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const styles = new Map((reached.length === 0 ? [] : await db.style.findMany({ where: { id: { in: unique(reached.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((cells.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))

  const ownOf = (workOrderId: string) => cells.filter((cell) => cell.workOrderId === workOrderId)
  const rows = reached.map((workOrder) => {
    const own = ownOf(workOrder.id)
    return {
      id: workOrder.id,
      number: workOrder.number,
      status: workOrder.status as string,
      kind: workOrder.kind as string,
      styleId: workOrder.styleId,
      colourwayId: own[0]?.colourwayId ?? '',
      units: own.length,
      held: workOrder.status === 'ON_HOLD',
      rush: workOrder.rush,
      style: named(styles.get(workOrder.styleId)),
      colourways: unique(own.map((cell) => cell.colourwayId)).flatMap((id) => (colourways.has(id) ? [named(colourways.get(id))!] : [])),
      site: named(sites.get(workOrder.siteId)),
      line: named(workOrder.lineId ? floorLines.get(workOrder.lineId) : undefined),
      workshops: unique(outside.filter((row) => row.workOrderId === workOrder.id).map((row) => row.partyId)).map((partyId) => ({ name: workshopNames.get(partyId) ?? '' })),
      own: ownShareOf(own, counts),
      alsoMakes: alsoMakesOf(othersOf(workOrder.id), order.partyId, (other) => can(actor, ORDERS_VIEW, { companyId: other.companyId, partyId: other.partyId })),
      sharedWithOtherCustomers: workOrder.partyId === null,
      cutWithOtherWork: cutLines.some((line) => line.workOrderId === workOrder.id && sharedCuts.has(line.cutOrderId)),
      due: dayOrNull(workOrder.dueDate),
      daysLate: daysLate(workOrder.status as WorkOrderStatus, dayOrNull(workOrder.dueDate), today),
    }
  })
  const strip = ({ styleId: _styleId, colourwayId: _colourwayId, units: _units, kind: _kind, ...row }: (typeof rows)[number]) => row
  const mtm = mtmGroupsOf(rows.filter((row) => row.kind === 'MADE_TO_MEASURE')).map((group) => ({
    style: named(styles.get(group.styleId)),
    colourway: named(colourways.get(group.colourwayId)),
    units: group.units,
    workOrders: group.workOrders,
    byStatus: group.byStatus,
    own: ownShareOf(group.rows.flatMap((row) => ownOf(row.id)), counts),
  }))

  // Goods lines no live work order makes yet (a line closed short is done).
  const inWork = new Set(cells.map((cell) => cell.lineId))
  const waiting = lines.filter((line) => isGoods(line) && line.closedShortQuantity === null && !inWork.has(line.id))
  return {
    workOrders: rows.filter((row) => row.kind !== 'MADE_TO_MEASURE').map(strip),
    mtm,
    workOrdersLeftOut: all.length - reached.length,
    notInProduction: { lines: waiting.length, pieces: waiting.reduce((sum, line) => sum + line.quantity, 0) },
  }
}

/** The forecast per open line from the plan (promise-keep, per making site; a line of no site: its company's only plant). */
async function forecastOf(caller: CommandCaller, context: OfficeContext, lines: readonly LineRecord[], companyId: string, now: Date) {
  const open = lines.filter((line) => isGoods(line) && line.closedShortQuantity === null)
  if (open.length === 0) return []
  const out: { lineId: string; seq: number; finish: BusinessDate | null; risk: string | null; slackDays: number | null; sizes: { size: string | null; finish: BusinessDate | null; risk: string | null }[] }[] = []
  // Its own transaction: a planning read that fails is answered without its lines (never the rest of the order's read).
  await caller.withClient(async (db) => {
    const siteIds = unique(open.flatMap((line) => (line.siteId ? [line.siteId] : [])))
    const sites = new Map<string, SiteRow>((siteIds.length === 0 ? [] : await db.site.findMany({ where: { id: { in: siteIds } }, select: SITE_COLUMNS })).map((site) => [site.id, site]))
    const plants = open.some((line) => line.siteId === null) ? await db.site.findMany({ where: { companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, take: 2 }) : []
    const plant = plants.length === 1 ? plants[0]! : null
    const bySite = new Map<string, { site: SiteRow; ids: string[] }>()
    for (const line of open) {
      const site = line.siteId ? (sites.get(line.siteId) ?? null) : plant
      if (!site) continue
      const group = bySite.get(site.id) ?? { site, ids: [] }
      group.ids.push(line.id)
      bySite.set(site.id, group)
    }
    for (const { site, ids } of bySite.values()) {
      for (let at = 0; at < ids.length; at += LINES_LIMIT) {
        const read = await promiseLinesOf(db, context, site, now, { orderLineIds: ids.slice(at, at + LINES_LIMIT), limit: LINES_LIMIT })
        for (const line of read.lines) out.push({ lineId: line.id, seq: line.seq, finish: line.finish, risk: line.risk, slackDays: line.slackDays, sizes: line.sizes.map((size) => ({ size: size.size, finish: size.finish, risk: size.risk })) })
      }
    }
  }).catch(() => undefined)
  return out.sort((a, b) => a.seq - b.seq)
}

async function datesPart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders, now: Date) {
  const world = { actor: actorOf(context), actorId: context.actorId, now }
  // Time & action's own world of this one order, under orders.view (the Sales template holds no planning.view); no action.
  const read = await readWorld(db, world, { orderIds: [order.id] }, { permission: ORDERS_VIEW })
  const view = read.orders.find((entry) => entry.id === order.id)
  const own = (await load.workOrders()).filter((workOrder) => workOrder.partyId === order.partyId).map((workOrder) => workOrder.id)
  const planned = (await readPlanned(db, new Map([[order.id, own]]))).get(order.id) ?? { cutStart: null, sewStart: null, finish: null }
  return {
    gates: (view?.gates ?? []).map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      label: gate.label,
      targetDate: gate.targetDate,
      sampleRound: gate.sampleRound,
      owner: gate.owner,
      state: gate.state,
      passedOn: gate.passedOn,
      via: gate.via,
      startedBefore: gate.startedBefore,
      leather: gate.leather,
    })),
    milestones: (view?.milestones ?? []).map((row) => ({ id: row.id, kind: row.kind, gateId: row.gateId, gateKind: row.gateKind, label: row.label, target: row.target, actual: row.actual, state: row.state, late: row.late, owner: row.owner })),
    late: view?.late ?? 0,
    next: view?.next ?? null,
    planned,
    // Filled after this read, in a transaction of its own (forecastOf); null while withheld.
    forecast: null as Awaited<ReturnType<typeof forecastOf>> | null,
  }
}

async function qualityPart(db: Db, context: OfficeContext, load: Loaders, may: { readonly issues: boolean; readonly ncrs: boolean; readonly final: boolean }) {
  const actor = actorOf(context)
  const filter = await load.filter()
  const issueReach = may.issues ? issueReadWhere(actor) : null
  const issues =
    may.issues && issueReach
      ? await db.productionIssue.findMany({ where: { AND: [issueReach, issuesOfOrderWhere(filter), { status: 'OPEN' }] }, select: { id: true, source: true, recordType: true, raisedAt: true, dueDate: true, escalationStep: true }, orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }], take: 200 })
      : null
  const ncrsRead = async () => {
    const own: Prisma.NonconformanceWhereInput = { AND: [scopeWhere(actor, QUALITY_NCR_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.NonconformanceWhereInput, ncrsOfOrderWhere(filter), { stage: { in: [...OPEN_NCR_STAGES] } }] }
    // The brand wall: an NCR of a work order of several customers (or of none) only for people who reach every customer.
    const where = await ncrListWhere(db, actor, QUALITY_NCR_VIEW, own)
    const rows = await db.nonconformance.findMany({ where, select: { id: true, number: true, stage: true, severity: true, workOrderId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    const workOrderIds = unique(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))
    const shared = new Set(workOrderIds.length === 0 ? [] : (await db.workOrder.findMany({ where: { id: { in: workOrderIds }, partyId: null }, select: { id: true } })).map((row) => row.id))
    return rows.map((row) => ({ id: row.id, number: row.number, stage: row.stage as string, severity: row.severity as string, sharedWorkOrder: row.workOrderId !== null && shared.has(row.workOrderId) }))
  }
  const ncrs = may.ncrs ? await ncrsRead() : null
  const finalRead = async () => {
    const reached = (await load.workOrders()).filter((workOrder) => reachesWorkOrder(actor, QUALITY_INSPECTIONS_VIEW, workOrder)).map((workOrder) => workOrder.id)
    const rows = reached.length === 0 ? [] : await db.inspection.findMany({ where: { workOrderId: { in: reached }, status: { not: 'CANCELLED' } }, select: { workOrderId: true, number: true, status: true, sampleSize: true, decidedAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    return rows.map((row) => ({ workOrderId: row.workOrderId, number: row.number, status: row.status as string, sampleSize: row.sampleSize, on: row.decidedAt ? businessDate(row.decidedAt) : null }))
  }
  const final = may.final ? await finalRead() : null
  return {
    issues: issues ? issues.map((row) => ({ id: row.id, source: row.source as string, recordType: row.recordType, since: toUtcIso(row.raisedAt), dueOn: dayOf(row.dueDate), escalation: row.escalationStep })) : null,
    ncrs,
    final,
  }
}

async function peoplePart(db: Db, context: OfficeContext, order: OrderRow, load: Loaders) {
  const actor = actorOf(context)
  const supervisor = await supervisorOfOrder(db, order.id)
  const thread = await db.thread.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id }, select: { ownerId: true } })
  const people = await peopleById(db, [supervisor?.userId, supervisor?.backupId, thread?.ownerId])
  // Places: a site and its line (a team by name, never with a count), and the outside workshops — of the work orders it reaches.
  const reached = (await load.workOrders()).filter((workOrder) => reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))
  const sites = new Map((reached.length === 0 ? [] : await db.site.findMany({ where: { id: { in: unique(reached.map((row) => row.siteId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineIds = unique(reached.flatMap((row) => (row.lineId ? [row.lineId] : [])))
  const floorLines = new Map((lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const teams = lineIds.length === 0 ? [] : await db.team.findMany({ where: { lineId: { in: lineIds }, status: 'ACTIVE' }, select: { lineId: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const outside = reached.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { workOrderId: { in: reached.map((row) => row.id) }, status: { in: [...AT_WORKSHOP] } }, select: { partyId: true } })
  const workshops = outside.length === 0 ? [] : await db.party.findMany({ where: { id: { in: unique(outside.map((row) => row.partyId)) } }, select: { legalName: true, tradeName: true }, orderBy: { legalName: 'asc' } })
  const places = new Map<string, { site: ReturnType<typeof named>; line: ReturnType<typeof named>; team: ReturnType<typeof named>; workshop: { name: string } | null }>()
  for (const workOrder of reached) {
    const key = `${workOrder.siteId}|${workOrder.lineId ?? ''}`
    if (places.has(key)) continue
    places.set(key, {
      site: named(sites.get(workOrder.siteId)),
      line: named(workOrder.lineId ? floorLines.get(workOrder.lineId) : undefined),
      team: named(workOrder.lineId ? teams.find((team) => team.lineId === workOrder.lineId) : undefined),
      workshop: null,
    })
  }
  for (const workshop of workshops) places.set(`workshop|${workshop.tradeName ?? workshop.legalName}`, { site: null, line: null, team: null, workshop: { name: workshop.tradeName ?? workshop.legalName } })
  const supervisorPerson = supervisor?.userId ? people.get(supervisor.userId) : undefined
  return {
    supervisor: supervisorPerson && supervisor?.from ? { ...supervisorPerson, from: supervisor.from, me: supervisorPerson.id === context.actorId } : null,
    backup: supervisor?.backupId ? (people.get(supervisor.backupId) ?? null) : null,
    answersCustomer: thread?.ownerId ? (people.get(thread.ownerId) ?? null) : null,
    places: [...places.values()],
  }
}

async function changesPart(db: Db, order: OrderRow, /* B-SA-050 */ context: OfficeContext) {
  const rows = await db.orderChangeRequest.findMany({ where: { orderId: order.id, status: { in: ['OPEN', 'COUNTERED'] } }, select: { id: true, kind: true, status: true, createdAt: true, batchId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  // B-SA-050 (R1, P6; review C-8): what is still to do after the accepted changes, computed from the records (./still-to-do).
  const stillToDo = await stillToDoOf(db, context, order)
  return { openRequests: rows.map((row) => ({ id: row.id, kind: row.kind as string, status: row.status as string, since: toUtcIso(row.createdAt), batchId: row.batchId })), stillToDo }
}

/** The parts asked of one order the caller reached with orders.view (`order`), each by its right. */
export async function readOrderProduction(caller: CommandCaller, context: OfficeContext, order: OrderRow, parts: readonly ProductionPart[], now: Date) {
  const actor = actorOf(context)
  const may = (permission: Permission): boolean => can(actor, permission, { companyId: order.companyId, partyId: order.partyId })
  const withheld = withheldOf(parts, may)
  const kept = (key: WithheldKey) => !withheld.includes(key)
  const today = businessDate(now)
  const read = await caller.withClient(async (db) => {
    const load = loaders(db, context, order, now)
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const headline = parts.includes('headline') ? await headlinePart(db, context, order, load, now, kept('headline.notes')) : undefined
    const lines = parts.includes('lines') ? await linesPart(db, load, context, order) : undefined
    const work = parts.includes('work') ? (kept('work') ? await workPart(db, context, order, load, today) : null) : undefined
    const dates = parts.includes('dates') ? await datesPart(db, context, order, load, now) : undefined
    const quality = parts.includes('quality') ? await qualityPart(db, context, load, { issues: kept('quality.issues'), ncrs: kept('quality.ncrs'), final: kept('quality.final') }) : undefined
    const people = parts.includes('people') ? (kept('people') ? await peoplePart(db, context, order, load) : null) : undefined
    const changes = parts.includes('changes') ? await changesPart(db, order, context) : undefined
    const progress = parts.includes('lines') || parts.includes('headline') ? await load.progress() : null
    return { headline, lines, work, dates, quality, people, changes, asOf: progress ? progress.computedAt : now, orderLines: dates && kept('dates.forecast') ? await load.lines() : null }
  })
  const { asOf, orderLines, ...answer } = read
  // The forecast per line: a planning read in its own transaction, after the rest (one that fails leaves the lines without it).
  if (answer.dates && orderLines) answer.dates.forecast = await forecastOf(caller, context, orderLines, order.companyId, now)
  return {
    order: { id: order.id, number: order.number, status: order.status as string, version: order.version },
    asOf: toUtcIso(asOf),
    refreshSeconds: PROGRESS_REFRESH_SECONDS,
    parts: [...parts],
    withheld,
    // A part not asked is absent; one withheld is null (named in `withheld`).
    ...(answer.headline !== undefined ? { headline: answer.headline } : {}),
    ...(answer.lines !== undefined ? { lines: answer.lines } : {}),
    ...(answer.work !== undefined ? { work: answer.work } : {}),
    ...(answer.dates !== undefined ? { dates: answer.dates } : {}),
    ...(answer.quality !== undefined ? { quality: answer.quality } : {}),
    ...(answer.people !== undefined ? { people: answer.people } : {}),
    ...(answer.changes !== undefined ? { changes: answer.changes } : {}),
  }
}

/** GET /sales/orders/:orderId/production (B-SA-031, B-SA-032). */
export async function orderProduction(caller: CommandCaller, orderId: string, query: { readonly parts?: string | undefined }) {
  const parts = partsOf(query.parts)
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return readOrderProduction(caller, context, order, parts, serverClock.now())
}

/** GET /sales/orders/:orderId/milestones (B-SA-032, P16): the `dates` part alone, for any caller of the order's own dates. */
export async function orderMilestones(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  const answer = await readOrderProduction(caller, context, order, ['dates'], serverClock.now())
  if (!('dates' in answer) || !answer.dates) throw new Error('the dates part was asked')
  return { order: answer.order, asOf: answer.asOf, withheld: answer.withheld, dates: answer.dates }
}
