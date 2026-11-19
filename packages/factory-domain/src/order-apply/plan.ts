import { can, reachesEveryParty, type Actor, type Permission } from '../core/permissions'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '../production/work-orders/permissions'
import { ORDERS_MANAGE } from '../sales/orders/permissions'
import { applyRouteOf, CHANGE_WORDS, takesEveryCell, type ApplyRoute, type ChangeCell, type PlannedChange, type WorkOrderChangeKind, type Words } from './rules'

/**
 * B-OP-013 (order page plan N2, decisions D1 + D3; 13-backend §1.3; review R-4, R-11; B2), pure: what an office change of a sales
 * order will do to its work orders, said BEFORE it is applied — the amendment's and the priced change's previews, the close of
 * lines' and the cancel's, and a customer request's apply plan. ONE rule decides, for the preview and for the command
 * (apps/factory-api production/work-order-changes auto.ts followInCommand), whether each change the gap proposes follows in the
 * same click or waits (B-OP-012):
 *
 *   a DRAFT's change              SET_DRAFT_CELLS, a DRAFT's CANCEL_WORK_ORDER, MAKE_MORE's NEW_DRAFT: anyone who may change the
 *                                 order (orders.manage over its company and customer): nothing is on the floor yet (D1)
 *   a released work order's       LOWER_RELEASED, the cancel of a released one: only a holder of workorders.manage over the work
 *                                 order's company, site and customer (the brand wall); else it waits for production (D1). Never
 *                                 below cut: the cell stops at what is cut, the rest are extra pieces; the traveller is reprinted
 *                                 when a cell goes down (D3)
 *   a mixed work order            one made before the one-customer rule (no customer) is never changed from an order (R-11)
 *   a route it cannot take now    on hold, no longer open, released for a raise: it waits with the route's words; a cut
 *                                 made-to-measure unit is never cancelled (scrap it with its approval)
 *
 * The wall: a work order the reader does not reach with workorders.view (its customer and site; a mixed one: every customer) is
 * "a work order" — no id, no number, no status, words that name none — as the order's Still to do says it.
 */

/** factory-api WorkOrderChange apply routes (the answer of an office change carries the same). */
export const APPLY_ROUTES = ['SET_DRAFT_CELLS', 'LOWER_RELEASED', 'CANCEL_WORK_ORDER', 'NEW_DRAFT'] as const satisfies readonly ApplyRoute[]

/** Who carries out a route that follows now: ORDER — whoever may change the order (a DRAFT's); WORK_ORDER — workorders.manage over it. */
export type FollowRight = 'ORDER' | 'WORK_ORDER'

/** A work order a plan names, as it is now: its scope (one customer; null: mixed, made before the rule) and every cell it has. */
export interface PlanWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly kind: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string | null
  /** Every cell of the work order now (a lowering that takes each one to 0 cancels it). */
  readonly cellIds: readonly string[]
}

/** The order a change is of (orders.manage is asked over its company and customer). */
export interface PlanOrder {
  readonly companyId: string
  readonly partyId: string
}

/** Words the order page shows of a change that waits (it + en; a work order's number only when the reader sees it). */
export const FOLLOW_WORDS = {
  production: (number: string): Words => ({
    en: `${number} is released: production applies the change (a planner or a production manager).`,
    it: `${number} è rilasciato: la modifica la applica la produzione (un pianificatore o un responsabile di produzione).`,
  }),
  shared: (number: string): Words => ({ en: `${number} is shared with other customers: change it on its own page.`, it: `${number} è condiviso con altri clienti: cambialo dalla sua pagina.` }),
  /** A work order the reader does not reach: named by nothing. */
  unseen: (): Words => ({ en: 'A work order waits: production applies the change on its own page.', it: 'Un ordine di lavoro è in attesa: la modifica la applica la produzione dalla sua pagina.' }),
  notNow: (number: string | null): Words =>
    number
      ? { en: `${number} waits: apply the change from the order page.`, it: `${number} è in attesa: applica la modifica dalla pagina dell'ordine.` }
      : { en: 'The new work order waits: apply the change from the order page.', it: "Il nuovo ordine di lavoro è in attesa: applica la modifica dalla pagina dell'ordine." },
  refused: (number: string | null): Words =>
    number
      ? { en: `${number} waits: its change could not be applied now — see why on the change, then apply it again.`, it: `${number} è in attesa: la sua modifica non si è potuta applicare ora — vedi il perché sulla modifica, poi applicala di nuovo.` }
      : { en: 'The new work order waits: it could not be made now — see why on the change, then apply it again.', it: 'Il nuovo ordine di lavoro è in attesa: non si è potuto fare ora — vedi il perché sulla modifica, poi applicala di nuovo.' },
} as const

/** The words of a route's refusal on the work order as it is ("WO-0042 is on hold: lift the hold first, then apply the change."). */
export const routeRefusalWords = (refusal: 'WORK_ORDER_DONE' | 'ON_HOLD' | 'NOT_A_DRAFT', number: string): Words =>
  refusal === 'ON_HOLD' ? CHANGE_WORDS.onHold(number) : refusal === 'NOT_A_DRAFT' ? CHANGE_WORDS.notADraft(number) : CHANGE_WORDS.workOrderDone(number)

/** Does the person hold `permission` over the work order (a mixed one, of no customer: only over every customer)? */
export function reachesPlanWorkOrder(actor: Actor, permission: Permission, workOrder: Pick<PlanWorkOrder, 'companyId' | 'siteId' | 'partyId'>): boolean {
  const place = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  return workOrder.partyId === null ? reachesEveryParty(actor, permission, place) : can(actor, permission, { ...place, partyId: workOrder.partyId })
}

/** Follows now (its route and the right it is carried out with), or waits with why (`lastError`: the words kept on the change). */
export type FollowDecision = { readonly route: ApplyRoute; readonly right: FollowRight } | { readonly why: Words; readonly lastError: string | null }

/**
 * THE rule (see the file's head): whether a proposed change follows the office change in its command, by its route on the work
 * order as it is now, or waits and why. `workOrder` null for a change that names one: it was not found (it waits, named by nothing).
 */
export function followDecisionOf(actor: Actor, order: PlanOrder, change: { readonly kind: WorkOrderChangeKind; readonly workOrderId: string | null; readonly cells: readonly ChangeCell[] }, workOrder: PlanWorkOrder | null): FollowDecision {
  const mayChangeOrder = can(actor, ORDERS_MANAGE, { companyId: order.companyId, partyId: order.partyId })
  if (change.kind === 'MAKE_MORE' && change.workOrderId === null) return mayChangeOrder ? { route: 'NEW_DRAFT', right: 'ORDER' } : { why: FOLLOW_WORDS.notNow(null), lastError: null }
  if (!workOrder) return { why: FOLLOW_WORDS.unseen(), lastError: null }
  // R-11: a work order of several customers (made before the one-customer rule) is never changed from an order.
  if (workOrder.partyId === null) return { why: FOLLOW_WORDS.shared(workOrder.number), lastError: null }
  if (workOrder.partyId !== order.partyId) return { why: FOLLOW_WORDS.notNow(workOrder.number), lastError: null }
  const route = applyRouteOf({ kind: change.kind, workOrderId: workOrder.id }, workOrder, change.kind === 'LOWER_TO_ORDER' && takesEveryCell(change.cells, workOrder.cellIds))
  if ('refusal' in route) {
    const words = routeRefusalWords(route.refusal, workOrder.number)
    return { why: words, lastError: words.en }
  }
  // D1: a DRAFT follows for whoever may change the order; a released work order only for workorders.manage over it (the wall).
  if (workOrder.status === 'DRAFT') return mayChangeOrder ? { route: route.route, right: 'ORDER' } : { why: FOLLOW_WORDS.notNow(workOrder.number), lastError: null }
  return reachesPlanWorkOrder(actor, WORKORDERS_MANAGE, workOrder) ? { route: route.route, right: 'WORK_ORDER' } : { why: FOLLOW_WORDS.production(workOrder.number), lastError: null }
}

/** Is the work order named to this reader (workorders.view over it; a new DRAFT is of the order's customer)? */
export const seesWorkOrder = (actor: Actor, order: PlanOrder, workOrder: PlanWorkOrder | null): boolean =>
  workOrder ? reachesPlanWorkOrder(actor, WORKORDERS_VIEW, workOrder) : can(actor, WORKORDERS_VIEW, { companyId: order.companyId, partyId: order.partyId })

/** One cell of a plan row: its line and size, what the work order makes now → what the change asks, and what is cut of it. */
export interface PlanCell {
  readonly lineId: string
  readonly size: string
  readonly from: number
  readonly to: number
  /** Already cut (the database's floor; 0 on a DRAFT and on a new cell): the cell never goes below it. */
  readonly cut: number
}

/** What will happen to one work order (or a new DRAFT), said before the office change is applied. */
export interface WorkOrderPlanRow {
  readonly kind: WorkOrderChangeKind
  /** The work order (null: a new DRAFT, or one the reader does not reach). */
  readonly workOrderId: string | null
  readonly number: string | null
  /** Its status now (null: a new DRAFT, or one the reader does not reach). */
  readonly status: string | null
  /** How it will be carried out (null: it cannot be now — `held` says why). */
  readonly route: ApplyRoute | null
  readonly cells: PlanCell[]
  /** Pieces already cut beyond the new figures (their outcome is chosen with the change). */
  readonly extra: number
  /** It follows in the same click (B-OP-012); false: it waits, PROPOSED, with `held`. */
  readonly appliesNow: boolean
  readonly held: Words | null
  /** Once applied, a traveller printed before is out of date: a released work order whose cells go down (D3). */
  readonly reprint: boolean
}

/** The route a change takes on the work order as it is, whoever carries it out (null: none now). */
function routeNow(change: Pick<PlannedChange, 'kind' | 'workOrderId' | 'cells'>, workOrder: PlanWorkOrder | null): ApplyRoute | null {
  if (change.kind === 'MAKE_MORE' && change.workOrderId === null) return 'NEW_DRAFT'
  if (!workOrder) return null
  const route = applyRouteOf({ kind: change.kind, workOrderId: workOrder.id }, workOrder, change.kind === 'LOWER_TO_ORDER' && takesEveryCell(change.cells, workOrder.cellIds))
  return 'route' in route ? route.route : null
}

/**
 * The plan of the gap's changes for this reader (see the file's head), in the gap's order: each work order's cells from → to with
 * what is cut, whether it follows now (by followDecisionOf, the command's own rule) or waits with words, and whether its traveller
 * is reprinted. `cut`: what is cut of each cell, by cell id (the database's floor: production/work-order-changes workCellsOf).
 */
export function workOrderPlanOf(gap: readonly PlannedChange[], workOrders: ReadonlyMap<string, PlanWorkOrder>, actor: Actor, order: PlanOrder, cut: ReadonlyMap<string, number> = new Map()): WorkOrderPlanRow[] {
  return gap.map((change) => {
    const workOrder = change.workOrderId ? (workOrders.get(change.workOrderId) ?? null) : null
    const seen = seesWorkOrder(actor, order, workOrder)
    const cells: PlanCell[] = change.cells.map((cell) => ({ lineId: cell.salesOrderLineId, size: cell.size, from: cell.from, to: cell.to, cut: cell.workOrderSizeId ? (cut.get(cell.workOrderSizeId) ?? 0) : 0 }))
    const extra = change.extra.reduce((sum, piece) => sum + piece.count, 0)
    const route = routeNow(change, workOrder)
    const cutHere = cells.reduce((sum, cell) => sum + cell.cut, 0)
    // D3: a released work order lowered (or cancelled with pieces cut: lowered to what is cut) whose cell goes down is reprinted.
    const lowersReleased = workOrder !== null && workOrder.status !== 'DRAFT' && (route === 'LOWER_RELEASED' || (route === 'CANCEL_WORK_ORDER' && cutHere > 0 && workOrder.kind !== 'MADE_TO_MEASURE'))
    const reprint = lowersReleased && cells.some((cell) => Math.max(cell.to, cell.cut) < cell.from)
    const base = { kind: change.kind, workOrderId: seen ? (workOrder?.id ?? null) : null, number: seen ? (workOrder?.number ?? null) : null, status: seen ? (workOrder?.status ?? null) : null, route, cells, extra, reprint }
    const decision = followDecisionOf(actor, order, change, workOrder)
    if ('why' in decision) return { ...base, appliesNow: false, held: seen ? decision.why : FOLLOW_WORDS.unseen() }
    // A cut made-to-measure unit is never cancelled from an order (the apply refuses it: UNIT_CUT): it waits with those words.
    if (decision.route === 'CANCEL_WORK_ORDER' && cutHere > 0 && workOrder?.kind === 'MADE_TO_MEASURE') return { ...base, appliesNow: false, held: seen ? CHANGE_WORDS.unitCut(workOrder.number) : FOLLOW_WORDS.unseen() }
    return { ...base, route: decision.route, appliesNow: true, held: null }
  })
}
