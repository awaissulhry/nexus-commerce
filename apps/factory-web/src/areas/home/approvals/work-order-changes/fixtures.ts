import { CHANGE_WORDS } from '@nexus/factory-domain/order-apply/rules'
import { workOrder as baseWorkOrder } from '../../../production/_shared/fixtures'
import type { WorkOrder } from '../../../production/_shared/api'
import { DEPTH_ROWS, depthModel } from '../depth/fixtures'
import type { InboxRow } from '../inbox'
import type { InboxViewModel } from '../model'
import type { WorkOrderChange } from './api'
import type { ChangeReviewModel, LayRecord } from './model'

/**
 * F-SA-245 — work-order changes in the office: the design cases (SCR-030, Home › Approvals; the work order's band notice draws the
 * same window), made-up data only (PLAN §3.1): the customer "Brand Alpha", its order SO-DEMO-0142, the work order WO-DEMO-0142
 * (cut and bundled as the production fixtures make it), the lay CO-DEMO-0007, the planner "Carla Prova". The window: a lowering
 * with an extra piece kept as leftover; held "Re-plan the lay first" with a door to the lay; held "changed since — propose
 * again"; a refusal of the API with Read again; Leave as is…; a raise that makes a new work order; a reader who may not decide;
 * one decided already; and another customer's (the neutral "not there any more").
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const id = (n: number) => `0190f0e2-3090-7000-8000-${String(n).padStart(12, '0')}`
const both = (words: { en: string; it: string }) => ({ en: words.en, it: words.it })

const ORDER = { id: id(500), number: 'SO-DEMO-0142', customerRef: 'PO-ALPHA-12', status: 'IN_PRODUCTION', partyId: id(900), partyName: 'Brand Alpha', depositRequired: false }

/** WO-DEMO-0142, in progress: RED 50 3 (all 3 cut), RED 52 3 (none cut) among its sizes — Brand Alpha's only. */
export const WORK_ORDER: WorkOrder = baseWorkOrder('IN_PROGRESS', { number: 'WO-DEMO-0142', orders: [ORDER], customer: { id: ORDER.partyId, code: 'ALP', name: 'Brand Alpha' }, partyId: ORDER.partyId })
const cellOf = (colour: string, size: string) => WORK_ORDER.cells.find((cell) => cell.colourwayCode === colour && cell.size === size)!
const RED50 = cellOf('RED', '50')
const RED52 = cellOf('RED', '52')

export function change(overrides: Partial<WorkOrderChange> = {}): WorkOrderChange {
  const cells = overrides.cells ?? [
    { salesOrderLineId: RED50.salesOrderLineId!, lineSeq: RED50.lineSeq, size: '50', from: 3, to: 2, workOrderSizeId: RED50.id },
    { salesOrderLineId: RED52.salesOrderLineId!, lineSeq: RED52.lineSeq, size: '52', from: 3, to: 1, workOrderSizeId: RED52.id },
  ]
  return {
    id: id(1),
    status: 'PROPOSED',
    kind: 'LOWER_TO_ORDER',
    partyId: ORDER.partyId,
    salesOrder: { id: ORDER.id, number: ORDER.number },
    workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: WORK_ORDER.status },
    requestId: id(700),
    amendmentId: null,
    cells,
    extra: [{ workOrderSizeId: RED50.id, salesOrderLineId: RED50.salesOrderLineId!, size: '50', count: 1, words: both(CHANGE_WORDS.extra(1, '50')) }],
    extraOutcome: 'LEFTOVER',
    reason: 'Brand Alpha asked for fewer red jackets: line 2, 50 3 → 2, 52 3 → 1.',
    lastError: null,
    proposedBy: { id: id(800), name: 'Bea Esempio' },
    proposedAt: at(18, 10, 42),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    madeWorkOrder: null,
    version: 1,
    mayDecide: true,
    words: { title: both(CHANGE_WORDS.title(WORK_ORDER.number)), status: both(CHANGE_WORDS.status('PROPOSED')), cells: CHANGE_WORDS.cells(cells) },
    ...overrides,
  }
}

/** A leather lay still planned (it follows the work order down) and a fabric lay already fixed for RED 52 (it stops a lowering). */
export const LAY_FOLLOWS: LayRecord = { cutOrder: { id: id(601), number: 'CO-DEMO-0006', kind: 'LEATHER', status: 'PLANNED' }, lines: [{ id: id(611), seq: 1, workOrderSizeId: RED52.id, quantity: 3 }] }
export const LAY_FIXED: LayRecord = { cutOrder: { id: id(602), number: 'CO-DEMO-0007', kind: 'FABRIC', status: 'PLANNED' }, lines: [{ id: id(612), seq: 1, workOrderSizeId: RED52.id, quantity: 3 }] }

export function review(overrides: Partial<ChangeReviewModel> = {}, value: WorkOrderChange = change()): ChangeReviewModel {
  return { id: value.id, change: { status: 'ready', value }, workOrder: { status: 'ready', value: WORK_ORDER }, lays: { status: 'ready', value: [LAY_FOLLOWS] }, customer: 'Brand Alpha', dialog: null, problem: null, ...overrides }
}

/** Today's row of the change (B-SA-044: its key `WORK_ORDER_CHANGE:<work order id>:change:<change id>`). */
export function changeRow(value: WorkOrderChange = change()): InboxRow {
  return {
    key: `WORK_ORDER_CHANGE:${WORK_ORDER.id}:change:${value.id}`,
    source: 'attention',
    kind: 'WORK_ORDER_CHANGE',
    since: value.proposedAt,
    due: null,
    overdue: false,
    companyId: WORK_ORDER.companyId,
    href: `/w/DEMO/production/work-orders/${WORK_ORDER.id}`,
    item: {
      key: `WORK_ORDER_CHANGE:${WORK_ORDER.id}:change:${value.id}`,
      kind: 'WORK_ORDER_CHANGE',
      state: 'PROPOSED',
      category: 'APPROVAL',
      severity: 'HIGH',
      severityWord: 'High',
      group: 'TODAY',
      record: { type: 'WorkOrder', id: WORK_ORDER.id, label: WORK_ORDER.number },
      companyId: WORK_ORDER.companyId,
      siteId: WORK_ORDER.siteId,
      partyId: ORDER.partyId,
      sentence: '',
      why: '',
      blocks: null,
      words: { sentence: { key: 'WORK_ORDER_CHANGE.LOWER_EXTRA', params: { number: WORK_ORDER.number, order: ORDER.number, cells: value.words.cells, extra: '1 50' } }, why: { key: 'why.WORK_ORDER_CHANGE.workorders_manage', params: {} }, blocks: null },
      sentenceFigure: null,
      due: null,
      since: value.proposedAt,
      ageDays: 0,
      decide: 'OPEN',
      figures: null,
      condition: 'PROPOSED',
      actions: { version: 0, verbs: [], assigned: null, acknowledged: null },
    } as unknown as NonNullable<InboxRow['item']>,
  }
}

const inbox = (overrides: Partial<InboxViewModel> = {}): InboxViewModel =>
  depthModel({ rows: { items: [...DEPTH_ROWS.WAITING_ROWS, changeRow()], problem: null }, counts: { waiting: 11, overdue: 1, mine: 2, decided: 6 }, ...overrides })
const open = (value: string) => ({ view: 'waiting' as const, kind: null, q: '', changed: false, open: value })

export const CHANGE_FIXTURES = { WORK_ORDER, ORDER, RED50, RED52 }

export const CHANGE_CASES: readonly { id: string; label: string; model: InboxViewModel; note?: string }[] = [
  { id: 'f-sa-245-lower', label: 'F-SA-245 · a work order change: Lower to the order, the extra piece kept as leftover', model: inbox({ controls: open(id(1)), changeReview: review() }), note: 'Each size before → after beside what the work order makes now and what is already cut and bundled; the extra piece and its outcome; the lay that follows it down.' },
  { id: 'f-sa-245-lay', label: 'F-SA-245 · "Re-plan the lay first": a fabric lay fixed for the size holds more', model: inbox({ controls: open(id(1)), changeReview: review({ lays: { status: 'ready', value: [LAY_FIXED] } }) }), note: 'Apply is held with why, and the notice opens CO-DEMO-0007.' },
  { id: 'f-sa-245-changed', label: 'F-SA-245 · the work order changed since it was proposed', model: inbox({ controls: open(id(1)), changeReview: review({ workOrder: { status: 'ready', value: { ...WORK_ORDER, cells: WORK_ORDER.cells.map((cell) => (cell.id === RED52.id ? { ...cell, quantity: 2 } : cell)) } } }) }) },
  { id: 'f-sa-245-refused', label: 'F-SA-245 · Apply refused by the API, in our words, with Read again', model: inbox({ controls: open(id(1)), changeReview: review({ problem: { key: 'workOrderChange.refusal.CUTTING_UNDER_WAY', code: 'CUTTING_UNDER_WAY', lay: 'CO-DEMO-0006', reload: true, holds: true } }) }) },
  { id: 'f-sa-245-leave', label: 'F-SA-245 · Leave as is…: why it stays as it is', model: inbox({ controls: open(id(1)), changeReview: review({ dialog: { kind: 'decline', words: '', busy: false, problem: null } }) }) },
  {
    id: 'f-sa-245-new',
    label: 'F-SA-245 · a raise no open draft can take: Make the new work order',
    model: inbox({
      controls: open(id(2)),
      changeReview: review({ workOrder: null, lays: null }, change({ id: id(2), kind: 'MAKE_MORE', workOrder: null, extra: [], extraOutcome: null, cells: [{ salesOrderLineId: RED52.salesOrderLineId!, lineSeq: RED52.lineSeq, size: '52', from: 0, to: 2, workOrderSizeId: null }], words: { title: both(CHANGE_WORDS.title(null)), status: both(CHANGE_WORDS.status('PROPOSED')), cells: '52 0 → 2' } })),
    }),
  },
  { id: 'f-sa-245-reader', label: 'F-SA-245 · a reader who does not manage the work order: held, says who decides', model: inbox({ controls: open(id(1)), changeReview: review({ workOrder: null, lays: null }, change({ mayDecide: false })) }) },
  {
    id: 'f-sa-245-decided',
    label: 'F-SA-245 · decided already: left as is, with why',
    model: inbox({ controls: open(id(1)), changeReview: review({}, change({ status: 'DECLINED', mayDecide: false, decidedAt: at(18, 14), decidedBy: { id: id(801), name: 'Carla Prova' }, decisionNote: 'The extra red jackets are already sewn: we keep them.', words: { title: both(CHANGE_WORDS.title(WORK_ORDER.number)), status: both(CHANGE_WORDS.status('DECLINED')), cells: CHANGE_WORDS.cells(change().cells) } })) }),
  },
  { id: 'f-sa-245-not-found', label: 'F-SA-245 · another customer’s change: "not there any more", naming nobody', model: inbox({ controls: open(id(99)), changeReview: { ...review(), id: id(99), change: { status: 'not_found' }, workOrder: null, lays: null, customer: null } }) },
]
