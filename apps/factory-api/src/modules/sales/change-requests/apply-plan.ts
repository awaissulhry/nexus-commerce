import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { CHANGE_WORDS, type ChangeCell, type ExtraOutcome, type ExtraPieces, type PlannedChange, type WorkOrderChangeKind, type WorkOrderChangeStatus } from '@nexus/factory-domain/order-apply/rules'
import { isProductionAccept } from '@nexus/factory-domain/production-brand/accept'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import {
  amendStepOf,
  APPLY_WORDS,
  floorStageOf,
  inWorkWords,
  numbered,
  outcomeOptionsOf,
  repromiseStepOf,
  workshopStepOf,
  workStepOf,
  type ApplyStep,
  type WorkFacts,
} from '@nexus/factory-domain/sales/change-requests/apply-plan'
import type { AskedCell, OrderRequestKind, RequestStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readProposals } from '../../planning/promise-keep/store'
import { supervisorOfWorkOrder } from '../../production/supervisor/resolver'
import { cellsOf, CHANGE_COLUMNS, extraOf as storedExtraOf, LIVE_EVENTS as CHANGE_LIVE_EVENTS, type ChangeRow } from '../../production/work-order-changes/read'
import { workCellsOf } from '../../production/work-order-changes/propose'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { officeContextOf } from '../orders/access'
import { dayOrNull, readLines, type LineRecord, type OrderRow } from '../orders/store'
import { officeProgressFor } from '../portal-orders/progress'
import { acceptPreviewOf, officeRequest, officeViews, type AcceptPreview } from './office'
import { keptImpactOf, LIVE_EVENTS, readCells, type OfficeRequestRow, type Reader } from './store'

/**
 * B-SA-045 (sales page plan P5, P6', R1, R8; 13-backend B4a; 14-change-flow §3.2 items 4 and 6, §3.4): the review window's apply plan
 * of ONE customer request, the same answer before Accept (what accepting would do: the record's own preview, ./office
 * acceptPreviewOf, and the work-order changes it would propose — factory-domain order-apply planChanges, as Accept runs it) and after
 * it (what was done: the WorkOrderChange records the Accept proposed, the re-promises, the workshops told). Rules and words:
 * factory-domain sales/change-requests/apply-plan.
 *
 *   GET /sales/change-requests/:requestId/apply-plan   orders.view over the request's order (else 404 "Change request not found.",
 *                                                      the words of an unknown id)
 *
 *   floor   "On the floor now" per asked cell (ordered · asked · in work orders · cut · sewn · packed, the order's OWN cells:
 *           portal-orders/progress's counts, the minute kept for the portal too) and "In work now: N bundles at <stage>" —
 *           workorders.view over the order's customer, else null and named in `withheld`
 *   extra   the pieces already cut beyond the new figure, per size, with the three outcomes and what each needs (the price grain
 *           to charge, the scrap's own approval to scrap); the outcome chosen once accepted
 *   next    the numbered steps (factory-domain apply-plan): AMEND = this Accept, LOWER_TO_ORDER / MAKE_MORE held for who manages
 *           the work order (its supervisor named inside the office), REPROMISE, TELL_WORKSHOP
 *
 * THE WALL: a work order the reader does not reach (another customer's, or a mixed one made before the one-customer rule for a
 * person limited to some customers) is counted in `workOrdersLeftOut`, never named: its step reads "A work order" with this
 * order's own cells only, no door, no person. Nothing here names another customer, its order or its pieces. A read: no command.
 */

const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
const IN_WORK = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const GOODS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const

/** The events after which the window reads its plan again. */
export const APPLY_PLAN_LIVE_EVENTS = [...new Set([...LIVE_EVENTS, ...CHANGE_LIVE_EVENTS])] as const

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const sumOrNull = (values: readonly (number | null)[]): number | null => (values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0))

/** The asked cells as "On the floor now" reads them: per line and size; a line as a whole (null size); none: every goods line. */
function askedRowsOf(cells: readonly AskedCell[], lines: readonly LineRecord[]): { lineId: string; size: string | null; asked: number | null }[] {
  if (cells.length === 0) return lines.filter((line) => (GOODS as readonly string[]).includes(line.kind)).map((line) => ({ lineId: line.id, size: null, asked: null }))
  const seen = new Set<string>()
  const out: { lineId: string; size: string | null; asked: number | null }[] = []
  for (const cell of cells) {
    const key = `${cell.orderLineId}|${cell.size ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ lineId: cell.orderLineId, size: cell.size, asked: cell.size === null ? null : cell.quantity })
  }
  return out
}

/** One work-order change of the plan, as the window reads it (planned before Accept, stored after). */
interface WorkEntry {
  readonly changeId: string | null
  readonly kind: WorkOrderChangeKind
  readonly status: 'PLANNED' | WorkOrderChangeStatus
  readonly workOrderId: string | null
  readonly cells: readonly ChangeCell[]
  readonly extra: readonly ExtraPieces[]
  readonly extraOutcome: ExtraOutcome | null
  readonly decisionNote: string | null
  readonly lastError: string | null
}

const plannedEntries = (changes: readonly PlannedChange[]): WorkEntry[] =>
  changes.map((change) => ({ changeId: null, kind: change.kind, status: 'PLANNED', workOrderId: change.workOrderId, cells: change.cells, extra: change.extra, extraOutcome: null, decisionNote: null, lastError: null }))

const storedEntries = (rows: readonly ChangeRow[]): WorkEntry[] =>
  rows.map((row) => ({
    changeId: row.id,
    kind: row.kind as WorkOrderChangeKind,
    status: row.status as WorkOrderChangeStatus,
    workOrderId: row.workOrderId,
    cells: cellsOf(row),
    extra: storedExtraOf(row),
    extraOutcome: (row.extraOutcome as ExtraOutcome | null) ?? null,
    decisionNote: row.decisionNote,
    lastError: row.lastError,
  }))

/** A step as the answer carries it: the domain's step, its number, the named person, the record it is about, the cells. */
export interface PlanStep extends ApplyStep {
  readonly seq: number
  readonly person: { readonly id: string; readonly name: string } | null
  readonly ref: { readonly type: string; readonly id: string; readonly number: string | null } | null
  readonly workOrder: { readonly id: string; readonly number: string } | null
  readonly cells: { readonly seq: number; readonly size: string; readonly from: number; readonly to: number }[]
  readonly extra: number
}

type Draft = ApplyStep & Omit<PlanStep, keyof ApplyStep | 'seq'>

/** The plan of one request the caller reached with orders.view (see the file's head). */
export async function planOf(db: Reader, context: OfficeContext, row: OfficeRequestRow, order: OrderRow, now: Date) {
  const actor = actorOf(context)
  const place = { companyId: order.companyId, partyId: order.partyId }
  const kind = row.kind as OrderRequestKind
  const status = row.status as RequestStatus
  const accepted = status === 'ACCEPTED'
  const waiting = status === 'OPEN' || status === 'COUNTERED'
  const lines = await readLines(db, order.id)
  const seqOf = new Map(lines.map((line) => [line.id, line.seq]))
  const cells = (await readCells(db, [row.id])).get(row.id) ?? []
  const [view] = await officeViews(db, context, [row])
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true, tradeName: true } })
  const customer = party ? (party.tradeName ?? party.legalName) : ''

  // What happens to the work orders: planned before Accept (the same read as the record's preview), stored after.
  let entries: WorkEntry[] = []
  let held: AcceptPreview['held'] = []
  if (waiting && !isProductionAccept(kind)) {
    const preview = await acceptPreviewOf(db, context.tenantId, row, order, now)
    entries = plannedEntries(preview.changes)
    held = preview.held
  } else if (accepted) {
    entries = storedEntries(await db.workOrderChange.findMany({ where: { requestId: row.id }, select: CHANGE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  }

  // The work orders the steps name, through the wall.
  const workOrderIds = unique(entries.flatMap((entry) => (entry.workOrderId ? [entry.workOrderId] : [])))
  const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, partyId: true } }) : []).map((entry) => [entry.id, entry]))
  const reached = (workOrderId: string | null) => {
    const workOrder = workOrderId ? workOrders.get(workOrderId) : undefined
    return workOrder && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) ? workOrder : null
  }
  const supervisors = new Map<string, string | null>()
  for (const id of workOrderIds) if (reached(id)) supervisors.set(id, (await supervisorOfWorkOrder(db, id))?.userId ?? null)
  const personIds = unique([...supervisors.values()].filter((id): id is string => id !== null))
  const people = new Map((personIds.length > 0 ? await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))

  const workSteps: Draft[] = entries
    .slice()
    .sort((a, b) => Number(a.kind === 'MAKE_MORE') - Number(b.kind === 'MAKE_MORE'))
    .map((entry) => {
      const workOrder = reached(entry.workOrderId)
      const supervisorId = workOrder ? (supervisors.get(workOrder.id) ?? null) : null
      const person = supervisorId ? { id: supervisorId, name: people.get(supervisorId) ?? '' } : null
      const mayApply = entry.status === 'PROPOSED' && (entry.workOrderId ? workOrder !== null && reachesWorkOrder(actor, WORKORDERS_MANAGE, workOrder) : can(actor, WORKORDERS_MANAGE, place))
      const facts: WorkFacts = {
        kind: entry.kind,
        status: entry.status,
        number: workOrder?.number ?? null,
        cells: entry.cells.map((cell) => ({ size: cell.size, from: cell.from, to: cell.to })),
        extra: entry.extra.reduce((sum, piece) => sum + piece.count, 0),
        decisionNote: entry.decisionNote,
        lastError: entry.lastError,
        person: person?.name ?? null,
        mayApply,
      }
      return {
        ...workStepOf(facts),
        person,
        ref: entry.changeId ? { type: 'WorkOrderChange', id: entry.changeId, number: null } : null,
        workOrder: workOrder ? { id: workOrder.id, number: workOrder.number } : null,
        cells: entry.cells.map((cell) => ({ seq: seqOf.get(cell.salesOrderLineId) ?? 0, size: cell.size, from: cell.from, to: cell.to })),
        extra: facts.extra,
      }
    })
  const workOrdersLeftOut = workOrderIds.filter((id) => !reached(id)).length

  // AMEND: this Accept.
  const amendment = accepted && row.amendmentId ? await db.salesOrderAmendment.findUnique({ where: { id: row.amendmentId }, select: { revision: true } }) : null
  const amend: Draft = {
    ...amendStepOf({ kind, status, wholeCancel: kind === 'CANCEL' && cells.length === 0, revision: amendment?.revision ?? null, problems: held, mayAnswer: view?.mayAnswer ?? false }),
    person: null,
    ref: accepted && row.amendmentId ? { type: 'SalesOrderAmendment', id: row.amendmentId, number: amendment ? String(amendment.revision) : null } : null,
    workOrder: null,
    cells: [],
    extra: 0,
  }

  // REPROMISE: the earliest date the change leaves (kept at Send) against the promise; after Accept, planning's re-promises since.
  const earliest = keptImpactOf(row.impact)?.earliest?.date ?? null
  const proposals = accepted && row.answeredAt ? (await readProposals(db, [order.id])).filter((proposal) => proposal.proposedAt.getTime() >= row.answeredAt!.getTime()) : []
  const decided = proposals.filter((proposal) => proposal.state === 'ACCEPTED' || proposal.state === 'DECLINED' || proposal.state === 'WITHDRAWN').length
  const repromise = repromiseStepOf({
    accepted,
    promise: dayOrNull(order.promiseDate),
    earliest,
    waitingProposals: proposals.filter((proposal) => proposal.state === 'WAITING').length,
    decidedProposals: decided,
    mayChange: can(actor, ORDERS_MANAGE, place),
  })

  // TELL_WORKSHOP (R8): the outside workshops making the asked lines; told once a notice is written on their subcontract order.
  const askedLineIds = unique(askedRowsOf(cells, lines).map((entry) => entry.lineId))
  const lineCells = (await workCellsOf(db, context.tenantId, askedLineIds)).filter((cell) => cell.status !== 'CANCELLED')
  const madeBy = unique(lineCells.map((cell) => cell.workOrderId))
  const outside = madeBy.length > 0 ? await db.subcontractOrder.findMany({ where: { workOrderId: { in: madeBy }, status: { in: [...AT_WORKSHOP] } }, select: { id: true } }) : []
  const told =
    accepted && row.answeredAt && outside.length > 0
      ? (await db.notification.findMany({ where: { recordType: 'SubcontractOrder', recordId: { in: outside.map((entry) => entry.id) }, partyId: { not: null }, createdAt: { gte: row.answeredAt } }, select: { recordId: true }, distinct: ['recordId'] })).length
      : 0
  const workshop = waiting || accepted ? workshopStepOf({ workshops: outside.length, told }) : null

  const extraNone: Omit<PlanStep, keyof ApplyStep | 'seq'> = { person: null, ref: null, workOrder: null, cells: [], extra: 0 }
  const closed = status === 'REFUSED' || status === 'WITHDRAWN'
  const production = isProductionAccept(kind)
  const next: PlanStep[] = closed || production ? [] : numbered<Draft>([amend, ...workSteps, repromise ? { ...repromise, ...extraNone } : null, workshop ? { ...workshop, ...extraNone } : null])

  // The extra pieces (before Accept: planned; after: stored with their outcome).
  const pieces = entries.flatMap((entry) => entry.extra.map((piece) => ({ lineId: piece.salesOrderLineId, seq: seqOf.get(piece.salesOrderLineId) ?? 0, size: piece.size, count: piece.count, words: CHANGE_WORDS.extra(piece.count, piece.size) })))
  const total = pieces.reduce((sum, piece) => sum + piece.count, 0)
  const chosen = entries.find((entry) => entry.extraOutcome !== null)?.extraOutcome ?? null

  return {
    request: { id: row.id, kind, status, version: row.version, orderId: order.id, orderNumber: order.number },
    words: closed ? APPLY_WORDS.closed(status) : production ? APPLY_WORDS.production : null,
    extra: {
      pieces,
      total,
      outcomes: total > 0 ? outcomeOptionsOf({ customer, seesPrices: heldGrains(actor).has('price') }) : [],
      chosen,
      needsOutcome: waiting && total > 0,
      words: total > 0 && waiting ? CHANGE_WORDS.chooseExtra(total) : null,
    },
    next,
    workOrdersLeftOut,
  }
}

/** "On the floor now" (workorders.view over the order's customer): the asked cells' own figures, the bundles in work. */
async function floorOf(db: Reader, context: OfficeContext, order: OrderRow, cells: readonly AskedCell[], now: Date) {
  const lines = await readLines(db, order.id)
  const asked = askedRowsOf(cells, lines)
  const progress = await officeProgressFor(db, context.tenantId, order.id, lines, now)
  const own = progress.cells.cells
  const workOrders = new Map((own.length > 0 ? await db.workOrder.findMany({ where: { id: { in: unique(own.map((cell) => cell.workOrderId)) } }, select: { id: true, status: true } }) : []).map((entry) => [entry.id, entry.status as string]))
  const ofRow = (entry: { lineId: string; size: string | null }) => own.filter((cell) => cell.lineId === entry.lineId && (entry.size === null || cell.size === entry.size))
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const rows = asked.map((entry) => {
    const line = lineOf.get(entry.lineId)
    const mine = ofRow(entry)
    const packed = progress.cells.packed.filter((row) => row.lineId === entry.lineId && (entry.size === null || row.size === entry.size)).reduce((sum, row) => sum + row.quantity, 0)
    return {
      lineId: entry.lineId,
      seq: line?.seq ?? 0,
      size: entry.size,
      ordered: entry.size === null ? (line?.quantity ?? 0) : (line?.sizes.find((size) => size.size === entry.size)?.quantity ?? 0),
      asked: entry.asked,
      inWorkOrders: mine.reduce((sum, cell) => sum + cell.quantity, 0),
      cut: sumOrNull(mine.map((cell) => cell.cut)),
      sewn: sumOrNull(mine.map((cell) => cell.sewn)),
      packed,
    }
  })
  const working = unique(asked.flatMap((entry) => ofRow(entry)).filter((cell) => (IN_WORK as readonly string[]).includes(workOrders.get(cell.workOrderId) ?? '')).map((cell) => cell.cellId))
  const bundles = working.length > 0 ? await db.bundle.count({ where: { status: 'ACTIVE', workOrderSizeId: { in: working } } }) : 0
  const all = unique(asked.flatMap((entry) => ofRow(entry)))
  const started = all.filter((cell) => (IN_WORK as readonly string[]).includes(workOrders.get(cell.workOrderId) ?? '') || workOrders.get(cell.workOrderId) === 'COMPLETED')
  const stage = floorStageOf({
    started: started.reduce((sum, cell) => sum + cell.quantity, 0),
    cut: sumOrNull(all.map((cell) => cell.cut)),
    sewn: sumOrNull(all.map((cell) => cell.sewn)),
    checked: sumOrNull(all.map((cell) => cell.inspected)),
    packed: rows.reduce((sum, row) => sum + row.packed, 0),
  })
  return { cells: rows, inWork: { bundles, stage, words: inWorkWords(bundles, stage) } }
}

/** GET /sales/change-requests/:requestId/apply-plan (see the file's head). */
export async function applyPlan(caller: CommandCaller, requestId: string, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const { row, order } = await officeRequest(db, context, requestId)
    const seesFloor = can(actor, WORKORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })
    const plan = await planOf(db, context, row, order, now)
    const cells = (await readCells(db, [row.id])).get(row.id) ?? []
    const floor = seesFloor ? await floorOf(db, context, order, cells, now) : null
    return {
      asOf: toUtcIso(now),
      ...plan,
      floor: floor ? { ...floor, workOrdersLeftOut: plan.workOrdersLeftOut } : null,
      withheld: seesFloor ? [] : (['floor'] as const).slice(),
      live: { events: [...APPLY_PLAN_LIVE_EVENTS] },
    }
  })
}
