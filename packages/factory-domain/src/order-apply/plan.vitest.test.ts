import { describe, expect, it } from 'vitest'
import type { Actor, Permission } from '../core/permissions'
import { FOLLOW_WORDS, followDecisionOf, workOrderPlanOf, type PlanWorkOrder } from './plan'
import { CHANGE_WORDS, type PlannedChange } from './rules'

/**
 * B-OP-013 (order page plan N2, D1 + D3; review R-4, R-11): the plan a preview says of each work order — the command's own rule
 * (apps/factory-api work-order-changes auto.ts followInCommand calls followDecisionOf). Every id and number is made up.
 */

const ORDER = { companyId: 'company-a', partyId: 'brand-alpha' }
const LINE = 'line-10'
const office = (permissions: Permission[], parties: 'all' | string[] = 'all'): Actor => ({ audience: 'office', tenantId: 'tenant-1', grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
/** Sales: may change the order, sees no work orders (the role template). */
const SALES = office(['orders.view', 'orders.manage'])
/** Sales that reads work orders, may not change them. */
const SALES_READS = office(['orders.view', 'orders.manage', 'workorders.view'])
/** The Owner (and a planner who may also change orders): every right, every customer. */
const OWNER = office(['orders.view', 'orders.manage', 'workorders.view', 'workorders.manage'])
/** The same rights, limited to Brand Alpha. */
const ALPHA_ONLY = office(['orders.view', 'orders.manage', 'workorders.view', 'workorders.manage'], ['brand-alpha'])

const workOrder = (over: Partial<PlanWorkOrder> = {}): PlanWorkOrder => ({ id: 'wo-1', number: 'WO-0042', status: 'RELEASED', kind: 'SIZE_GRID', companyId: 'company-a', siteId: 'site-1', partyId: 'brand-alpha', cellIds: ['cell-m', 'cell-l'], ...over })
const lower = (cells: { size: string; from: number; to: number; cellId: string }[], over: Partial<PlannedChange> = {}): PlannedChange => ({
  kind: 'LOWER_TO_ORDER',
  workOrderId: 'wo-1',
  number: 'WO-0042',
  styleId: 'style-1',
  siteId: 'site-1',
  cells: cells.map((cell) => ({ salesOrderLineId: LINE, size: cell.size, from: cell.from, to: cell.to, workOrderSizeId: cell.cellId })),
  extra: [],
  ...over,
})
const planOne = (change: PlannedChange, actor: Actor, wo: PlanWorkOrder | null = workOrder(), cut: Record<string, number> = {}) => workOrderPlanOf([change], new Map(wo ? [[wo.id, wo]] : []), actor, ORDER, new Map(Object.entries(cut)))[0]!

describe('who carries the work orders along in the same click (D1, B-OP-012\'s rule)', () => {
  it('a DRAFT follows for whoever may change the order; a released one only with workorders.manage over it', () => {
    const draft = lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }])
    expect(planOne(draft, SALES, workOrder({ status: 'DRAFT' }))).toMatchObject({ route: 'SET_DRAFT_CELLS', appliesNow: true, held: null, reprint: false })
    expect(planOne(draft, SALES)).toMatchObject({ route: 'LOWER_RELEASED', appliesNow: false })
    expect(planOne(draft, OWNER)).toMatchObject({ route: 'LOWER_RELEASED', appliesNow: true, held: null })
    expect(followDecisionOf(SALES, ORDER, draft, workOrder({ status: 'DRAFT' }))).toEqual({ route: 'SET_DRAFT_CELLS', right: 'ORDER' })
    expect(followDecisionOf(OWNER, ORDER, draft, workOrder({ status: 'IN_PROGRESS' }))).toEqual({ route: 'LOWER_RELEASED', right: 'WORK_ORDER' })
  })

  it('waits with words: production applies a released one; the wall names no work order to a reader who does not reach it', () => {
    const change = lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }])
    // Sales that reads work orders: the work order is named, production applies it.
    expect(planOne(change, SALES_READS)).toMatchObject({ workOrderId: 'wo-1', number: 'WO-0042', status: 'RELEASED', appliesNow: false, held: FOLLOW_WORDS.production('WO-0042') })
    // Sales without workorders.view: "a work order", no id, no number, no status.
    const unseen = planOne(change, SALES)
    expect(unseen).toMatchObject({ workOrderId: null, number: null, status: null, appliesNow: false, held: FOLLOW_WORDS.unseen() })
    expect(JSON.stringify(unseen)).not.toContain('WO-0042')
  })

  it('a mixed work order (made before the one-customer rule) is never changed from an order, and named only to every customer', () => {
    const change = lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }])
    expect(planOne(change, OWNER, workOrder({ partyId: null }))).toMatchObject({ number: 'WO-0042', appliesNow: false, held: FOLLOW_WORDS.shared('WO-0042') })
    expect(planOne(change, ALPHA_ONLY, workOrder({ partyId: null }))).toMatchObject({ workOrderId: null, number: null, status: null, appliesNow: false, held: FOLLOW_WORDS.unseen() })
  })

  it('a new DRAFT (more pieces) is made in the click by whoever may change the order; a released one never makes more', () => {
    const more: PlannedChange = { kind: 'MAKE_MORE', workOrderId: null, number: null, styleId: 'style-1', siteId: null, cells: [{ salesOrderLineId: LINE, size: 'M', from: 0, to: 4, workOrderSizeId: null }], extra: [] }
    expect(planOne(more, SALES, null)).toMatchObject({ kind: 'MAKE_MORE', workOrderId: null, route: 'NEW_DRAFT', appliesNow: true, cells: [{ lineId: LINE, size: 'M', from: 0, to: 4, cut: 0 }] })
    expect(planOne(more, office(['orders.view']), null)).toMatchObject({ route: 'NEW_DRAFT', appliesNow: false, held: FOLLOW_WORDS.unseen() })
    expect(planOne(more, office(['orders.view', 'workorders.view']), null)).toMatchObject({ appliesNow: false, held: FOLLOW_WORDS.notNow(null) })
  })
})

describe('the route on the work order as it is now, never below cut (D3)', () => {
  it('on hold or no longer open: no route now, the route\'s words', () => {
    const change = lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }])
    expect(planOne(change, OWNER, workOrder({ status: 'ON_HOLD' }))).toMatchObject({ route: null, appliesNow: false, held: CHANGE_WORDS.onHold('WO-0042') })
    expect(planOne(change, OWNER, workOrder({ status: 'COMPLETED' }))).toMatchObject({ route: null, appliesNow: false, held: CHANGE_WORDS.workOrderDone('WO-0042') })
    expect(followDecisionOf(OWNER, ORDER, change, workOrder({ status: 'ON_HOLD' }))).toEqual({ why: CHANGE_WORDS.onHold('WO-0042'), lastError: CHANGE_WORDS.onHold('WO-0042').en })
  })

  it('every cell to 0 cancels the work order; a cut made-to-measure unit waits (scrap it with its approval)', () => {
    const all = lower([
      { size: 'M', from: 40, to: 0, cellId: 'cell-m' },
      { size: 'L', from: 20, to: 0, cellId: 'cell-l' },
    ])
    expect(planOne(all, SALES, workOrder({ status: 'DRAFT' }))).toMatchObject({ route: 'CANCEL_WORK_ORDER', appliesNow: true, reprint: false })
    const unit = lower([{ size: '52', from: 1, to: 0, cellId: 'cell-u' }])
    const mtm = workOrder({ kind: 'MADE_TO_MEASURE', cellIds: ['cell-u'] })
    expect(planOne(unit, OWNER, mtm)).toMatchObject({ route: 'CANCEL_WORK_ORDER', appliesNow: true })
    expect(planOne(unit, OWNER, mtm, { 'cell-u': 1 })).toMatchObject({ route: 'CANCEL_WORK_ORDER', appliesNow: false, held: CHANGE_WORDS.unitCut('WO-0042'), cells: [{ cut: 1 }] })
  })

  it('names what is cut of each cell; a released work order whose cell goes down is reprinted, one held at its cut is not', () => {
    const below = lower([{ size: 'M', from: 40, to: 30, cellId: 'cell-m' }], { extra: [{ workOrderSizeId: 'cell-m', salesOrderLineId: LINE, size: 'M', count: 8 }] })
    expect(planOne(below, OWNER, workOrder(), { 'cell-m': 38 })).toMatchObject({ cells: [{ size: 'M', from: 40, to: 30, cut: 38 }], extra: 8, appliesNow: true, reprint: true })
    // Everything cut already: the cell stays where it is, nothing to reprint.
    expect(planOne(below, OWNER, workOrder(), { 'cell-m': 40 })).toMatchObject({ appliesNow: true, reprint: false })
    // A DRAFT is never reprinted (no traveller yet).
    expect(planOne(below, SALES, workOrder({ status: 'DRAFT' }))).toMatchObject({ appliesNow: true, reprint: false })
    // Waiting for production: the mark says what its apply will need.
    expect(planOne(below, SALES_READS, workOrder(), { 'cell-m': 38 })).toMatchObject({ appliesNow: false, reprint: true })
  })

  it('a work order not found (another\'s, or gone) is named by nothing and waits', () => {
    const change = lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }])
    expect(planOne(change, OWNER, null)).toMatchObject({ workOrderId: null, number: null, status: null, route: null, appliesNow: false, held: FOLLOW_WORDS.unseen() })
  })

  it('keeps the gap\'s order: lowerings first, then what is made more', () => {
    const more: PlannedChange = { kind: 'MAKE_MORE', workOrderId: null, number: null, styleId: 'style-1', siteId: null, cells: [{ salesOrderLineId: 'line-20', size: 'S', from: 0, to: 2, workOrderSizeId: null }], extra: [] }
    const rows = workOrderPlanOf([lower([{ size: 'M', from: 40, to: 36, cellId: 'cell-m' }]), more], new Map([['wo-1', workOrder({ status: 'DRAFT' })]]), SALES, ORDER)
    expect(rows.map((row) => [row.kind, row.route, row.appliesNow])).toEqual([
      ['LOWER_TO_ORDER', 'SET_DRAFT_CELLS', true],
      ['MAKE_MORE', 'NEW_DRAFT', true],
    ])
  })
})
