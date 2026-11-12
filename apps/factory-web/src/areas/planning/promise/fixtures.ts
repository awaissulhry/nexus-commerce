import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { AskAnswer, Atp, AtpCell, Calculation, PromiseHistory, PromiseLine, PromiseList, Proposal, QuoteSuggestion, RepromiseDraft, StockStyle, StyleDetail, StyleOption } from './api'
import { controlsOf, EMPTY_CALC, formOf, promiseCan, type CalcForm, type PromiseControls, type RepromiseForm } from './model'
import type { CalculatorDialog, PromiseModel, RepromiseDialog } from './view-model'
import { PromiseView } from './view/PromiseView'

/**
 * SCR-109 Promise dates with made-up data: an invented site, styles ("DEMO-JKT-01 Giacca Demo Strada"), colourways ("Nero"),
 * customers ("Moto Demo Srl"), orders ("SO-DEMO-1043"), work orders, certificates ("CERT-DEMO-07") and office people ("Anna
 * Demo", "Marco Esempio"). Nothing here is a real company, customer, person or number. Drawn inside the Office shell with the
 * role's navigation; the role decides what is held. Today is Monday 16 November 2026.
 */

const uid = (block: string, n: number) => `0190f0e6-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE = SITES[0]!
const SITE_VIEW = { id: SITE.id, companyId: SITE.companyId, code: SITE.code, name: SITE.name }
const TODAY = '2026-11-16'
const AS_OF = '2026-11-16T08:12:00.000Z'
const named = (block: string, n: number, code: string, name: string) => ({ id: uid(block, n), code, name })
const JKT01 = named('6161', 1, 'DEMO-JKT-01', 'Giacca Demo Strada')
const JKT02 = named('6161', 2, 'DEMO-JKT-02', 'Giacca Demo Pista')
const PNT03 = named('6161', 3, 'DEMO-PNT-03', 'Pantalone Demo Touring')
const NERO = named('7272', 1, 'NER', 'Nero')
const ROSSO = named('7272', 2, 'ROS', 'Rosso')
const CUSTOMER = named('4141', 1, 'C-DEMO-01', 'Moto Demo Srl')
const CUSTOMER2 = named('4141', 2, 'C-DEMO-02', 'Racing Esempio')
const CUSTOMER3 = named('4141', 3, 'C-DEMO-03', 'Team Corse Demo')
const PLANNER = { id: uid('3333', 1), name: 'Anna Demo' }
const SALES = { id: uid('3333', 2), name: 'Marco Esempio' }

type SizeRow = PromiseLine['sizes'][number]
const size = (name: string | null, over: Partial<SizeRow> = {}): SizeRow => ({
  size: name,
  ordered: 4,
  shipped: 0,
  open: 4,
  first: '2026-12-04',
  current: '2026-12-04',
  finish: '2026-11-30',
  finishSource: 'BOARD',
  slackDays: 4,
  risk: 'ON_TIME',
  certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31' },
  workOrders: [],
  engine: null,
  ...over,
})

const line = (n: number, over: Partial<PromiseLine>): PromiseLine => ({
  id: uid('5151', n),
  seq: 10,
  kind: 'SIZE_GRID',
  order: { id: uid('5050', n), number: `SO-DEMO-10${40 + n}`, status: 'IN_PRODUCTION', priorityLevel: 'NORMAL', backlogPosition: n },
  customer: CUSTOMER,
  style: JKT01,
  colourway: NERO,
  sizes: [size('48'), size('50'), size('52')],
  first: '2026-12-04',
  current: '2026-12-04',
  finish: '2026-11-30',
  finishSource: 'BOARD',
  slackDays: 4,
  risk: 'ON_TIME',
  certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31' },
  changes: { count: 0, slips: 0, lastChangeAt: null },
  waiting: null,
  tiles: [],
  may: { repromise: true },
  ...over,
})

const LINES: PromiseLine[] = [
  line(3, {
    order: { id: uid('5050', 3), number: 'SO-DEMO-1043', status: 'IN_PRODUCTION', priorityLevel: 'HIGH', backlogPosition: 1 },
    sizes: [size('48', { finish: '2026-12-10', slackDays: -6, risk: 'AT_RISK' }), size('50', { finish: '2026-12-10', slackDays: -6, risk: 'AT_RISK' }), size('52', { finish: '2026-11-28', slackDays: 6 })],
    finish: '2026-12-10',
    slackDays: -6,
    risk: 'AT_RISK',
    tiles: ['AT_RISK'],
    changes: { count: 1, slips: 1, lastChangeAt: '2026-11-09T10:20:00.000Z' },
    first: '2026-11-27',
  }),
  line(1, {
    customer: CUSTOMER2,
    style: JKT02,
    colourway: ROSSO,
    order: { id: uid('5050', 1), number: 'SO-DEMO-1038', status: 'PARTLY_SHIPPED', priorityLevel: 'NORMAL', backlogPosition: 4 },
    sizes: [size('50', { shipped: 4, open: 0, finish: null, finishSource: 'STOCK', risk: null }), size('52', { current: '2026-11-13', first: '2026-11-13', finish: '2026-11-20', slackDays: -7, risk: 'LATE' })],
    first: '2026-11-13',
    current: '2026-11-13',
    finish: '2026-11-20',
    slackDays: -7,
    risk: 'LATE',
    tiles: ['AT_RISK'],
  }),
  line(4, {
    customer: CUSTOMER3,
    style: PNT03,
    order: { id: uid('5050', 4), number: 'SO-DEMO-1044', status: 'CONFIRMED', priorityLevel: 'NORMAL', backlogPosition: 6 },
    sizes: [size('46', { finishSource: 'CAPABLE', finish: '2026-12-15', current: '2026-12-11', first: '2026-12-04', slackDays: -4, risk: 'AT_RISK', certificate: { state: 'MISSING', certificate: null, validTo: null } })],
    first: '2026-12-04',
    current: '2026-12-11',
    finish: '2026-12-15',
    finishSource: 'CAPABLE',
    slackDays: -4,
    risk: 'AT_RISK',
    certificate: { state: 'MISSING', certificate: null, validTo: null },
    changes: { count: 2, slips: 2, lastChangeAt: '2026-11-12T15:02:00.000Z' },
    waiting: { proposalId: uid('8080', 1), proposedAt: '2026-11-16T07:40:00.000Z', sizes: [{ size: '46', from: '2026-12-11', to: '2026-12-18' }] },
    tiles: ['AT_RISK', 'SLIPPED_THIS_MONTH', 'REPROMISE_WAITING', 'NO_CERTIFICATE'],
  }),
  line(2, {
    order: { id: uid('5050', 2), number: 'SO-DEMO-1042', status: 'CONFIRMED', priorityLevel: 'NORMAL', backlogPosition: 3 },
    kind: 'MADE_TO_MEASURE',
    sizes: [size(null, { ordered: 1, open: 1, finishSource: 'WORK_ORDER_DUE', finish: '2026-12-01', current: '2026-12-09', first: '2026-12-09', slackDays: 8 })],
    current: '2026-12-09',
    first: '2026-12-09',
    finish: '2026-12-01',
    finishSource: 'WORK_ORDER_DUE',
    slackDays: 8,
  }),
  line(5, {
    customer: CUSTOMER2,
    order: { id: uid('5050', 5), number: 'SO-DEMO-1045', status: 'READY', priorityLevel: 'LOW', backlogPosition: null },
    style: JKT02,
    sizes: [size('54', { finishSource: 'STOCK', finish: TODAY, slackDays: 11, current: '2026-11-27', first: '2026-11-20' })],
    first: '2026-11-20',
    current: '2026-11-27',
    finish: TODAY,
    finishSource: 'STOCK',
    slackDays: 11,
    certificate: { state: 'EXPIRING', certificate: 'CERT-DEMO-03', validTo: '2026-11-25' },
    changes: { count: 1, slips: 1, lastChangeAt: '2026-11-03T09:00:00.000Z' },
    tiles: ['SLIPPED_THIS_MONTH', 'NO_CERTIFICATE'],
  }),
  line(6, { order: { id: uid('5050', 6), number: 'SO-DEMO-1046', status: 'CONFIRMED', priorityLevel: 'NORMAL', backlogPosition: 7 }, sizes: [size('56', { current: null, first: null, risk: 'NOT_PROMISED', slackDays: null })], current: null, first: null, risk: 'NOT_PROMISED', slackDays: null }),
]

const LIST: PromiseList = {
  site: SITE_VIEW,
  today: TODAY,
  asOf: AS_OF,
  tiles: { AT_RISK: 3, SLIPPED_THIS_MONTH: 2, REPROMISE_WAITING: 1, NO_CERTIFICATE: 2 },
  counts: { LATE: 1, AT_RISK: 2, NOT_PROMISED: 1, ON_TIME: 2 },
  complete: true,
  lines: LINES,
}
const AT_RISK_LIST: PromiseList = { ...LIST, lines: LINES.filter((entry) => entry.tiles.includes('AT_RISK')) }
const WAITING_LIST: PromiseList = { ...LIST, lines: LINES.filter((entry) => entry.tiles.includes('REPROMISE_WAITING')) }

const HISTORY: PromiseHistory = {
  today: TODAY,
  order: { id: uid('5050', 3), number: 'SO-DEMO-1043', status: 'IN_PRODUCTION', promiseDate: '2026-12-04', originalPromiseDate: '2026-11-27' },
  line: { id: uid('5151', 3), seq: 10, kind: 'SIZE_GRID', style: JKT01, colourway: NERO, promiseDate: '2026-12-04' },
  first: '2026-11-27',
  current: '2026-12-04',
  changes: 1,
  slips: 1,
  sizes: [
    { size: '48', ordered: 4, open: 4, changes: 1, slips: 1, driftDays: 7 },
    { size: '50', ordered: 4, open: 4, changes: 1, slips: 1, driftDays: 7 },
  ],
  rows: [
    { id: uid('9191', 1), size: null, promisedDate: '2026-11-27', kind: 'FIRST', reasonCode: null, reasonWords: null, reason: null, promisedAt: '2026-10-30T09:00:00.000Z', promisedBy: SALES, customerToldAt: null, fromPlan: false, shiftDays: null },
    { id: uid('9191', 2), size: null, promisedDate: '2026-12-04', kind: 'RE_PROMISE', reasonCode: 'MATERIAL_LATE', reasonWords: { it: 'Consegna dei materiali in ritardo', en: 'Material delivery late' }, reason: 'Pelle in ritardo dal fornitore demo.', promisedAt: '2026-11-09T10:20:00.000Z', promisedBy: SALES, customerToldAt: '2026-11-09T10:25:00.000Z', fromPlan: true, shiftDays: 7 },
  ],
  proposals: [
    { id: uid('8080', 9), state: 'ACCEPTED', sizes: [{ size: null, from: '2026-11-27', to: '2026-12-04' }], reasonCode: 'MATERIAL_LATE', proposedAt: '2026-11-09T08:00:00.000Z', proposedBy: PLANNER, decidedAt: '2026-11-09T10:20:00.000Z', decidedBy: SALES, decisionReason: null, told: true },
  ],
}

const REASONS = [
  { code: 'MATERIAL_LATE', it: 'Consegna dei materiali in ritardo', en: 'Material delivery late' },
  { code: 'CAPACITY', it: 'Capacità produttiva', en: 'Production capacity' },
  { code: 'QUALITY', it: 'Controlli di qualità aggiuntivi', en: 'Extra quality checks' },
  { code: 'PLANNING', it: 'La nostra pianificazione è cambiata', en: 'Our planning changed' },
  { code: 'SIZES_FINISH_APART', it: 'Le taglie finiscono in giorni diversi', en: 'Sizes finish on different days' },
]

const MESSAGE_IT = {
  language: 'it' as const,
  subject: 'Nuova data per il vostro ordine SO-DEMO-1043',
  body: 'Buongiorno,\n\nper l’ordine SO-DEMO-1043 (vostro riferimento PO-DEMO-77), riga 10 DEMO-JKT-01 Nero:\n- taglia 48: dal 4 dicembre 2026 al 10 dicembre 2026\n- taglia 50: dal 4 dicembre 2026 al 10 dicembre 2026\n\nMotivo: ritardo nella consegna del materiale.\nCi scusiamo per il disagio.\n\nCordiali saluti',
}

const DRAFT: RepromiseDraft = {
  today: TODAY,
  order: { id: uid('5050', 3), number: 'SO-DEMO-1043', status: 'IN_PRODUCTION', customerRef: 'PO-DEMO-77' },
  line: { id: uid('5151', 3), seq: 10, kind: 'SIZE_GRID', style: JKT01, colourway: NERO },
  customer: CUSTOMER,
  plan: [
    { size: '48', open: 4, current: '2026-12-04', proposed: '2026-12-10', state: 'MAKE', certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31' } },
    { size: '50', open: 4, current: '2026-12-04', proposed: '2026-12-10', state: 'MAKE', certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31' } },
    { size: '52', open: 4, current: '2026-12-04', proposed: '2026-11-28', state: 'MAKE', certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31' } },
  ],
  proposed: [
    { size: '48', from: '2026-12-04', to: '2026-12-10' },
    { size: '50', from: '2026-12-04', to: '2026-12-10' },
  ],
  reasons: REASONS,
  reasonCode: 'MATERIAL_LATE',
  language: 'it',
  message: MESSAGE_IT,
  recipients: ['acquisti@moto-demo.example'],
  waiting: null,
  may: { propose: true },
}

const PROPOSAL: Proposal = {
  id: uid('8080', 1),
  state: 'WAITING',
  order: { id: uid('5050', 4), number: 'SO-DEMO-1044', status: 'CONFIRMED' },
  line: { id: uid('5151', 4), seq: 10, style: PNT03, colourway: NERO },
  customer: CUSTOMER3,
  siteId: SITE.id,
  sizes: [{ size: '46', from: '2026-12-11', to: '2026-12-18' }],
  reasonCode: 'CAPACITY',
  reason: 'Linea 2 piena la settimana 50.',
  message: { language: 'en', subject: 'A new date for your order SO-DEMO-1044', body: 'Hello,\n\nfor order SO-DEMO-1044, line 10 DEMO-PNT-03 Nero:\n- size 46: from 11 December 2026 to 18 December 2026\n\nReason: production capacity.\nWe are sorry for the inconvenience.\n\nKind regards' },
  recipients: ['orders@team-corse-demo.example'],
  proposedAt: '2026-11-16T07:40:00.000Z',
  proposedBy: PLANNER,
  decision: null,
  task: { id: uid('8080', 1), status: 'OPEN', assignee: SALES },
  may: { accept: true, tell: true, decline: true, withdraw: false },
}
const WAITING_DRAFT: RepromiseDraft = {
  ...DRAFT,
  order: { id: uid('5050', 4), number: 'SO-DEMO-1044', status: 'CONFIRMED', customerRef: null },
  line: { id: uid('5151', 4), seq: 10, kind: 'SIZE_GRID', style: PNT03, colourway: NERO },
  customer: CUSTOMER3,
  plan: [{ size: '46', open: 4, current: '2026-12-11', proposed: '2026-12-18', state: 'MAKE', certificate: { state: 'MISSING', certificate: null, validTo: null } }],
  proposed: [{ size: '46', from: '2026-12-11', to: '2026-12-18' }],
  language: 'en',
  waiting: PROPOSAL,
}

// ---- available to promise ------------------------------------------------------------------------------------------------

const WEEKS = Array.from({ length: 8 }, (_, index) => {
  const from = new Date(Date.UTC(2026, 10, 16 + index * 7))
  const to = new Date(Date.UTC(2026, 10, 22 + index * 7))
  return { key: `2026-W${47 + index}`, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
})
const cellsOf = (onHand: number, receipts: readonly number[], committed: readonly number[]): AtpCell[] => {
  let running = onHand
  const cumulative = WEEKS.map((_, index) => (running += (receipts[index] ?? 0) - (committed[index] ?? 0)))
  return WEEKS.map((week, index) => {
    const least = Math.min(...cumulative.slice(index))
    return { key: week.key, from: week.from, to: week.to, receipts: receipts[index] ?? 0, committed: committed[index] ?? 0, cumulative: cumulative[index]!, available: Math.max(0, least), short: Math.max(0, -cumulative[index]!), lastReceipt: (receipts[index] ?? 0) > 0 ? week.to : null }
  })
}
const atpSize = (name: string, onHand: number, receipts: readonly number[], committed: readonly number[], sources: Atp['colourways'][number]['sizes'][number]['sources'] = []) => {
  const cells = cellsOf(onHand, receipts, committed)
  return { size: name, sku: `DEMO-JKT-01-NER-${name}`, strategy: 'MAKE_TO_STOCK', onHand, availableNow: cells[0]!.available, later: { receipts: 0, committed: 0 }, cells, sources }
}
const sumCells = (sizes: readonly { cells: AtpCell[]; onHand: number; availableNow: number }[]) => ({
  onHand: sizes.reduce((sum, entry) => sum + entry.onHand, 0),
  availableNow: sizes.reduce((sum, entry) => sum + entry.availableNow, 0),
  later: { receipts: 0, committed: 0 },
  cells: WEEKS.map((week, index) => {
    const at = sizes.map((entry) => entry.cells[index]!)
    return { key: week.key, from: week.from, to: week.to, receipts: at.reduce((s, c) => s + c.receipts, 0), committed: at.reduce((s, c) => s + c.committed, 0), cumulative: at.reduce((s, c) => s + c.cumulative, 0), available: at.reduce((s, c) => s + c.available, 0), short: at.reduce((s, c) => s + c.short, 0), lastReceipt: null }
  }),
})
const NERO_SIZES = [
  atpSize('48', 6, [0, 0, 10], [2, 0, 0, 4], [{ kind: 'ORDER_LINE', id: uid('5050', 11), number: 'SO-DEMO-1049', date: '2026-11-18', pieces: 2 }, { kind: 'WORK_ORDER', id: uid('7070', 1), number: 'WO-DEMO-0221', date: '2026-12-02', pieces: 10 }]),
  atpSize('50', 4, [0, 0, 10], [0, 3, 0, 8], [{ kind: 'ORDER_LINE', id: uid('5050', 12), number: 'SO-DEMO-1050', date: '2026-11-25', pieces: 3 }, { kind: 'WORK_ORDER', id: uid('7070', 1), number: 'WO-DEMO-0221', date: '2026-12-02', pieces: 10 }]),
  atpSize('52', 2, [0, 0, 0, 0, 12], [4, 0, 0, 0, 0], [{ kind: 'ORDER_LINE', id: uid('5050', 13), number: 'SO-DEMO-1051', date: '2026-11-17', pieces: 4 }, { kind: 'PLANNED_ORDER', id: uid('7171', 1), number: 'PL-2', date: '2026-12-14', pieces: 12 }]),
  atpSize('54', 0, [], []),
]
const ROSSO_SIZES = [atpSize('50', 3, [], [1]), atpSize('52', 5, [0, 6], [0, 0, 2])].map((entry) => ({ ...entry, sku: entry.sku.replace('NER', 'ROS') }))
const ATP: Atp = {
  today: TODAY,
  asOf: AS_OF,
  style: { id: JKT01.id, code: JKT01.code, name: JKT01.name, sizes: ['46', '48', '50', '52', '54', '56'] },
  stockStyle: true,
  weeks: WEEKS,
  colourways: [
    { colourway: NERO, ...sumCells(NERO_SIZES), sizes: NERO_SIZES },
    { colourway: ROSSO, ...sumCells(ROSSO_SIZES), sizes: ROSSO_SIZES },
  ],
  empty: false,
}
const STOCK_STYLES: StockStyle[] = [
  { id: JKT01.id, code: JKT01.code, name: JKT01.name, makeToStock: true, onHand: true },
  { id: JKT02.id, code: JKT02.code, name: JKT02.name, makeToStock: false, onHand: true },
]

// ---- the calculator ------------------------------------------------------------------------------------------------------

const STYLE_OPTIONS: StyleOption[] = [
  { id: JKT01.id, code: JKT01.code, name: JKT01.name, sizes: ['46', '48', '50', '52', '54', '56'] },
  { id: PNT03.id, code: PNT03.code, name: PNT03.name, sizes: ['44', '46', '48', '50'] },
]
const STYLE_DETAIL: StyleDetail = { ...STYLE_OPTIONS[0]!, colourways: [{ id: NERO.id, code: NERO.code, name: NERO.name, status: 'ACTIVE', offeredSizes: ['46', '48', '50', '52', '54', '56'] }, { id: ROSSO.id, code: ROSSO.code, name: ROSSO.name, status: 'ACTIVE', offeredSizes: ['48', '50', '52'] }] }
const CALC_FORM: CalcForm = { styleId: JKT01.id, colourwayId: NERO.id, quantities: { '48': 10, '50': 20, '52': 20, '56': 6 }, wanted: '2026-12-11', country: 'IT' }
const bridge = { materialDays: 14, baseDays: 15, queueDays: 6, spanDays: 35, materialDate: '2026-11-30', finish: '2026-12-21' }
const material = { date: '2026-11-30', setBy: { itemId: uid('7373', 1), label: 'DEMO-LEA-01 Nappa Nero', source: 'BUY' as const, date: '2026-11-30', leadTimeDays: 14 } }
const ANSWER: AskAnswer = {
  style: JKT01,
  colourway: NERO,
  revision: { id: uid('7474', 1), revision: 3, status: 'RELEASED' },
  madeToMeasure: false,
  wantedDate: '2026-12-11',
  date: '2026-12-21',
  earliest: '2026-11-16',
  complete: false,
  meetsWanted: false,
  daysLate: 10,
  sizes: [
    { size: '48', quantity: 10, fromStock: 4, toMake: 6, state: 'STOCK_AND_MAKE', date: '2026-12-14', readyDate: '2026-12-14', meetsWanted: false, daysLate: 3, material, bridge: { ...bridge, spanDays: 28, finish: '2026-12-14', queueDays: 0 }, certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31', requirementCode: 'CERT-COVERAGE', heldAtShipment: null } },
    { size: '50', quantity: 20, fromStock: 0, toMake: 20, state: 'MAKE', date: '2026-12-21', readyDate: '2026-12-21', meetsWanted: false, daysLate: 10, material, bridge, certificate: { state: 'OK', certificate: 'CERT-DEMO-07', validTo: '2027-03-31', requirementCode: 'CERT-COVERAGE', heldAtShipment: null } },
    { size: '52', quantity: 20, fromStock: 0, toMake: 20, state: 'MAKE', date: '2026-12-21', readyDate: '2026-12-21', meetsWanted: false, daysLate: 10, material, bridge, certificate: { state: 'EXPIRING', certificate: 'CERT-DEMO-07', validTo: '2027-01-15', requirementCode: 'CERT-COVERAGE', heldAtShipment: null } },
    { size: '56', quantity: 6, fromStock: 0, toMake: 0, state: 'NOT_CERTIFIED', date: null, readyDate: null, meetsWanted: false, daysLate: null, material: null, bridge: null, certificate: { state: 'MISSING', certificate: 'CERT-DEMO-07', validTo: null, requirementCode: 'CERT-COVERAGE', heldAtShipment: null } },
  ],
  groups: [
    { sizes: ['48'], date: '2026-12-14' },
    { sizes: ['50', '52'], date: '2026-12-21' },
    { sizes: ['56'], date: null },
  ],
  bridge,
  steps: [
    { seq: 10, name: 'Taglio', outside: false, lane: { code: 'CUT', name: 'Taglio' }, start: '2026-11-30', finish: '2026-12-02' },
    { seq: 20, name: 'Cucitura', outside: false, lane: { code: 'L2', name: 'Linea 2' }, start: '2026-12-03', finish: '2026-12-17' },
    { seq: 30, name: 'Ricamo', outside: true, lane: null, start: '2026-12-18', finish: '2026-12-19' },
    { seq: 40, name: 'Controllo e imballo', outside: false, lane: { code: 'QC', name: 'Controllo' }, start: '2026-12-21', finish: '2026-12-21' },
  ],
  warnings: [{ code: 'NO_LEAD_TIME' }, { code: 'SOMETHING_NEW' }],
}
const CALCULATION: Calculation = { today: TODAY, asOf: AS_OF, market: { code: 'IT', name: 'Italia' }, answer: ANSWER }
const QUOTE: QuoteSuggestion = {
  today: TODAY,
  asOf: AS_OF,
  market: null,
  quote: { id: uid('6262', 1), number: 'Q-DEMO-0210', revision: 2, status: 'DRAFT', promiseDate: null, version: 4 },
  promiseDate: '2026-12-21',
  lines: [
    { lineId: uid('6363', 1), seq: 10, answer: ANSWER },
    { lineId: uid('6363', 2), seq: 20, answer: { ...ANSWER, style: PNT03, date: '2026-12-09', groups: [{ sizes: ['44', '46', '48'], date: '2026-12-09' }], complete: true } },
  ],
  skipped: [{ lineId: uid('6363', 3), seq: 30 }],
  mayUse: true,
}

// ---- the cases -----------------------------------------------------------------------------------------------------------

export interface PromiseCase {
  model: PromiseModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/promise',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/promise' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function PromiseDesign({ model }: { model: PromiseCase }) {
  return inShell(createElement(PromiseView, { model: model.model }), model.permissions)
}

const PLANNER_ROLE = rolePermissions('planner')
const SALES_ROLE = rolePermissions('sales')
const BASE_CONTROLS: PromiseControls = { ...controlsOf(null), site: SITE.id, style: JKT01.id }

function make(over: Partial<PromiseModel> = {}, permissions: readonly string[] = PLANNER_ROLE, me: string = PLANNER.id): PromiseCase {
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: promiseCan(permissions),
      me,
      sites: { status: 'ready', value: [SITE_VIEW] },
      siteId: SITE.id,
      list: { status: 'ready', value: LIST },
      history: null,
      styles: { status: 'ready', value: STOCK_STYLES },
      atp: { status: 'ready', value: ATP },
      repromise: null,
      calculator: null,
      live: 'live',
      updates: 0,
      notice: null,
      dialog: null,
      built: OFFICE_PAGES,
      ...over,
      controls: { ...BASE_CONTROLS, ...(over.controls ?? {}) },
    },
  }
}

const repromise = (over: Partial<RepromiseDialog> = {}, draft: RepromiseDraft = DRAFT): RepromiseDialog => ({
  lineId: draft.line.id,
  draft: { status: 'ready', value: draft },
  form: formOf(draft),
  tell: !!draft.waiting,
  declining: false,
  declineReason: '',
  busy: null,
  problem: null,
  done: null,
  ...over,
})
const editedForm = (over: Partial<RepromiseForm>): RepromiseForm => ({ ...formOf(DRAFT), ...over })
const calculator = (over: Partial<CalculatorDialog> = {}): CalculatorDialog => ({ styles: { status: 'ready', value: STYLE_OPTIONS }, style: null, form: EMPTY_CALC, answer: null, quote: null, using: false, used: null, problem: null, ...over })
const filled = { style: { status: 'ready' as const, value: STYLE_DETAIL }, form: CALC_FORM }
const SALES_OWN = SALES_ROLE.filter((name) => name !== 'planning.view')

/** Exported for the page's test (the calls and the rules read the same made-up answers). */
export const FIXTURES = { LIST, LINES, HISTORY, DRAFT, WAITING_DRAFT, PROPOSAL, ATP, ANSWER, CALCULATION, QUOTE, STYLE_DETAIL, CALC_FORM, TODAY, PLANNER, SALES }

export const designScreen = defineDesignScreen<PromiseCase>({
  screen: 'SCR-109',
  title: 'Promise dates',
  view: PromiseDesign,
  cases: [
    { id: 'planner', label: 'The planner: tiles, open lines, available to promise', model: make(), note: 'Lines worst first (late, then the least slack). The Changes cell opens the history; Re-promise is the row verb and p; the order opens in its record (⌘-click a new tab).' },
    { id: 'tile-at-risk', label: 'Tile At risk pressed', model: make({ list: { status: 'ready', value: AT_RISK_LIST }, controls: { ...BASE_CONTROLS, tile: 'AT_RISK' } }) },
    { id: 'tile-waiting', label: 'Tile Re-promise waiting for sales pressed', model: make({ list: { status: 'ready', value: WAITING_LIST }, controls: { ...BASE_CONTROLS, tile: 'REPROMISE_WAITING' } }) },
    { id: 'risk-late', label: 'Risk filter: Late', model: make({ list: { status: 'ready', value: { ...LIST, lines: LINES.filter((entry) => entry.risk === 'LATE') } }, controls: { ...BASE_CONTROLS, risk: 'LATE' } }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: make({ list: { status: 'ready', value: { ...LIST, lines: [] } }, controls: { ...BASE_CONTROLS, q: 'zzz' } }) },
    { id: 'history', label: 'History popover on the Changes cell', model: make({ history: { lineId: LINES[0]!.id, history: { status: 'ready', value: HISTORY } } }), note: 'The first promise is kept forever; each change with its reason in the customer’s words, the office note, who promised (inside this one line) and whether the customer was told.' },
    { id: 'history-loading', label: 'History popover: reading', model: make({ history: { lineId: LINES[0]!.id, history: { status: 'loading' } } }) },
    { id: 'history-error', label: 'History popover: failed, Try again', model: make({ history: { lineId: LINES[0]!.id, history: { status: 'error', problem: 'error.offline' } } }) },
    { id: 'selection', label: 'Two lines ticked: Export 2', model: make({ selected: [LINES[0]!.id, LINES[1]!.id] }) },
    { id: 'repromise', label: 'Re-promise SO-DEMO-1043: the plan’s day per size, reason, message (planner)', model: make({ repromise: repromise(), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }), note: 'The plan moves 48 and 50 to 10 Dec; 52 keeps its promise unless a day is given. Send to sales for acceptance.' },
    { id: 'repromise-own-words', label: 'Re-promise: other words to the customer, a day changed by hand', model: make({ repromise: repromise({ form: editedForm({ dates: { '48': '2026-12-11', '50': '2026-12-10' }, own: true, note: 'Pelle in ritardo, confermato dal fornitore demo.' }) }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-stale-preview', label: 'Re-promise: the preview will be written again with the days sent', model: make({ repromise: repromise({ form: editedForm({ dates: { '48': '2026-12-11' }, reasonCode: 'CAPACITY' }) }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-held', label: 'Re-promise held: a past day, no reason', model: make({ repromise: repromise({ form: editedForm({ dates: { '48': '2026-11-10' }, reasonCode: '' }) }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-nothing', label: 'Re-promise held: nothing moved', model: make({ repromise: repromise({ form: editedForm({ dates: {} }) }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-refused', label: 'Re-promise refused: no certificate covers a size on its day', model: make({ repromise: repromise({ problem: { key: 'refusal.CERTIFICATE', sizes: [1] } }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-offline', label: 'Re-promise: no connection, nothing sent', model: make({ repromise: repromise({ problem: { key: 'refusal.offline', sizes: [] } }), live: 'offline', controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-sending', label: 'Re-promise: sending', model: make({ repromise: repromise({ busy: 'propose' }), controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-sent', label: 'Re-promise sent to sales', model: make({ repromise: repromise({ done: { kind: 'proposed', proposal: { ...PROPOSAL, order: { ...PROPOSAL.order, number: 'SO-DEMO-1043' }, sizes: DRAFT.proposed } } }), notice: { tone: 'success', key: 'notice.proposed', params: { order: 'SO-DEMO-1043', line: 10 } }, controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-loading', label: 'Re-promise: reading the line', model: make({ repromise: { ...repromise(), draft: { status: 'loading' }, form: null }, controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-error', label: 'Re-promise: the line could not be read', model: make({ repromise: { ...repromise(), draft: { status: 'error', problem: 'error.gone' }, form: null }, controls: { ...BASE_CONTROLS, repromise: DRAFT.line.id } }) },
    { id: 'repromise-read-only', label: 'Read-only: Re-promise held with the reason', model: make({ repromise: repromise() }, rolePermissions('read_only'), uid('3333', 9)) },
    { id: 'decide', label: 'Sales gives the word: Accept and tell the customer, Decline', model: make({ list: { status: 'ready', value: WAITING_LIST }, repromise: repromise({}, WAITING_DRAFT), controls: { ...BASE_CONTROLS, tile: 'REPROMISE_WAITING', repromise: WAITING_DRAFT.line.id } }, SALES_OWN, SALES.id), note: 'Sales has no planning.view: the sites are their own. Telling the customer sends the message on the order’s thread (a FAKE provider locally).' },
    { id: 'decide-declining', label: 'Sales declines: the reason the planner reads', model: make({ repromise: repromise({ declining: true, declineReason: 'Il cliente non accetta: chiedere un trasferimento di linea.' }, WAITING_DRAFT), controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }, SALES_OWN, SALES.id) },
    { id: 'decide-own', label: 'The proposer opens it: nobody decides their own request (the Owner included)', model: make({ repromise: repromise({}, { ...WAITING_DRAFT, waiting: { ...PROPOSAL, may: { accept: false, tell: false, decline: false, withdraw: true } } }), controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }, rolePermissions('owner'), PLANNER.id) },
    { id: 'decide-planner', label: 'The planner who proposed it: Take it back; Accept held for sales', model: make({ repromise: repromise({}, { ...WAITING_DRAFT, waiting: { ...PROPOSAL, may: { accept: false, tell: false, decline: false, withdraw: true } } }), controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }) },
    { id: 'decide-no-address', label: 'Sales: the customer has no e-mail address (tell held)', model: make({ repromise: repromise({ tell: false }, { ...WAITING_DRAFT, waiting: { ...PROPOSAL, recipients: [], may: { ...PROPOSAL.may, tell: false } } }), controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }, SALES_OWN, SALES.id) },
    { id: 'decide-stale', label: 'Sales: the promise changed since (propose again)', model: make({ repromise: repromise({ problem: { key: 'refusal.STALE', sizes: [] } }, WAITING_DRAFT), controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }, SALES_OWN, SALES.id) },
    { id: 'accepted', label: 'Accepted and the customer told', model: make({ repromise: repromise({ done: { kind: 'accepted', proposal: { ...PROPOSAL, state: 'ACCEPTED' }, answer: { told: true, outboundId: uid('9999', 1), lineDate: '2026-12-18', replayed: false, proposal: { ...PROPOSAL, state: 'ACCEPTED' } } } }, WAITING_DRAFT), notice: { tone: 'success', key: 'notice.acceptedTold', params: { order: 'SO-DEMO-1044', line: 10 } }, controls: { ...BASE_CONTROLS, repromise: WAITING_DRAFT.line.id } }, SALES_OWN, SALES.id) },
    { id: 'calc', label: 'Promise calculator: pick a style', model: make({ calculator: calculator(), controls: { ...BASE_CONTROLS, calc: true } }) },
    { id: 'calc-filled', label: 'Promise calculator: style, colour, quantity per size, wanted day', model: make({ calculator: calculator(filled), controls: { ...BASE_CONTROLS, calc: true } }) },
    { id: 'calc-answer', label: 'Promise calculator: the date, its bridge, per size, the certificate', model: make({ calculator: calculator({ ...filled, answer: { status: 'ready', value: CALCULATION } }), controls: { ...BASE_CONTROLS, calc: true } }), note: 'The bridge: base lead time + queue at today’s load + the leather to buy = days → day. Size 56 is not certified: not promised.' },
    { id: 'calc-loading', label: 'Promise calculator: calculating', model: make({ calculator: calculator({ ...filled, answer: { status: 'loading' } }), controls: { ...BASE_CONTROLS, calc: true } }) },
    { id: 'calc-error', label: 'Promise calculator: refused', model: make({ calculator: calculator({ ...filled, answer: { status: 'error', problem: 'refusal.invalid' } }), controls: { ...BASE_CONTROLS, calc: true } }) },
    { id: 'calc-quote', label: 'From a quote’s Suggest date: Use on quote (sales)', model: make({ calculator: calculator({ quote: { status: 'ready', value: QUOTE } }), controls: { ...BASE_CONTROLS, calc: true, quote: QUOTE.quote.id } }, SALES_OWN, SALES.id) },
    { id: 'calc-quote-used', label: 'Use on quote: done', model: make({ calculator: calculator({ quote: { status: 'ready', value: QUOTE }, used: { promiseDate: '2026-12-21' } }), notice: { tone: 'success', key: 'notice.usedOnQuote', params: { quote: 'Q-DEMO-0210' } }, controls: { ...BASE_CONTROLS, calc: true, quote: QUOTE.quote.id } }, SALES_OWN, SALES.id) },
    { id: 'calc-quote-held', label: 'Use on quote held: the quote is not a draft', model: make({ calculator: calculator({ quote: { status: 'ready', value: { ...QUOTE, mayUse: false, quote: { ...QUOTE.quote, status: 'SENT' } } } }), controls: { ...BASE_CONTROLS, calc: true, quote: QUOTE.quote.id } }, SALES_OWN, SALES.id) },
    { id: 'atp-week', label: 'Available to promise: another week in the size grid', model: make({ controls: { ...BASE_CONTROLS, week: WEEKS[3]!.key } }) },
    { id: 'atp-selection', label: 'Available to promise: sizes ticked → Promise calculator for 2 sizes', model: make({ selectedAtp: [`${NERO.id}|48`, `${NERO.id}|50`] }) },
    { id: 'atp-pick', label: 'Available to promise: no style picked yet', model: make({ atp: null, controls: { ...BASE_CONTROLS, style: null } }) },
    { id: 'atp-empty', label: 'Available to promise: no stock or planned receipts', model: make({ atp: { status: 'ready', value: { ...ATP, colourways: [], empty: true } } }) },
    { id: 'atp-not-stock', label: 'Available to promise: a style not made to stock', model: make({ atp: { status: 'ready', value: { ...ATP, stockStyle: false } }, controls: { ...BASE_CONTROLS, style: JKT02.id } }) },
    { id: 'atp-loading', label: 'Available to promise: loading', model: make({ atp: { status: 'loading' } }) },
    { id: 'atp-error', label: 'Available to promise: failed, Try again', model: make({ atp: { status: 'error', problem: 'error.offline' } }) },
    { id: 'incomplete', label: 'More than 300 open lines: the first are shown', model: make({ list: { status: 'ready', value: { ...LIST, complete: false } } }) },
    { id: 'updates', label: 'Live: 3 updates · Show', model: make({ updates: 3 }) },
    { id: 'empty', label: 'No open order lines', model: make({ list: { status: 'ready', value: { ...LIST, lines: [], tiles: { AT_RISK: 0, SLIPPED_THIS_MONTH: 0, REPROMISE_WAITING: 0, NO_CERTIFICATE: 0 }, counts: { LATE: 0, AT_RISK: 0, NOT_PROMISED: 0, ON_TIME: 0 } } } }) },
    { id: 'two-sites', label: 'Two sites: the site is picked in the band', model: make({ sites: { status: 'ready', value: SITES.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })) } }) },
    { id: 'loading', label: 'Loading', model: make({ list: { status: 'loading' }, styles: { status: 'loading' }, atp: null, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load promises (offline)', model: make({ list: { status: 'error', problem: 'error.offline' }, styles: { status: 'error', problem: 'error.offline' }, atp: null, live: 'offline' }), note: 'A failed read is never drawn as empty: tiles and lines say why with Try again.' },
    { id: 'sales', label: 'Sales: reads promises; Re-promise held, Review where one waits', model: make({}, SALES_OWN, SALES.id) },
    { id: 'production-manager', label: 'Production manager: proposes like the planner', model: make({}, rolePermissions('production_manager'), uid('3333', 7)) },
    { id: 'read-only', label: 'Read-only: everything shown, Re-promise held with the reason', model: make({}, rolePermissions('read_only'), uid('3333', 9)) },
    { id: 'no-permission', label: 'Buyer: no planning.promise.view — the page says so (the row is hidden in the navigation)', model: make({}, rolePermissions('buyer'), uid('3333', 8)) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 0, keysOpen: true }) },
  ],
})
