import type { StyleView } from '../../../../products/styles/api'
import type { SiteOption } from '../../../../_shared/buying/api'
import { DEFAULT_CONTROLS } from '../../../../planning/milestones/model'
import type { ReadinessRow } from '../../../../production/work-orders/daily/api'
import type { Order } from '../../api'
import { COMPANY, LINE_BLK, LINE_RED, PEOPLE as DEMO_PEOPLE, WORK_ORDERS } from '../../_demo/fixtures'
import type { Materials } from '../../depth/api'
import { MATERIALS } from '../../depth/demo/fixtures'
import type { Dates, Gate, OrderProduction } from '../overview/api'
import { GATE, HEADLINE, WORK_READ } from '../overview/fixtures'
import type { OrderRecordModel } from '../record-model'
import type { OrderIssue, OrderIssues } from './api'
import { customerGoodsOf } from './materials'
import { receiptDraftOf } from './receipt'

/**
 * T.1 (order PRODUCTION tab, 15-steps T.1) — the states the seed lacks, made up, for SCR-039's Production cases (record/fixtures.ts):
 * holds of three kinds, asks open / escalated / answered by a reply on a batch, a customer's problem, a promise set then moved twice
 * (once by line), gates late / waiting on the customer's sample / started before, the customer's goods missing / partly / all here,
 * what we buy short with its PO, a replaced pattern, the receipt dialog with leather by the hide. Every name and number is made up;
 * nothing priced. The widths S / M / L are the design frame's own (390 / 1024 / 1440 / 1920).
 */

const w = (en: string, it: string) => ({ en, it })
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const WO1 = WORK_ORDERS[0]!.id
const WO2 = WORK_ORDERS[1]!.id

// ---- holds: a production hold (with the office's note), the customer's pause, a quality hold — all on WO-00022, the work order the read
// marks held (fx6: as the server sends it — a hold names a held work order; the cases give its rows their rights, workActsRead) --------
export const HOLDS_READ: OrderProduction = {
  ...WORK_READ,
  headline: {
    ...HEADLINE,
    held: true,
    holds: [
      { kind: 'PRODUCTION', words: w('Production hold — the lining roll is short', 'Fermo di produzione — manca il rotolo di fodera'), since: '2026-11-15' },
      { kind: 'BRAND', words: w('Paused at your request', 'In pausa su vostra richiesta'), since: '2026-11-16' },
      { kind: 'QUALITY', words: w('Shade difference on the leather', 'Differenza di tonalità della pelle'), since: '2026-11-14' },
    ],
    holdNotes: [{ workOrderId: WO2, number: 'WO-00022', kind: 'PRODUCTION', note: 'Made-up: rotolo di fodera in arrivo giovedì.', since: '2026-11-15T09:10:00Z' }],
    waiting: {
      ...HEADLINE.waiting,
      blockers: [
        ...HEADLINE.waiting.blockers,
        { kind: 'NO_MOVE', on: 'US', words: w('Production hold — the lining roll is short', 'Fermo di produzione — manca il rotolo di fodera'), since: '2026-11-15T09:10:00Z', ref: { type: 'WorkOrder', id: WO2 }, sub: null },
        { kind: 'BRAND_PAUSE', on: 'BRAND', words: w('Paused at your request', 'In pausa su vostra richiesta'), since: '2026-11-16T10:00:00Z', ref: { type: 'WorkOrder', id: WO2 }, sub: null },
        { kind: 'QUALITY_HOLD', on: 'US', words: w('Shade difference on the leather', 'Differenza di tonalità della pelle'), since: '2026-11-14T08:30:00Z', ref: { type: 'WorkOrder', id: WO2 }, sub: null },
      ],
    },
  },
}

// ---- asks: open, escalated, answered by the supervisor's reply on a batch (L8), the customer's own problem ---------------------------
const issue = (over: Partial<OrderIssue> = {}): OrderIssue => ({
  id: uid('7171', 401),
  source: 'OFFICE',
  sourceWords: w('Question for production', 'Domanda per la produzione'),
  status: 'OPEN',
  record: { type: 'SalesOrder', id: WORK_READ.order.id, label: 'SO-2026-0088' },
  // The demo's today is 29 Oct 2026 (_demo TODAY): an open ask answers by 2 Nov.
  raisedAt: '2026-10-27T08:15:00Z',
  dueOn: '2026-11-02',
  answeredAt: null,
  escalation: null,
  task: { id: uid('7474', 401), assignee: 'SOMEONE_ELSE' },
  batch: null,
  excerpt: 'Where is SO-2026-0088 now? What is cut, sewn and packed?',
  messageId: uid('8282', 401),
  askedBy: { id: DEMO_PEOPLE.sales, name: 'Sara Vendite' },
  reply: null,
  ...over,
})
const issues = (...rows: OrderIssue[]): OrderIssues => ({ asOf: '2026-11-21T09:00:00Z', more: false, issues: rows })
export const ASKS_OPEN = issues(issue())
export const ASKS_ESCALATED = issues(issue({ raisedAt: '2026-10-22T08:15:00Z', dueOn: '2026-10-26', escalation: { step: 1, at: '2026-10-26T07:00:00Z', words: w('Escalated 1× — now with the backup', 'Sollecitata 1× — ora al sostituto') } }))
export const ASKS_ANSWERED_BATCH = issues(
  issue({
    status: 'ANSWERED',
    answeredAt: '2026-10-28T13:10:00Z',
    task: null,
    batch: { id: uid('7575', 401), issues: 3, orders: [{ id: uid('5151', 90), number: 'SO-2026-0090' }], more: 1 },
    reply: { at: '2026-10-28T13:10:00Z', messageId: uid('8282', 402), by: { id: uid('9191', 1), name: 'Bea Esempio' }, excerpt: 'Made-up: cutting is done, sewing is on the line; the date holds.' },
  }),
)
export const ASKS_CUSTOMER_PROBLEM = issues(issue({ id: uid('7171', 403), source: 'BRAND', sourceWords: w('Reported by the customer', 'Segnalato dal cliente'), excerpt: 'Made-up: the samples’ zips stick — will the order have the same?', askedBy: null }))
/** The customer's problem waits on us in the ONE waiting list (its message: Reply in the thread). */
export const PROBLEM_READ: OrderProduction = {
  ...WORK_READ,
  headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers: [...HEADLINE.waiting.blockers, { kind: 'BRAND_REQUEST', on: 'US', words: w('A problem the customer reported waits for our answer', 'Un problema segnalato dal cliente aspetta la nostra risposta'), since: '2026-10-27T08:15:00Z', ref: { type: 'ProductionIssue', id: uid('7171', 403), messageId: uid('8282', 401) }, sub: 'PROBLEM' }] } },
}

// ---- the promise: set, then moved twice — the whole order, then one line from its own day (mixed lines, B23) -------------------------
export function promiseMovedOf(order: Order): Order {
  return {
    ...order,
    promiseDate: '2026-12-22',
    promiseHistory: [
      { at: '2026-11-19T15:00:00Z', actorId: DEMO_PEOPLE.sales, from: '2026-12-15', to: '2026-12-22', lineIds: [LINE_RED], reason: 'MATERIAL_LATE', kind: 'MOVED', fromByLine: [{ lineId: LINE_RED, from: '2026-12-15' }] },
      { at: '2026-11-12T10:00:00Z', actorId: DEMO_PEOPLE.sales, from: '2026-12-08', to: '2026-12-15', lineIds: [], reason: 'Made-up: la pelle nera arriva una settimana dopo.', kind: 'MOVED', fromByLine: [{ lineId: LINE_BLK, from: '2026-12-08' }, { lineId: LINE_RED, from: '2026-12-10' }] },
      { at: '2026-10-28T09:00:00Z', actorId: DEMO_PEOPLE.sales, from: null, to: '2026-12-08', lineIds: [], reason: null, kind: 'SET', fromByLine: null },
    ],
  }
}

// ---- the gates: late, waiting on the customer's own sample round, started before ---------------------------------------------------
const gate = (id: string, over: Partial<Gate>): Gate => ({ ...GATE, id, ...over })
export const GATES_DATES: Dates = {
  ...WORK_READ.dates!,
  gates: [
    gate('g-late', { kind: 'TRIMS_IN', targetDate: '2026-11-18' }),
    gate('g-sample', { kind: 'PP_SAMPLE', targetDate: '2026-11-25', sampleRound: { id: uid('6464', 1), number: 'SR-2026-0007', kind: 'PP', decision: null } }),
    gate('g-before', { kind: 'LEATHER_APPROVED', targetDate: '2026-11-10', state: 'STARTED_BEFORE' }),
  ],
  milestones: [
    { id: 'm-late', kind: 'GATE', gateId: 'g-late', gateKind: 'TRIMS_IN', label: null, target: '2026-11-18', actual: null, state: 'WAITING', late: 3, owner: { id: uid('9191', 3), name: 'Paola Esempio' } },
    { id: 'm-sample', kind: 'GATE', gateId: 'g-sample', gateKind: 'PP_SAMPLE', label: null, target: '2026-11-25', actual: null, state: 'WAITING', late: null, owner: { id: uid('9191', 3), name: 'Paola Esempio' } },
    { id: 'm-before', kind: 'GATE', gateId: 'g-before', gateKind: 'LEATHER_APPROVED', label: null, target: '2026-11-10', actual: null, state: 'STARTED_BEFORE', late: null, owner: { id: uid('9191', 3), name: 'Paola Esempio' } },
    ...WORK_READ.dates!.milestones.filter((row) => row.kind !== 'GATE'),
  ],
}
export const GATES_READ: OrderProduction = { ...WORK_READ, dates: GATES_DATES }
/** Planning's gate acts as the page mounts them (the dialogs closed): the step names open its window. */
export const GATE_ACTS: NonNullable<OrderRecordModel['gateActs']> = { prefix: '/w/DEMO', can: { view: true, manage: true, override: true }, me: 'me', controls: DEFAULT_CONTROLS, world: { status: 'loading' }, live: 'live', updates: 0, notice: null, dialog: null }

// ---- the customer's goods: missing, partly arrived (MATERIALS), all here; leather by the hide for the receipt -------------------------
const rowsWith = (received: (expected: string, index: number) => string): Materials => ({ ...MATERIALS, rows: MATERIALS.rows.map((row, index) => ({ ...row, received: received(row.expected, index), used: '0.0000', left: received(row.expected, index) })) })
export const GOODS_MISSING: Materials = { ...rowsWith(() => '0.0000'), lots: [] }
export const GOODS_ALL_HERE: Materials = rowsWith((expected) => expected)
const LEATHER_ID = uid('7676', 9)
export const GOODS_WITH_LEATHER: Materials = {
  ...MATERIALS,
  rows: [...MATERIALS.rows, { id: uid('5454', 9), orderLineId: LINE_BLK, seq: 2, item: { id: LEATHER_ID, code: 'PEL-DEMO-09', name: 'Pelle del cliente, fiore' }, colour: null, uom: 'm²', expected: '12.0000', expectedBySize: {}, received: '4.0000', used: '0.0000', returned: '0.0000', left: '4.0000', note: null, version: 1 }],
}
const SITE: SiteOption = { id: uid('1212', 1), companyId: COMPANY, code: 'DEMO-A1', name: 'Demo plant A1', locations: [{ id: uid('1313', 1), code: 'DOCK', name: 'Goods in', kind: 'RECEIVING', status: 'ACTIVE' }, { id: uid('1313', 2), code: 'A-01', name: 'Rack A-01', kind: 'BIN', status: 'ACTIVE' }] }
/** The receipt dialog open: pre-filled with what is still to come, the leather read as tracked hide by hide (said, left out). */
export const RECEIPT_OPEN: NonNullable<OrderRecordModel['receipt']> = {
  dialog: { draft: { ...receiptDraftOf(customerGoodsOf(GOODS_WITH_LEATHER)!, null, [SITE]), ddtNumber: 'DDT 118/2026', ddtDate: '2026-11-20' }, sites: { value: [SITE], problem: null }, tracking: new Map([[LEATHER_ID, 'HIDE']]), busy: false, problem: null, held: null },
}

// ---- what we buy: short, its PO late; the buyers asked once ----------------------------------------------------------------------------
const ZIP_ID = uid('7676', 21)
export const READINESS_SHORT: ReadinessRow[] = [
  {
    workOrderId: WO1,
    word: 'DELAYED',
    date: '2026-11-28',
    open: 1,
    materials: [
      { itemId: ZIP_ID, itemColourId: null, word: 'DELAYED', date: '2026-11-28', label: 'Zip 60 cm · Navy', uom: 'pcs', needed: '80', short: '80', neededOn: '2026-11-24', purchaseOrders: [{ id: uid('6565', 91), number: 'PO-2026-0091', status: 'SENT', dueDate: '2026-11-18' }] },
      { itemId: uid('7676', 22), itemColourId: null, word: 'RECEIVED', date: null, label: 'Lining mesh 3D · Black', uom: 'm', needed: '120', short: null, neededOn: '2026-11-24', purchaseOrders: [] },
    ],
    asOf: '2026-11-21T09:00:00Z',
  },
]
export const ASK_BUYERS: NonNullable<OrderRecordModel['askBuyers']> = { element: null, asked: new Map() }
export const ASKED_BUYERS: NonNullable<OrderRecordModel['askBuyers']> = { element: null, asked: new Map([[`${WO1}|${ZIP_ID}|-`, '2026-11-20T10:00:00Z']]) }

// ---- our pattern: v3 pinned, v4 in force since 12 Nov; WO-00021 still on v3 with the change order's decision ------------------------------
export const SPEC_READ: OrderProduction = {
  ...WORK_READ,
  work: {
    ...WORK_READ.work!,
    workOrders: WORK_READ.work!.workOrders.map((row, index) => (index === 0 ? { ...row, spec: { revision: { revision: 3, status: 'OBSOLETE' }, state: 'NEWER_RELEASED', newer: { revision: 4, releasedOn: '2026-11-12' }, decision: { disposition: 'FINISH_OLD', changeOrder: 'ECO-2026-0004' } } } : row)),
  },
}
/** The style's revisions as "What we make it to" reads them (design: only the part the section reads). */
export const STYLE_REPLACED = {
  revisions: [
    { id: uid('7878', 3), revision: 3, status: 'OBSOLETE', changeNote: null, releasedAt: '2026-10-01T09:00:00Z' },
    { id: uid('7878', 4), revision: 4, status: 'RELEASED', changeNote: 'Made-up: the knee pad pocket 2 cm lower.', releasedAt: '2026-11-12T09:00:00Z' },
  ],
} as unknown as StyleView
