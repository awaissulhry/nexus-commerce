import type { MyWorkViewModel } from '../view/MyWorkView'
import type { InspectorQueue, InspectorRow } from './model'

/**
 * SCR-089's W2b inspector-queue cases (B-W2b-109; design floor.mywork "queue" variant, QHS-068): made-up rows of a made-up "Demo"
 * plant — what each inspection holds up first, its sample so far, how long it waits, mine or nobody's — never another person.
 */

const AS_OF = '2026-11-08T09:20:00.000Z'
const w = (it: string, en: string) => ({ it, en })

const row = (key: string, extra: Partial<InspectorRow>): InspectorRow => ({
  key,
  kind: 'FINAL',
  kindWords: w('Collaudo finale', 'Final inspection'),
  recordType: 'Inspection',
  id: key,
  number: null,
  title: 'WO-DEMO-0042 · GIA-01 Giacca moto Demo',
  workOrder: { id: 'wo-demo-0042', number: 'WO-DEMO-0042' },
  lot: null,
  item: null,
  bundle: null,
  operation: null,
  plan: null,
  progress: null,
  openedAt: AS_OF,
  waitingSince: AS_OF,
  waiting: { minutes: 25, words: w('In attesa da 25 min', 'Waiting 25 min') },
  dueAt: null,
  overdue: false,
  blocks: { what: 'NONE', rank: 3, needBy: null, count: null, words: w('Non blocca nulla', 'Holds up nothing') },
  taken: 'MINE',
  may: { record: true, start: false },
  start: null,
  ...extra,
})

export const ROWS: InspectorRow[] = [
  row('InProcessCheck:fp1', {
    kind: 'FIRST_PIECE',
    kindWords: w('Primo capo', 'First piece'),
    recordType: 'InProcessCheck',
    title: 'B-DEMO-0131 · Fase 30',
    bundle: { id: 'b1', code: 'B-DEMO-0131' },
    operation: { id: 'op30', seq: 30, code: 'ASSEMBLY', name: 'Assemblaggio' },
    plan: { code: 'INL-DEMO', number: 1 },
    blocks: { what: 'RUN', rank: 0, needBy: null, count: 1, words: w('Ferma la produzione di WO-DEMO-0043', 'Holds the run of WO-DEMO-0043') },
    waiting: { minutes: 12, words: w('In attesa da 12 min', 'Waiting 12 min') },
    taken: 'NOBODY',
    may: { record: true, start: false },
  }),
  row('IncomingInspection:in1', {
    kind: 'INCOMING',
    kindWords: w('Collaudo in accettazione', 'Incoming inspection'),
    recordType: 'IncomingInspection',
    number: 'IIN-D-2026-0004',
    title: 'LOT-DEMO-LEA-07 · Pelle bovina nera',
    workOrder: null,
    lot: { id: 'l1', code: 'LOT-DEMO-LEA-07', qualityStatus: 'QUARANTINE' },
    item: { code: 'LEA-BLK', name: 'Pelle bovina nera' },
    progress: { done: 3, of: 8, words: w('3 pelli su 8', '3 of 8 hides') },
    blocks: { what: 'WORK_ORDERS', rank: 1, needBy: '2026-11-12', count: 2, words: w('2 ordini di lavoro aspettano il lotto', '2 work orders need the lot') },
    waiting: { minutes: 190, words: w('In attesa da 3 h 10 min', 'Waiting 3 h 10 min') },
    taken: 'NOBODY',
  }),
  row('Inspection:ins11', {
    number: 'INS-D-2026-0011',
    plan: { code: 'FIN-DEMO', number: 2 },
    progress: { done: 5, of: 8, words: w('5 di 8 controllati', '5 of 8 inspected') },
    blocks: { what: 'SHIPPING', rank: 1, needBy: '2026-11-10', count: 48, words: w('48 capi da spedire entro il 10/11', '48 garments to ship by 10 Nov') },
    dueAt: '2026-11-08T08:00:00.000Z',
    overdue: true,
  }),
  row('WorkOrder:wo44', {
    kind: 'FINAL_DUE',
    kindWords: w('Capi da collaudare', 'Garments to inspect'),
    recordType: null,
    id: null,
    title: 'WO-DEMO-0044 · PAN-02 Pantalone Demo',
    workOrder: { id: 'wo-demo-0044', number: 'WO-DEMO-0044' },
    blocks: { what: 'SHIPPING', rank: 2, needBy: '2026-11-20', count: 24, words: w('24 capi da spedire entro il 20/11', '24 garments to ship by 20 Nov') },
    waiting: { minutes: 75, words: w('In attesa da 1 h 15 min', 'Waiting 1 h 15 min') },
    taken: 'NOBODY',
    may: { record: false, start: true },
    start: { code: 'WO-DEMO-0044', stage: 'FINAL' },
  }),
  row('InProcessCheck:rv1', {
    kind: 'ROVING',
    kindWords: w('Controllo itinerante', 'Roving check'),
    recordType: 'InProcessCheck',
    title: 'L1 · Fase 20',
    operation: { id: 'op20', seq: 20, code: 'SEW', name: 'Cucitura' },
    taken: 'MINE',
  }),
]

export const QUEUE: InspectorQueue = { asOf: AS_OF, rows: ROWS, capped: false }

const HELD = { 'InProcessCheck:fp1': 'noTile', 'IncomingInspection:in1': null, 'Inspection:ins11': null, 'WorkOrder:wo44': null, 'InProcessCheck:rv1': 'noTile' } as const

export const inspections = (extra: Partial<NonNullable<MyWorkViewModel['inspections']>> = {}): NonNullable<MyWorkViewModel['inspections']> => ({
  queue: QUEUE,
  asOf: null,
  problem: null,
  changed: false,
  pending: 0,
  first: true,
  held: HELD,
  ...extra,
})

type Model = (extra?: Partial<MyWorkViewModel>) => MyWorkViewModel
type Frame = (extra?: Record<string, unknown>) => MyWorkViewModel['frame']

/** The W2b inspector-queue cases (at an inspection bench, where the queue is My work's list). */
export function inspectionCases(model: Model, frame: Frame) {
  const bench = { mode: 'inspection' as const, step: { kind: 'inspections' as const } }
  return [
    { id: 'w2b-inspections', label: 'W2b: my inspections, what holds up most first', model: model({ ...bench, inspections: inspections() }), note: 'B-W2b-106\'s order: a first piece\'s run, a lot the work orders need, garments due to ship, then the longest wait. Mine or nobody\'s: never another person.' },
    { id: 'w2b-inspections-changed', label: 'W2b: the queue changed — Show', model: model({ ...bench, inspections: inspections({ changed: true, pending: 2 }) }), note: 'Rows never move under the finger: a fresher queue waits behind "List changed · Show".' },
    { id: 'w2b-inspections-offline', label: 'W2b: my inspections from this tablet', model: model({ ...bench, frame: frame({ online: false }), inspections: inspections({ asOf: AS_OF }) }) },
    { id: 'w2b-inspections-none', label: 'W2b: nothing waits', model: model({ ...bench, inspections: inspections({ queue: { ...QUEUE, rows: [] } }) }) },
    { id: 'w2b-inspections-unread', label: 'W2b: never read, offline', model: model({ ...bench, frame: frame({ online: false }), inspections: inspections({ queue: null, problem: 'offline' }) }) },
    { id: 'w2b-inspections-error', label: 'W2b: could not be read', model: model({ ...bench, inspections: inspections({ queue: null, problem: 'error' }) }) },
    { id: 'w2b-inspections-loading', label: 'W2b: reading my inspections', model: model({ ...bench, inspections: inspections({ queue: null }) }) },
    { id: 'w2b-inspection-final', label: 'W2b: a final inspection\'s card', model: model({ ...bench, step: { kind: 'inspection', key: 'Inspection:ins11' }, inspections: inspections() }), note: 'Inspect opens the final bench on it; a scan does the same.' },
    { id: 'w2b-inspection-due', label: 'W2b: garments that wait — start', model: model({ ...bench, step: { kind: 'inspection', key: 'WorkOrder:wo44' }, inspections: inspections() }) },
    { id: 'w2b-inspection-incoming', label: 'W2b: an incoming inspection\'s card', model: model({ ...bench, step: { kind: 'inspection', key: 'IncomingInspection:in1' }, inspections: inspections() }), note: 'Inspect opens it on Incoming inspection (B-W2b-115, SCR-175) with its number.' },
    {
      id: 'w2b-inspections-tile',
      label: 'W2b: at a sewing station, a For your work tile',
      model: model({ inspections: inspections({ first: false }) }),
      note: 'A team leader with the in-line view: the queue is a tile beside Messages and Repair, never the station\'s list.',
    },
  ]
}
