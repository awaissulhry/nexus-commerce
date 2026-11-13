import { rolePermissions } from '../../../../shell/design-data'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { COLOURS, MATERIALS, SITE, uid } from '../../../_shared/buying/fixtures'
import type { ActionMessage, ActionMessages, BulkAnswer, ConvertAnswer, Delays, ItemProfile, PlannedList, PlannedOrder, RunLog } from './api'
import { depthCan, type DepthModel } from './model'

/**
 * B-W2b-335 — made-up data for the W2b cases of SCR-055 (never a real customer, supplier, person or number): four planned
 * orders at the demo site (a jacket made in-house with a due date the planner kept, a red run late for its order, a
 * trouser run at a demo workshop, firm, and a waistcoat whose style has no released revision), the calculated delays, four
 * action messages (one done), a run log with every count, and the projected stock of the demo leather.
 */

const RUN = uid('5501', 14)
const ORDER = (n: number) => ({ id: uid('5151', n), number: `SO-DEMO-00${n}` })
const named = (block: string, n: number, code: string, name: string) => ({ id: uid(block, n), code, name })
const JACKET = named('7070', 1, 'DEMO-JKT-01', 'Giacca demo Aero')
const TROUSERS = named('7070', 2, 'DEMO-PNT-02', 'Pantalone demo Strada')
const WAISTCOAT = named('7070', 3, 'DEMO-GIL-03', 'Gilet demo Tour')
const LINE_1 = named('7474', 1, 'L1', 'Linea demo cucito 1')
const WORKSHOP = named('7575', 1, 'DEMO-TERZ-01', 'Laboratorio demo terzista')

const planned = (n: number, over: Partial<PlannedOrder>): PlannedOrder => ({
  id: uid('5601', n),
  kind: 'MAKE',
  status: 'PLANNED',
  siteId: SITE.id,
  runId: RUN,
  style: JACKET,
  colourway: { id: uid('7676', 1), code: 'BLK' },
  revision: null,
  plannedRevision: { id: uid('7777', 1), revision: 2, status: 'RELEASED' },
  sizes: [
    { size: '48', quantity: 2 },
    { size: '50', quantity: 4 },
    { size: '52', quantity: 2 },
  ],
  quantity: 8,
  sizeGroup: null,
  startDate: '2026-11-04',
  dueDate: '2026-11-20',
  demand: [
    { orderId: ORDER(42).id, orderNumber: ORDER(42).number, orderLineId: uid('5252', 1), lineSeq: 10, size: '48', pieces: 2 },
    { orderId: ORDER(42).id, orderNumber: ORDER(42).number, orderLineId: uid('5252', 1), lineSeq: 10, size: '50', pieces: 4 },
    { orderId: ORDER(43).id, orderNumber: ORDER(43).number, orderLineId: uid('5252', 2), lineSeq: 20, size: '52', pieces: 2 },
  ],
  line: LINE_1,
  workshop: null,
  operations: [],
  outsideStepsInHouse: [],
  kitDueAt: null,
  firm: false,
  firmedAt: null,
  protectedFields: [],
  workOrder: null,
  subcontractOrder: null,
  convertedAt: null,
  note: null,
  version: 3,
  held: false,
  late: null,
  plan: {},
  may: { convert: true, firm: true, edit: true },
  ...over,
})

export const PLANNED: PlannedOrder[] = [
  planned(1, { protectedFields: ['dueDate'], plan: { dueDate: '2026-11-24' }, dueDate: '2026-11-20' }),
  planned(2, {
    colourway: { id: uid('7676', 2), code: 'RED' },
    sizes: [
      { size: '50', quantity: 3 },
      { size: '52', quantity: 3 },
    ],
    quantity: 6,
    sizeGroup: '48-52',
    startDate: '2026-10-29',
    dueDate: '2026-11-13',
    demand: [{ orderId: ORDER(44).id, orderNumber: ORDER(44).number, orderLineId: uid('5252', 3), lineSeq: 10, size: '50', pieces: 6 }],
    line: null,
    outsideStepsInHouse: [{ seq: 30, code: 'RICAMO', name: 'Ricamo logo' }],
    late: { needDate: '2026-11-10', daysLate: 3 },
  }),
  planned(3, {
    kind: 'SUBCONTRACT',
    style: TROUSERS,
    sizes: [
      { size: '46', quantity: 5 },
      { size: '48', quantity: 5 },
    ],
    quantity: 10,
    startDate: '2026-11-09',
    dueDate: '2026-11-27',
    demand: [{ orderId: ORDER(43).id, orderNumber: ORDER(43).number, orderLineId: uid('5252', 4), lineSeq: 30, size: '46', pieces: 10 }],
    line: null,
    workshop: WORKSHOP,
    operations: [{ seq: 30, code: 'CUC', name: 'Cucitura' }],
    kitDueAt: '2026-11-09T07:00:00.000Z',
    firm: true,
    firmedAt: '2026-10-28T10:00:00.000Z',
  }),
  planned(4, { style: WAISTCOAT, colourway: { id: uid('7676', 3), code: 'GRY' }, plannedRevision: null, held: true, demand: [{ orderId: ORDER(44).id, orderNumber: ORDER(44).number, orderLineId: uid('5252', 5), lineSeq: 20, size: '50', pieces: 8 }] }),
]

export const PLANNED_LIST: PlannedList = { siteId: SITE.id, run: { id: RUN, startedAt: '2026-10-29T06:02:00.000Z', finishedAt: '2026-10-29T06:02:04.000Z' }, counts: { make: 3, subcontract: 1, firm: 1 }, plannedOrders: PLANNED }

const material = (code: 'leather' | 'lining') => ({ item: { id: MATERIALS[code].id, code: MATERIALS[code].code, name: MATERIALS[code].name, kind: MATERIALS[code].kind, baseUom: MATERIALS[code].baseUom }, colour: COLOURS.black })

export const DELAYS: Delays = {
  today: '2026-10-29',
  tiles: { delayedDemands: 1, delayedOrders: 1, materials: 1, mostDaysLate: 5 },
  demands: [
    {
      order: { ...ORDER(42), rank: null },
      orderLine: { id: uid('5252', 1), seq: 10 },
      size: '50',
      workOrder: null,
      needDate: '2026-11-20',
      earliest: '2026-11-25',
      daysLate: 5,
      source: 'PLANNED',
      arrival: '2026-11-24',
      setBy: material('leather'),
      materials: [{ ...material('leather'), earliest: '2026-11-25', daysLate: 5, source: 'PLANNED' }],
    },
  ],
}

const message = (n: number, over: Partial<ActionMessage>): ActionMessage => ({
  id: uid('5701', n),
  runId: RUN,
  seq: n,
  record: { type: 'PurchaseOrderLine', id: uid('5803', 3), label: 'PO-2026-0003', open: { type: 'PurchaseOrder', id: uid('5801', 3) } },
  action: 'EXPEDITE',
  fromDate: '2026-11-20',
  toDate: '2026-11-14',
  fromQuantity: null,
  toQuantity: null,
  uom: null,
  facts: { purchaseOrderNumber: 'PO-2026-0003', lineSeq: 10, material: 'DEMO-LEA-01 BLK' },
  status: 'OPEN',
  decidedAt: null,
  decisionNote: null,
  version: 1,
  may: { decide: true },
  ...over,
})

export const MESSAGES: ActionMessage[] = [
  message(1, {}),
  message(2, { record: { type: 'WorkOrder', id: uid('9191', 41), label: 'WO-DEMO-0041', open: { type: 'WorkOrder', id: uid('9191', 41) } }, action: 'CANCEL', fromDate: null, toDate: null, facts: {} }),
  message(3, { record: { type: 'PlannedWorkOrder', id: PLANNED[0]!.id, label: 'DEMO-JKT-01 BLK', open: { type: 'PlannedWorkOrder', id: PLANNED[0]!.id } }, action: 'INCREASE', fromDate: null, toDate: null, fromQuantity: '8.0000', toQuantity: '10.0000', uom: 'PCS', facts: { plannedWorkOrder: 'DEMO-JKT-01 BLK', protectedFields: 'sizes' } }),
  message(4, { record: { type: 'MaterialRequirement', id: uid('5502', 2), label: '', open: { type: 'MaterialRequirement', id: uid('5502', 2) } }, action: 'DECREASE', fromDate: null, toDate: null, fromQuantity: '210.0000', toQuantity: '150.0000', uom: 'FT2', facts: { firm: true, material: 'DEMO-LEA-01 RED' } }),
]
const DECIDED = message(5, { action: 'DEFER', fromDate: '2026-11-05', toDate: '2026-11-19', facts: { purchaseOrderNumber: 'PO-2026-0006', lineSeq: 20, material: 'DEMO-FOD-02 GRY' }, status: 'IGNORED', decidedAt: '2026-10-29T08:15:00.000Z', decisionNote: 'Il fornitore consegna comunque il 5.', may: { decide: false } })

export const MESSAGE_LIST: ActionMessages = { siteId: SITE.id, run: PLANNED_LIST.run, counts: { open: 4, done: 0, ignored: 1 }, byAction: [{ action: 'EXPEDITE', open: 1 }, { action: 'CANCEL', open: 1 }, { action: 'INCREASE', open: 1 }, { action: 'DECREASE', open: 1 }], messages: MESSAGES }
export const MESSAGE_LIST_ALL: ActionMessages = { ...MESSAGE_LIST, messages: [...MESSAGES, DECIDED] }

export const CONVERT_PREVIEW: ConvertAnswer = {
  preview: true,
  made: 0,
  held: 1,
  results: [
    { id: PLANNED[0]!.id, kind: 'MAKE', ok: true, workOrder: { id: null, number: null, status: 'DRAFT', revision: 2, dueDate: '2026-11-20', cells: 3, pieces: 8 }, subcontractOrder: null, problems: 0, error: null },
    { id: PLANNED[1]!.id, kind: 'MAKE', ok: false, workOrder: null, subcontractOrder: null, problems: 2, error: null },
  ],
}
export const CONVERT_DONE: ConvertAnswer = { preview: false, made: 1, held: 0, results: [{ id: PLANNED[0]!.id, kind: 'MAKE', ok: true, workOrder: { id: uid('9191', 51), number: 'WO-DEMO-0051', status: 'DRAFT', revision: 2, dueDate: '2026-11-20', cells: 3, pieces: 8 }, subcontractOrder: null, problems: 0, error: null }] }

export const SHIFT_PREVIEW: BulkAnswer = {
  preview: true,
  changed: 2,
  rows: [
    { id: PLANNED[0]!.id, plannedOrder: null, changes: [{ field: 'startDate', from: '2026-11-04', to: '2026-11-06' }, { field: 'dueDate', from: '2026-11-20', to: '2026-11-22' }], problems: [] },
    { id: PLANNED[2]!.id, plannedOrder: null, changes: [{ field: 'startDate', from: '2026-11-09', to: '2026-11-11' }, { field: 'dueDate', from: '2026-11-27', to: '2026-11-29' }, { field: 'kitDueAt', from: '2026-11-09T07:00:00.000Z', to: '2026-11-11T07:00:00.000Z' }], problems: [] },
  ],
}

const counts = { orderLines: 61, orderLinesPlanned: 58, orders: 17, lateOrderLines: 2, undatedOrderLines: 1, madeToMeasure: 2, notPlaced: 0, revisions: 9, materials: 34, workOrders: 12, workOrderCells: 88, scheduledWorkOrders: 10, stockLines: 140, lots: 61, purchaseLines: 23, purchaseOrders: 9, purchaseLinesForOneOrder: 1, reservations: 14, firmPlannedOrders: 2, orderSpecificPegs: 1, itemParameters: 18, approvedSources: 27, plannedWorkOrdersFirm: 1, plannedWorkOrdersProtected: 1, plannedWorkOrdersPlain: 2 }

export const RUN_LOG: RunLog = {
  run: { id: RUN, siteId: SITE.id, trigger: 'MANUAL', status: 'DONE', startedAt: '2026-10-29T06:02:00.000Z', finishedAt: '2026-10-29T06:02:04.000Z', orderLines: 61 },
  inputs: { version: 1, runDate: '2026-10-29', timezone: 'Europe/Rome', previousRunId: uid('5501', 13), explosion: 'MULTI_LEVEL', passes: 2, sizeRunRule: 'SIZE_GROUPS', sizeGroups: 2, counts },
  warningCounts: [
    { code: 'NO_DATE', count: 1 },
    { code: 'LATE', count: 2 },
  ],
  proposals: {
    requirements: [
      { id: uid('5502', 1), seq: 10, action: 'BUY', item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code }, colour: { id: COLOURS.black.id, code: 'BLK' }, netQuantity: '200.0000', uom: 'FT2', needDate: '2026-11-26', decision: 'OPEN', firm: false, orderSpecific: null },
      { id: uid('5502', 2), seq: 20, action: 'BUY', item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code }, colour: { id: COLOURS.red.id, code: 'RED' }, netQuantity: '202.1600', uom: 'FT2', needDate: '2026-11-10', decision: 'ORDERED', firm: true, orderSpecific: null },
      { id: uid('5502', 3), seq: 30, action: 'BUY', item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code }, colour: { id: COLOURS.grey.id, code: 'GRY' }, netQuantity: '14.5000', uom: 'M', needDate: '2026-11-18', decision: 'OPEN', firm: false, orderSpecific: { orderLineId: uid('5252', 2), orderNumber: 'SO-DEMO-0043', lineSeq: 20 } },
    ],
    plannedOrders: PLANNED.slice(0, 3).map((row) => ({ id: row.id, kind: row.kind, status: row.status, label: `${row.style.code} ${row.colourway.code}`, quantity: row.quantity, startDate: row.startDate, dueDate: row.dueDate, needDate: row.late?.needDate ?? row.dueDate, firm: row.firm, protectedFields: row.protectedFields })),
  },
  actionMessages: { open: 4, done: 0, ignored: 1 },
}
export const RUN_LOG_OLD: RunLog = { ...RUN_LOG, run: { ...RUN_LOG.run, id: uid('5501', 12), status: 'SUPERSEDED', trigger: 'ORDER', startedAt: '2026-10-28T06:02:00.000Z' }, inputs: null, warningCounts: [], proposals: { requirements: [], plannedOrders: [] }, actionMessages: { open: 0, done: 0, ignored: 0 } }

const week = (key: string, from: string, to: string, over: Partial<ItemProfile['rows'][number]>): ItemProfile['rows'][number] => ({ key, from, to, demand: '0.0000', receipts: '0.0000', planned: '0.0000', projected: '0.0000', projectedWithPlan: '0.0000', atp: '0.0000', short: false, belowSafety: false, demandRefs: [], receiptRefs: [], plannedRefs: [], ...over })

export const PROFILE: ItemProfile = {
  site: { id: SITE.id, code: SITE.code, name: SITE.name, timeZone: 'Europe/Rome' },
  asOf: '2026-10-29T09:40:00.000Z',
  today: '2026-10-29',
  item: material('leather').item,
  colour: COLOURS.black,
  uom: 'FT2',
  parameters: { itemPlanningId: uid('5905', 1), method: 'ORDERS', lotSizing: 'FIXED', safetyStock: '40.0000', delayDays: 2 },
  requirements: [{ runId: RUN, id: uid('5502', 1), seq: 10 }],
  horizon: { from: '2026-10-26', to: '2026-12-06', weeks: 6 },
  onHand: '120.0000',
  safetyStock: '40.0000',
  totals: { demand: '420.0000', receipts: '100.0000', planned: '210.0000' },
  rows: [
    week('2026-W44', '2026-10-26', '2026-11-01', { projected: '120.0000', projectedWithPlan: '120.0000', atp: '120.0000' }),
    week('2026-W45', '2026-11-02', '2026-11-08', { projected: '120.0000', projectedWithPlan: '120.0000', atp: '20.0000' }),
    week('2026-W46', '2026-11-09', '2026-11-15', { demand: '100.0000', projected: '20.0000', projectedWithPlan: '20.0000', atp: '0.0000', belowSafety: true, demandRefs: [{ order: { ...ORDER(44), rank: 1 }, orderLine: { id: uid('5252', 3), seq: 10 }, size: '50', workOrder: null, day: '2026-11-10', quantity: '100.0000' }] }),
    week('2026-W47', '2026-11-16', '2026-11-22', { receipts: '100.0000', projected: '120.0000', projectedWithPlan: '120.0000', atp: '0.0000', receiptRefs: [{ kind: 'PURCHASE_ORDER', day: '2026-11-20', quantity: '100.0000', purchaseOrder: { id: uid('5801', 3), number: 'PO-2026-0003', lineId: uid('5803', 3), lineSeq: 10 }, requirementId: null }] }),
    week('2026-W48', '2026-11-23', '2026-11-29', {
      demand: '320.0000',
      planned: '210.0000',
      projected: '-200.0000',
      projectedWithPlan: '10.0000',
      atp: '-200.0000',
      short: true,
      demandRefs: [
        { order: { ...ORDER(42), rank: null }, orderLine: { id: uid('5252', 1), seq: 10 }, size: '50', workOrder: null, day: '2026-11-26', quantity: '220.0000' },
        { order: { ...ORDER(43), rank: null }, orderLine: { id: uid('5252', 2), seq: 20 }, size: '52', workOrder: { id: uid('9191', 41), number: 'WO-DEMO-0041' }, day: '2026-11-26', quantity: '100.0000' },
      ],
      plannedRefs: [{ seq: 1, day: '2026-11-24', quantity: '210.0000' }],
    }),
    week('2026-W49', '2026-11-30', '2026-12-06', { projected: '-200.0000', projectedWithPlan: '10.0000', atp: '-200.0000', short: true }),
  ],
  firstShort: '2026-W48',
  firstBelowSafety: '2026-W46',
  net: '200.0000',
  uncovered: '200.0000',
  allocation: 'PRIORITY',
  lots: { list: [{ seq: 1, date: '2026-11-24', quantity: '105.0000', covers: { from: '2026-11-24', to: '2026-11-30' } }, { seq: 2, date: '2026-11-24', quantity: '105.0000', covers: { from: '2026-11-24', to: '2026-11-30' } }] },
  earliest: { leadTimeDays: 21, delayDays: 2, arrival: '2026-11-19', usable: '2026-11-23' },
  delays: DELAYS.demands.map(({ setBy: _setBy, materials: _materials, ...rest }) => rest),
}

/** The office template a buying-screen role stands for (the real role templates of factory-domain). */
const TEMPLATE = { owner: 'owner', buyer: 'buyer', planner: 'planner', readOnly: 'read_only', sales: 'sales', warehouse: 'warehouse' } as const

/** The W2b parts' model for a design case: the role's real rights, every list read, nothing open. */
export function depthOf(role: keyof typeof TEMPLATE, over: Partial<DepthModel> = {}): DepthModel {
  return {
    can: depthCan(rolePermissions(TEMPLATE[role])),
    planned: { status: 'ready', value: PLANNED_LIST },
    messages: { status: 'ready', value: MESSAGE_LIST },
    allMessages: false,
    delays: DELAYS,
    dialog: null,
    notice: null,
    busy: [],
    log: null,
    profile: null,
    built: OFFICE_PAGES,
    ...over,
  }
}
