import { LINE_BLK, LINE_RED, ORDER_ID, WORK_ORDERS } from '../../_demo/fixtures'
import { MILESTONES } from '../../depth/demo/fixtures'
import type { Headline, OrderProduction, ProductionLine, Work } from './api'
import type { Gate, People } from './api' // F-OO-208
import type { ProductionState } from './model'
import type { OrderFilesRead } from '../../../../../lib/record-thread/files-view/model' // F-SA-237

/**
 * F-SA-232 — made-up production reads of the demo order SO-2026-0088 (Moto Demo S.r.l., DEMO-JKT-01 in Nero and Rosso) for the
 * Overview cases and tests: in production (Sewing, 1 line ahead, at risk, waiting on us, 3 bundles in work, sewing counted
 * elsewhere), confirmed before any work order, and a site that does not count sewing. The order's OWN pieces only; no name of an
 * operator, a station or another customer. Every name and number is made up.
 */

const w = (en: string, it: string) => ({ en, it })

export const HEADLINE: Headline = {
  stage: { code: 'SEWING', words: w('Sewing', 'Confezione'), since: '2026-11-13', ahead: 1, aheadWords: w('1 line ahead', '1 riga avanti'), sewingNotCounted: false, sewingNotCountedWords: null, next: { code: 'QUALITY', words: w('Quality check', 'Controllo qualità') }, partlyShipped: false },
  inWork: { bundles: 3, pieces: { cutting: 0, sewing: 6, checking: 2, packing: null } },
  health: { code: 'AT_RISK', words: w('At risk', 'A rischio'), computed: 'AT_RISK', raise: null },
  waiting: { on: 'US', words: w('Waiting on us', 'Tocca a noi'), since: '2026-11-17T09:05:00Z', blockers: [{ kind: 'BRAND_REQUEST', on: 'US', words: w('A customer request waits for our answer', 'Una richiesta del cliente aspetta la nostra risposta'), since: '2026-11-17T09:05:00Z', ref: { type: 'OrderChangeRequest', id: '0190f0e2-3080-7000-8000-000000000901' }, sub: 'REQUEST' }] }, // F-OP-103: a real blocker kind, with its ref and sub
  held: false,
  holds: [],
  holdNotes: null,
  promise: { date: '2026-12-15', first: '2026-12-09', moved: true, moves: 2, slipDays: 6 },
  urgency: { customer: { code: 'URGENT', urgentRank: 1, words: w('Urgent', 'Urgente') }, factoryRush: false, officePriority: { level: 'NORMAL', words: w('Normal', 'Normale'), reason: null } },
}

const size = (name: string, ordered: number, cut: number | null, sewn: number | null, checked: number | null, packed: number | null, shipped = 0) => ({ size: name, ordered, cut, sewn, checked, packed, shipped, madeExtra: 0, madeExtraWords: null })

export const LINES: ProductionLine[] = [
  {
    lineId: LINE_BLK,
    seq: 10,
    kind: 'SIZE_GRID',
    style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
    colourway: { code: 'BLK', name: 'Nero' },
    ordered: 8,
    cut: 8,
    sewn: 6,
    checked: 2,
    packed: 0,
    shipped: 0,
    inWorkOrders: 8,
    notInWorkOrders: false,
    sizes: [size('48', 2, 2, 2, 1, 0), size('50', 2, 2, 2, 1, 0), size('52', 2, 2, 1, 0, 0), size('54', 2, 2, 1, 0, 0)],
    madeExtra: 0,
  },
  {
    lineId: LINE_RED,
    seq: 20,
    kind: 'SIZE_GRID',
    style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
    colourway: { code: 'RED', name: 'Rosso' },
    ordered: 6,
    cut: 3,
    sewn: null,
    checked: 0,
    packed: 0,
    shipped: 0,
    inWorkOrders: 6,
    notInWorkOrders: false,
    sizes: [size('50', 2, 2, null, 0, 0), size('52', 2, 1, null, 0, 0), size('54', 2, 0, null, 0, 0)],
    madeExtra: 0,
  },
]

export const PRODUCTION_READ: OrderProduction = {
  order: { id: ORDER_ID, number: 'SO-2026-0088', status: 'IN_PRODUCTION', version: 3 },
  asOf: '2026-11-18T09:42:00Z',
  refreshSeconds: 60,
  parts: ['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'],
  withheld: [],
  headline: HEADLINE,
  lines: LINES,
  work: null,
  // F-SA-234: the order's gates and milestones under its own right (the planner's demo milestones: two gates done, one late; start; shipping).
  dates: { gates: [], milestones: MILESTONES.milestones.map((row) => ({ ...row, gateId: null, owner: null })), late: MILESTONES.late, next: MILESTONES.next, planned: { cutStart: '2026-11-10', sewStart: '2026-11-13', finish: '2026-12-10' }, forecast: [{ lineId: LINE_BLK, seq: 10, finish: '2026-12-08', risk: 'ON_TIME', slackDays: 7, source: 'BOARD', sizes: [{ size: '48', finish: '2026-12-05', risk: 'ON_TIME' }, { size: '50', finish: '2026-12-08', risk: 'ON_TIME' }] }, /* F-SA-234b */ { lineId: LINE_RED, seq: 20, finish: '2026-12-29', risk: 'AT_RISK', slackDays: -7, source: 'WORK_ORDER_DUE', sizes: [] }] },
  quality: { issues: [], ncrs: [], final: [] },
  people: null,
  changes: { openRequests: [] },
}

/** Before any work order: the order is confirmed and waits for its deposit (the keeper has no stage yet). */
export const CONFIRMED_READ: OrderProduction = {
  ...PRODUCTION_READ,
  order: { ...PRODUCTION_READ.order, status: 'CONFIRMED' },
  headline: { ...HEADLINE, stage: null, inWork: { bundles: 0, pieces: { cutting: 0, sewing: 0, checking: 0, packing: 0 } }, health: null, waiting: { on: 'BRAND', words: w('Waiting on customer', 'Tocca al cliente'), since: '2026-10-28T15:00:00Z', blockers: [{ kind: 'DEPOSIT', on: 'BRAND', words: w('Deposit not paid yet', 'Acconto non ancora pagato'), since: '2026-10-28T15:00:00Z', ref: { type: 'DepositRequest', id: '0190f0e2-1818-7000-8000-000000000001' }, sub: null }] }, urgency: { ...HEADLINE.urgency, customer: null } },
  lines: LINES.map((line) => ({ ...line, cut: 0, sewn: 0, checked: 0, packed: 0, inWorkOrders: 0, notInWorkOrders: true, sizes: line.sizes.map((entry) => ({ ...entry, cut: 0, sewn: 0, checked: 0, packed: 0 })) })),
}

/**
 * F-SA-234: the work behind it — WO-00021 makes this order's black jackets (8 of a run of 20, also SO-2026-0151 of the same
 * customer; one site counts sewing), WO-00022 the red (6, not cut yet, a cut shared with other work), and 12 made-to-measure units
 * in black as one group. No other customer named or counted.
 */
const named = (code: string, name: string) => ({ code, name })
export const WORK: Work = {
  workOrders: [
    { id: WORK_ORDERS[0]!.id, number: 'WO-00021', status: 'IN_PROGRESS', held: false, rush: false, style: named('DEMO-JKT-01', 'Giacca pelle demo'), colourways: [named('BLK', 'Nero')], site: named('STAB-N', 'Stabilimento Nord'), line: named('L2', 'Linea 2'), workshops: [], own: { cells: 4, pieces: 8, cut: 8, sewn: 5, checked: 2 }, alsoMakes: { orders: [{ id: '0190f0e2-5151-7000-8000-000000000151', number: 'SO-2026-0151' }], more: 0 }, sharedWithOtherCustomers: false, cutWithOtherWork: false, due: '2026-12-05', daysLate: 0 },
    { id: WORK_ORDERS[1]!.id, number: 'WO-00022', status: 'RELEASED', held: true, rush: false, style: named('DEMO-JKT-01', 'Giacca pelle demo'), colourways: [named('RED', 'Rosso')], site: named('STAB-N', 'Stabilimento Nord'), line: null, workshops: [{ name: 'Laboratorio Esempio' }], own: { cells: 3, pieces: 6, cut: 0, sewn: null, checked: 0 }, alsoMakes: { orders: [], more: 0 }, sharedWithOtherCustomers: false, cutWithOtherWork: true, due: '2026-12-12', daysLate: 0 },
  ],
  mtm: [{ style: named('DEMO-JKT-01', 'Giacca pelle demo'), colourway: named('BLK', 'Nero'), units: 12, workOrders: 12, byStatus: [{ status: 'IN_PROGRESS', count: 8 }, { status: 'RELEASED', count: 4 }], own: { cells: 12, pieces: 12, cut: 12, sewn: 6, checked: 0 } }],
  workOrdersLeftOut: 1,
  notInProduction: { lines: 0, pieces: 0 },
}
export const WORK_READ: OrderProduction = { ...PRODUCTION_READ, work: WORK }

// ---- F-OO-208 (B-OO-008, B-OO-010): the read's new fields as the API sends them (made up) — People: who answers the customer and
// why (the order's supervisor), the places told apart (a plant line; an outside workshop since its issue day); a gate with its
// version and this reader's moves (pass allowed; start before refused in words; edit allowed; remove needs Planning's right).
export const PEOPLE: People = {
  supervisor: { id: '0190f0e2-9191-7000-8000-000000000001', name: 'Bea Esempio', active: true, from: 'ORDER', me: false },
  backup: { id: '0190f0e2-9191-7000-8000-000000000002', name: 'Carlo Prova', active: true },
  answersCustomer: { id: '0190f0e2-9191-7000-8000-000000000001', name: 'Bea Esempio', active: true, source: 'SUPERVISOR' },
  places: [
    { site: named('STAB-N', 'Stabilimento Nord'), line: named('L2', 'Linea 2'), team: null, workshop: null, kind: 'PLANT', since: null },
    { site: null, line: null, team: null, workshop: { name: 'Laboratorio Esempio' }, kind: 'WORKSHOP', since: '2026-11-10' },
  ],
}
export const GATE: Gate = {
  id: '0190f0e2-9292-7000-8000-000000000001',
  kind: 'PP_SAMPLE',
  label: null,
  targetDate: '2026-11-20',
  sampleRound: null,
  owner: { id: '0190f0e2-9191-7000-8000-000000000003', name: 'Paola Esempio' },
  state: 'WAITING',
  passedOn: null,
  via: null,
  startedBefore: null,
  leather: null,
  version: 3,
  actions: {
    pass: { allowed: true, refusal: null, needs: null },
    startBefore: { allowed: false, refusal: { code: 'OWN_GATE', message: "Starting before the gate needs someone who is neither the gate's planner nor the person who added it: ask a colleague who may." }, needs: null },
    edit: { allowed: true, refusal: null, needs: null },
    remove: { allowed: false, refusal: null, needs: 'planning.milestones.manage' },
  },
}
// ---- end F-OO-208

// ---- F-OP-113 (B-OP-021, B6; R-11): the work orders as the order page acts on them — each row's version, kind, release, priority,
// its cells of this order's lines and the reader's rights; a third, older work order shared with another customer (read-only here).
export type WorkRights = { readonly manage: boolean; readonly release: boolean; readonly hold: boolean }
export const SHARED_WO_ID = '0190f0e2-6060-7000-8000-000000000019'
const SHARED_WORDS = { en: 'Shared with other customers: change it on its page.', it: 'Condiviso con altri clienti: cambialo dalla sua pagina.' }
export function workActsRead(rights: WorkRights): OrderProduction {
  const [first, second] = WORK.workOrders
  const own = (row: Work['workOrders'][number], line: string, extra: Partial<Work['workOrders'][number]>) => ({
    ...row,
    kind: 'STANDARD',
    cells: [
      { id: `${row.id.slice(0, -2)}c1`, salesOrderLineId: line, size: 'M', quantity: Math.ceil(row.own.pieces / 2), cut: row.own.cut === null ? null : Math.min(row.own.cut, Math.ceil(row.own.pieces / 2)) },
      { id: `${row.id.slice(0, -2)}c2`, salesOrderLineId: line, size: 'L', quantity: Math.floor(row.own.pieces / 2), cut: row.own.cut === null ? null : Math.max(0, row.own.cut - Math.ceil(row.own.pieces / 2)) },
    ],
    rights: { ...rights, why: null },
    ...extra,
  })
  return {
    ...WORK_READ,
    work: {
      ...WORK,
      workOrders: [
        // Listed out of order on purpose: the card shows them by number.
        own(second!, LINE_RED, { version: 4, releasedAt: '2026-11-10T08:00:00Z', priority: 100, rush: true }),
        own(first!, LINE_BLK, { version: 7, releasedAt: '2026-11-04T08:00:00Z', priority: 0 }),
        {
          ...first!,
          id: SHARED_WO_ID,
          number: 'WO-00019',
          status: 'RELEASED',
          own: { cells: 1, pieces: 4, cut: 0, sewn: null, checked: 0 },
          alsoMakes: { orders: [], more: 0 },
          sharedWithOtherCustomers: true,
          version: 2,
          kind: 'STANDARD',
          releasedAt: '2026-10-28T08:00:00Z',
          priority: 0,
          cells: [{ id: '0190f0e2-6060-7000-8000-0000000019c1', salesOrderLineId: LINE_BLK, size: 'S', quantity: 4, cut: 0 }],
          rights: { manage: false, release: false, hold: false, why: SHARED_WORDS },
        },
      ],
    },
  }
}
// ---- end F-OP-113
/** Without workorders.view: the work part withheld (the chain's numbers only). */
export const NO_WORK_READ: OrderProduction = { ...PRODUCTION_READ, work: null, people: null, quality: { issues: null, ncrs: null, final: null }, withheld: ['work', 'people', 'headline.notes', 'quality.issues', 'quality.ncrs', 'quality.final'] }

/** F-SA-235: a quality hold on WO-00022 with the office's note, one open problem, one NCR, a final inspection waiting. */
export const QUALITY_READ: OrderProduction = {
  ...WORK_READ,
  headline: { ...HEADLINE, held: true, holds: [{ kind: 'QUALITY', words: w('Shade difference on the leather', 'Differenza di tonalità della pelle'), since: '2026-11-14' }], holdNotes: [{ workOrderId: WORK_ORDERS[1]!.id, number: 'WO-00022', kind: 'QUALITY', note: 'Lotto pelle in verifica col fornitore.', since: '2026-11-14T08:30:00Z' }] },
  quality: {
    issues: [{ id: '0190f0e2-7171-7000-8000-000000000301', source: 'FLOOR', recordType: 'WorkOrder', since: '2026-11-16T10:00:00Z', dueOn: '2026-11-19', escalation: 1 }],
    ncrs: [{ id: '0190f0e2-7272-7000-8000-000000000041', number: 'NCR-2026-0041', stage: 'OPEN', severity: 'MINOR', sharedWorkOrder: false }],
    final: [{ workOrderId: WORK_ORDERS[0]!.id, number: 'FI-2026-0088', status: 'OPEN', sampleSize: 8, on: null }],
  },
}

export const ready = (read: OrderProduction = PRODUCTION_READ): ProductionState => ({ status: 'ready', read })
export const LOADING_STATE: ProductionState = { status: 'loading' }
export const FAILED_STATE: ProductionState = { status: 'failed', problem: 'problem.read.unavailable' }

/** F-SA-237: the order's files by source (made up): the order sheet shared in the conversation, an office note, the line's artwork (a copy
 * also on SO-2026-0151 of the same customer, and on 1 record the reader does not reach), a production photo; 3 the reader cannot open. */
const fileOf = (n: number, over: Partial<OrderFilesRead['groups'][number]['files'][number]>) => ({ id: `0190f0e2-8181-7000-8000-00000000000${n}`, name: `file-${n}.pdf`, kind: 'DOCUMENT', category: null, contentType: 'application/pdf', sizeBytes: 182_000, versionNo: 1, at: '2026-11-12T10:00:00Z', from: { type: 'SalesOrder', id: ORDER_ID, label: 'SO-2026-0088' }, line: null, audience: 'OFFICE_ONLY' as const, bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null, ...over })
export const ORDER_FILES: OrderFilesRead = {
  order: { id: ORDER_ID, number: 'SO-2026-0088' },
  groups: [
    { key: 'ORDER', words: w('Order & thread', 'Ordine e conversazione'), files: [fileOf(1, { name: 'Ordine firmato.pdf', audience: 'CUSTOMER_CAN_SEE', inThread: { messageId: '0190f0e2-8282-7000-8000-000000000001' } }), fileOf(2, { name: 'Note ufficio.pdf' })], leftOut: 0, measurementsLeftOut: 0 },
    { key: 'LINES', words: w('Lines & artwork', 'Righe e grafiche'), files: [fileOf(3, { name: 'Logo ricamo.pdf', category: 'ARTWORK', from: { type: 'SalesOrderLine', id: LINE_BLK, label: 'SO-2026-0088 · riga 10' }, alsoOn: [{ type: 'SalesOrder', id: '0190f0e2-5151-7000-8000-000000000151', label: 'SO-2026-0151' }], alsoOnOther: 1 })], leftOut: 0, measurementsLeftOut: 1 },
    { key: 'PRODUCTION', words: w('Production', 'Produzione'), files: [fileOf(4, { name: 'Taglio nero.jpg', kind: 'PHOTO', contentType: 'image/jpeg', from: { type: 'WorkOrder', id: WORK_ORDERS[0]!.id, label: 'WO-00021' } })], leftOut: 2, measurementsLeftOut: 0 },
  ],
  total: 4,
  truncated: false,
}

// ---- F-MS-101 (set the stage by hand; B-MS-006's shape, R9): made-up reads of the order's stage set by hand — the floor at Sewing
// with nothing set (the door open; the production row's version 3); Sewing set over the floor's Preparing by an office person today,
// "System or scanners down", with the office's note; the same 9 days old (the warning tone, "check it"); Cutting on an order that no
// work order records yet (as SEED-SO-W39-02), no note; the customer's own pause on the order (the door held). Every name and note is
// made up; never a person of the floor.
/** When the demo's hand stages were set: today (the demo's 2026-10-29) and 9 days before it. */
export const HAND_AT = '2026-10-29T13:50:00Z'
export const HAND_OLD_AT = '2026-10-20T09:10:00Z'
const SETTER = { id: '0190f0e2-9191-7000-8000-000000000004', name: 'Bea Esempio', active: true }
type HandStage = NonNullable<NonNullable<Headline['stage']>['byHand']>
const handOver = (stage: 'CUTTING' | 'SEWING' | 'QUALITY', byHand: HandStage | null, version: number | null): Headline => ({
  ...HEADLINE,
  stage: { ...HEADLINE.stage!, code: stage, words: stage === 'CUTTING' ? w('Cutting', 'Taglio') : stage === 'SEWING' ? w('Sewing', 'Cucitura') : w('Quality check', 'Controllo qualità'), ahead: 0, aheadWords: null, byHand, version },
})
export const HAND_FREE_READ: OrderProduction = { ...PRODUCTION_READ, headline: handOver('SEWING', null, 3) }
export const HAND_BY: HandStage = { stage: 'SEWING', reasonCode: 'OUTAGE', floor: { code: 'PREPARING', words: w('Preparing', 'In preparazione') }, at: HAND_AT, note: 'Tablet del reparto taglio offline dalle 14:00.', by: SETTER }
export const HAND_READ: OrderProduction = { ...PRODUCTION_READ, headline: handOver('SEWING', HAND_BY, 4) }
export const HAND_OLD_READ: OrderProduction = { ...PRODUCTION_READ, headline: handOver('SEWING', { ...HAND_BY, at: HAND_OLD_AT }, 4) }
/** No work order yet (the lines not in work orders): Cutting set by hand, "Too few people to record the work", no note. */
export const HAND_NOWORK_READ: OrderProduction = {
  ...CONFIRMED_READ,
  order: { ...PRODUCTION_READ.order, status: 'IN_PRODUCTION' },
  headline: { ...handOver('CUTTING', { stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', floor: { code: 'PREPARING', words: w('Preparing', 'In preparazione') }, at: HAND_AT, note: null, by: SETTER }, 1), waiting: { on: 'US', words: w('Waiting on us', 'Tocca a noi'), since: null, blockers: [] } },
}
/** The customer's own pause stands on the order (a BRAND_PAUSE blocker): Set the stage by hand… is held — lift the pause first. */
export const HAND_PAUSED_READ: OrderProduction = {
  ...PRODUCTION_READ,
  headline: {
    ...handOver('SEWING', null, 3),
    held: true,
    holds: [{ kind: 'BRAND', words: w('Paused at your request', 'In pausa su vostra richiesta'), since: '2026-10-27' }],
    waiting: { on: 'BRAND', words: w('Waiting on customer', 'Tocca al cliente'), since: '2026-10-27T10:00:00Z', blockers: [{ kind: 'BRAND_PAUSE', on: 'BRAND', words: w('Paused at your request', 'In pausa su vostra richiesta'), since: '2026-10-27T10:00:00Z', ref: null, sub: null }] },
  },
}
// ---- end F-MS-101
