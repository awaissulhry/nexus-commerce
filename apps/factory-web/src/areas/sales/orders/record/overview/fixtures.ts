import { LINE_BLK, LINE_RED, ORDER_ID, WORK_ORDERS } from '../../_demo/fixtures'
import { MILESTONES } from '../../depth/demo/fixtures'
import type { Headline, OrderProduction, ProductionLine, Work } from './api'
import type { ProductionState } from './model'

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
  waiting: { on: 'US', words: w('Waiting on us', 'Tocca a noi'), since: '2026-11-17T09:05:00Z', blockers: [{ kind: 'REQUEST', on: 'US', words: w('A change request', 'Una richiesta di modifica'), since: '2026-11-17T09:05:00Z' }] },
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
  dates: { gates: [], milestones: MILESTONES.milestones.map((row) => ({ ...row, gateId: null, owner: null })), late: MILESTONES.late, next: MILESTONES.next, planned: { cutStart: '2026-11-10', sewStart: '2026-11-13', finish: '2026-12-10' }, forecast: [{ lineId: LINE_BLK, seq: 10, finish: '2026-12-08', risk: 'ON_TIME', slackDays: 7, sizes: [{ size: '48', finish: '2026-12-05', risk: 'ON_TIME' }, { size: '50', finish: '2026-12-08', risk: 'ON_TIME' }] }] },
  quality: { issues: null, ncrs: null, final: null },
  people: null,
  changes: { openRequests: [] },
}

/** Before any work order: the order is confirmed and waits for its deposit (the keeper has no stage yet). */
export const CONFIRMED_READ: OrderProduction = {
  ...PRODUCTION_READ,
  order: { ...PRODUCTION_READ.order, status: 'CONFIRMED' },
  headline: { ...HEADLINE, stage: null, inWork: { bundles: 0, pieces: { cutting: 0, sewing: 0, checking: 0, packing: 0 } }, health: null, waiting: { on: 'BRAND', words: w('Waiting on customer', 'Tocca al cliente'), since: '2026-10-28T15:00:00Z', blockers: [{ kind: 'DEPOSIT', on: 'BRAND', words: w('The deposit', "L'acconto"), since: '2026-10-28T15:00:00Z' }] }, urgency: { ...HEADLINE.urgency, customer: null } },
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
/** Without workorders.view: the work part withheld (the chain's numbers only). */
export const NO_WORK_READ: OrderProduction = { ...PRODUCTION_READ, work: null, people: null, withheld: ['work', 'people', 'headline.notes'] }

export const ready = (read: OrderProduction = PRODUCTION_READ): ProductionState => ({ status: 'ready', read })
export const LOADING_STATE: ProductionState = { status: 'loading' }
export const FAILED_STATE: ProductionState = { status: 'failed', problem: 'problem.read.unavailable' }
