import { at, COLOURS, ITEMS, LOCATIONS, LOTS, NOW, SITE, SUPPLIERS, uid, WORK_ORDERS } from '../../../../_shared/stock/fixtures'
import type { WorkOrderOption } from '../../../stock/daily/api'
import type { CuttingYield, GradeMix, LeatherDashboard, LeatherValue } from '../../dashboard/api'
import type { LeatherDashboardModel } from '../../dashboard/use-dashboard'
import type { FindAnswer } from '../../find/api'
import { emptyDraft, proposedIds, type ArticleOption, type FindDialogModel } from '../../find/find-model'
import { moveHides, type MoveDialogModel } from '../../move/move-model'
import type { RemnantRecord, RemnantRow, RemnantsPage } from '../../remnants/api'
import type { RemnantsListModel } from '../../remnants/view/RemnantsList'
import { HIDE_ROWS, tag } from '../fixtures'

/**
 * Made-up data for the design cases of Hides' W2b parts (B-W2b-131: SCR-134 the leather dashboard, SCR-200's Find hides for a
 * job, Move…, the remnant pieces): an invented nappa (ft²) and suede (m², dm²), invented lots, workshops and styles. Nothing
 * here is a real company, person, tag or number. Design-only.
 */

const grade = (code: string, it: string, en: string) => ({ id: uid('5151', code.charCodeAt(0)), code, labelIt: it, labelEn: en, active: true })
export const GRADES = { A: grade('A', 'Prima scelta', 'First choice'), B: grade('B', 'Seconda scelta', 'Second choice'), C: grade('C', 'Terza scelta', 'Third choice') }

// ---- the dashboard's reads -------------------------------------------------------------------------------------------------

export const LEATHER_VALUE: LeatherValue = {
  rows: [
    {
      site: { id: SITE.id, code: SITE.code },
      item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name, baseUom: 'FT2' },
      colour: COLOURS.black,
      hides: 9,
      quantity: '412.5000',
      areaM2: '38.3225',
      value: 173_250,
      valuePerM2: '45.2085',
      currency: 'EUR',
      lots: [],
    },
    {
      site: { id: SITE.id, code: SITE.code },
      item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name, baseUom: 'FT2' },
      colour: COLOURS.red,
      hides: 3,
      quantity: '147.9000',
      areaM2: '13.7403',
      value: 62_118,
      valuePerM2: '45.2085',
      currency: 'EUR',
      lots: [],
    },
    {
      site: { id: SITE.id, code: SITE.code },
      item: { id: ITEMS.suede.id, code: ITEMS.suede.code, name: ITEMS.suede.name, baseUom: 'M2' },
      colour: COLOURS.grey,
      hides: 2,
      quantity: '10.0000',
      areaM2: '10.0000',
      value: 31_000,
      valuePerM2: '31.0000',
      currency: 'EUR',
      lots: [],
    },
  ],
  hides: 14,
  areaM2: '62.0628',
  value: 266_368,
  currency: 'EUR',
  notArea: 0,
}

/** The same without the cost grain: the values are absent (the API drops them). */
export const LEATHER_AREA_ONLY: LeatherValue = { ...LEATHER_VALUE, value: undefined, rows: LEATHER_VALUE.rows.map(({ value: _value, valuePerM2: _perM2, ...row }) => row) }

const mixLot = (lot: { id: string; code: string }, item: typeof ITEMS.leather | typeof ITEMS.suede, colour: { id: string; code: string; name: string }, grades: GradeMix['groups'][number]['grades'], left: string, hides: number, remnants = { pieces: 0, area: '0.0000' }): GradeMix['groups'][number] => ({
  item: { id: item.id, code: item.code, name: item.name },
  colour,
  lot: { id: lot.id, code: lot.code, dyeBatch: 'TB-7781', receivedAt: at(14, 10) },
  uom: item.baseUom as 'FT2' | 'M2',
  hides,
  measured: left,
  left,
  usable: '0.0000',
  ungradedLeft: '0.0000',
  grades,
  remnants,
})
const mixRow = (g: (typeof GRADES)[keyof typeof GRADES] | null, left: string, hides: number) => ({ grade: g, texts: g ? [] : ['Extra'], hides, left, usable: g ? left : null, percentOfArea: '0.00' })
export const GRADE_MIX: GradeMix = {
  groupBy: 'lot',
  groups: [
    mixLot(LOTS.nappa, ITEMS.leather, COLOURS.black, [mixRow(GRADES.A, '208.2000', 4), mixRow(GRADES.B, '154.1000', 3), mixRow(null, '50.2000', 1)], '412.5000', 8, { pieces: 3, area: '18.4000' }),
    mixLot(LOTS.nappaQuarantine, ITEMS.leather, COLOURS.red, [mixRow(GRADES.B, '98.6000', 2), mixRow(GRADES.C, '49.3000', 1)], '147.9000', 3),
    mixLot(LOTS.suedeFail, ITEMS.suede, COLOURS.grey, [mixRow(GRADES.A, '10.0000', 2)], '10.0000', 2, { pieces: 1, area: '0.4000' }),
  ],
  totals: [
    { uom: 'FT2', hides: 11, left: '560.4000', usable: '0.0000', ungradedLeft: '50.2000', remnants: { pieces: 3, area: '18.4000' } },
    { uom: 'M2', hides: 2, left: '10.0000', usable: '0.0000', ungradedLeft: '0.0000', remnants: { pieces: 1, area: '0.4000' } },
  ],
}

const WORKSHOP = { id: uid('2424', 1), code: 'N-TERZ-01', name: 'Laboratorio Esempio (nostra merce)' }
export const LEATHER_DASHBOARD: LeatherDashboard = {
  asOf: NOW,
  atSubcontractors: {
    rows: [{ location: WORKSHOP, party: { id: uid('6061', 1), name: 'Laboratorio Esempio S.n.c.' }, item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name }, colour: COLOURS.black, uom: 'FT2', hides: 2, area: '98.0000' }],
    sums: [{ uom: 'FT2', hides: 2, area: '98.0000' }],
  },
  onHold: {
    rows: [
      { item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name }, colour: COLOURS.red, uom: 'FT2', lotNotReleased: { hides: 3, area: '147.9000' }, qualityHold: { hides: 0, area: '0.0000' } },
      { item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name }, colour: COLOURS.black, uom: 'FT2', lotNotReleased: { hides: 0, area: '0.0000' }, qualityHold: { hides: 1, area: '51.8000' } },
      { item: { id: ITEMS.suede.id, code: ITEMS.suede.code, name: ITEMS.suede.name }, colour: COLOURS.grey, uom: 'M2', lotNotReleased: { hides: 2, area: '10.0000' }, qualityHold: { hides: 0, area: '0.0000' } },
    ],
    sums: [
      { uom: 'FT2', lotNotReleased: { hides: 3, area: '147.9000' }, qualityHold: { hides: 1, area: '51.8000' } },
      { uom: 'M2', lotNotReleased: { hides: 2, area: '10.0000' }, qualityHold: { hides: 0, area: '0.0000' } },
    ],
  },
}

const style = (n: number, code: string, name: string) => ({ id: uid('5353', n), code, name })
export const CUTTING_YIELD: CuttingYield = {
  byStyleAndLot: [
    { style: style(1, 'GIACCA-DEMO-01', 'Giacca racing demo'), lot: { id: LOTS.nappa.id, code: LOTS.nappa.code, supplierLotRef: 'CD-2210' }, supplier: SUPPLIERS.tannery, hides: 6, used: '284.0000', pattern: '205.6000', yieldPct: '72.39', plannedPct: '70.00', variancePct: '2.39' },
    { style: style(2, 'PANT-DEMO-02', 'Pantalone touring demo'), lot: { id: LOTS.nappa.id, code: LOTS.nappa.code, supplierLotRef: 'CD-2210' }, supplier: SUPPLIERS.tannery, hides: 3, used: '150.0000', pattern: '98.5000', yieldPct: '65.67', plannedPct: '68.00', variancePct: '-2.33' },
    { style: style(1, 'GIACCA-DEMO-01', 'Giacca racing demo'), lot: { id: LOTS.nappaQuarantine.id, code: LOTS.nappaQuarantine.code, supplierLotRef: 'CD-2231' }, supplier: SUPPLIERS.tannery, hides: 2, used: '96.0000', pattern: '61.0000', yieldPct: '63.54', plannedPct: '70.00', variancePct: '-6.46' },
  ],
  overall: { used: '530.0000', yieldPct: '68.96', plannedPct: '69.20', variancePct: '-0.24' },
}

const ready = <T>(value: T) => ({ value, problem: null, asOf: NOW })
export function dashboardModel(over: Partial<LeatherDashboardModel> = {}): LeatherDashboardModel {
  return { open: true, cost: false, series: 'area', area: ready(LEATHER_AREA_ONLY), mix: ready(GRADE_MIX), dashboard: ready(LEATHER_DASHBOARD), yield: ready(CUTTING_YIELD), active: { article: null, lot: null }, ...over }
}
export const PANEL_LOADING = { value: null, problem: null, asOf: null }

// ---- Find hides for a job --------------------------------------------------------------------------------------------------

export const ARTICLES: ArticleOption[] = [
  { key: `${ITEMS.leather.id}|${COLOURS.black.id}`, itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id, label: `${ITEMS.leather.code} · ${ITEMS.leather.name} · ${COLOURS.black.name}`, hides: 8, left: '412.5000', uom: 'FT2' },
  { key: `${ITEMS.suede.id}|${COLOURS.grey.id}`, itemId: ITEMS.suede.id, itemColourId: COLOURS.grey.id, label: `${ITEMS.suede.code} · ${ITEMS.suede.name} · ${COLOURS.grey.name}`, hides: 2, left: '10.0000', uom: 'M2' },
]
export const OPEN_WORK_ORDERS: WorkOrderOption[] = [
  { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, status: 'RELEASED', siteId: SITE.id, styleCode: 'GIACCA-DEMO-01', styleName: 'Giacca racing demo', dueDate: '2026-11-12', pieces: 24 },
  { id: WORK_ORDERS.b.id, number: WORK_ORDERS.b.number, status: 'IN_PROGRESS', siteId: SITE.id, styleCode: 'PANT-DEMO-02', styleName: 'Pantalone touring demo', dueDate: '2026-11-19', pieces: 12 },
]

const found = (n: number, lot: { id: string; code: string }, shade: string | null, left: string, running: string, proposed: boolean, over: Partial<FindAnswer['outOfShade'][number]> = {}) => ({
  hideId: uid('8282', 100 + n),
  hideCode: tag(100 + n),
  lotId: lot.id,
  lotCode: lot.code,
  shadeGroupId: shade ? uid('5454', shade.charCodeAt(0)) : null,
  shadeLabel: shade,
  outOfShade: false,
  grade: 'A',
  state: 'FULL',
  left,
  running,
  proposed,
  locationCodes: [LOCATIONS.binA1.code],
  remnant: null,
  ...over,
})
export const FIND_ANSWER: FindAnswer = {
  site: { id: SITE.id },
  item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name, baseUom: 'FT2' },
  colour: COLOURS.black,
  workOrder: { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, planned: '210.0000', issued: '42.0000', reserved: '0.0000' },
  leathers: [{ itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id }],
  need: { baseArea: '168.0000', source: 'WORK_ORDER' },
  rule: 'ORDER',
  ordersShadeLots: [{ lotCode: LOTS.nappa.code, shadeLabel: '3' }],
  lots: [
    {
      key: `${LOTS.nappa.id}|3`,
      lotId: LOTS.nappa.id,
      lotCode: LOTS.nappa.code,
      shadeGroupId: uid('5454', '3'.charCodeAt(0)),
      shadeLabel: '3',
      count: 4,
      total: '205.6000',
      covers: true,
      ordersOwn: true,
      shadeWarning: false,
      hides: [found(1, LOTS.nappa, '3', '54.2000', '54.2000', true), found(2, LOTS.nappa, '3', '52.8000', '107.0000', true), found(3, LOTS.nappa, '3', '51.0000', '158.0000', true), found(4, LOTS.nappa, '3', '47.6000', '205.6000', true, { grade: 'B', remnant: null })],
    },
    {
      key: `${LOTS.nappaQuarantine.id}|2`,
      lotId: LOTS.nappaQuarantine.id,
      lotCode: LOTS.nappaQuarantine.code,
      shadeGroupId: uid('5454', '2'.charCodeAt(0)),
      shadeLabel: '2',
      count: 2,
      total: '101.3000',
      covers: false,
      ordersOwn: false,
      shadeWarning: true,
      hides: [found(5, LOTS.nappaQuarantine, '2', '50.9000', '50.9000', false), found(6, LOTS.nappaQuarantine, '2', '50.4000', '101.3000', false, { grade: 'B' })],
    },
  ],
  outOfShade: [found(7, LOTS.nappa, 'Fuori tonalità', '12.0000', '12.0000', false, { outOfShade: true, state: 'REMNANT', remnant: { id: uid('8383', 1), code: 'RM-DM-00010A-K' } })],
  proposal: { lotKey: `${LOTS.nappa.id}|3`, hideIds: [uid('8282', 101), uid('8282', 102), uid('8282', 103), uid('8282', 104)], count: 4, area: '205.6000', covers: true },
}

export function findModel(over: Partial<FindDialogModel> = {}): FindDialogModel {
  return {
    siteId: SITE.id,
    sites: [SITE],
    draft: { ...emptyDraft('workOrder'), workOrderId: WORK_ORDERS.a.id },
    articles: { value: ARTICLES, problem: null },
    grades: { value: Object.values(GRADES), problem: null },
    workOrderQuery: '',
    workOrders: { value: OPEN_WORK_ORDERS, problem: null },
    result: { value: FIND_ANSWER, problem: null },
    chosen: proposedIds(FIND_ANSWER),
    note: '',
    overrideReason: '',
    can: { reserve: true, override: false, workOrders: true, grades: true },
    posting: false,
    problem: null,
    done: null,
    ...over,
  }
}

// ---- Move N hides ----------------------------------------------------------------------------------------------------------

const MOVABLE = [HIDE_ROWS[1]!, HIDE_ROWS[5]!, HIDE_ROWS[2]!]
export function moveModel(over: Partial<MoveDialogModel> = {}): MoveDialogModel {
  return { siteId: SITE.id, hides: moveHides(MOVABLE), places: { value: [LOCATIONS.binA1, LOCATIONS.binA2, LOCATIONS.cutting, LOCATIONS.quarantine], problem: null }, toLocationId: null, note: '', posting: false, results: null, problem: null, ...over }
}
export const MOVE_TO = LOCATIONS.binA1.id
export const MOVABLE_IDS = MOVABLE.map((row) => row.id)

// ---- remnant pieces ----------------------------------------------------------------------------------------------------------

const remnant = (n: number, area: string, over: Partial<RemnantRow> = {}): RemnantRow => ({
  id: uid('8383', n),
  code: `RM-DM-0001${n}A-K`,
  state: 'IN_STOCK',
  area: { uom: 'FT2', quantity: area, other: { uom: 'M2', quantity: (Number(area) * 0.09290304).toFixed(4) } },
  baseArea: area,
  baseUom: 'FT2',
  grade: 'A',
  hide: { id: uid('8282', 3), code: tag(3), state: 'REMNANT' },
  lot: { id: LOTS.nappa.id, code: LOTS.nappa.code, dyeBatch: 'TB-7781' },
  item: { id: ITEMS.leather.id, code: ITEMS.leather.code, name: ITEMS.leather.name },
  colour: { code: COLOURS.black.code, name: COLOURS.black.name },
  shade: '3',
  outOfShade: false,
  location: { id: LOCATIONS.cutting.id, code: LOCATIONS.cutting.code, name: LOCATIONS.cutting.name },
  move: { id: uid('8484', n), reason: 'REMNANT', workOrderNumber: WORK_ORDERS.a.number, occurredAt: at(29, 11, 20) },
  note: null,
  createdAt: at(29, 11, 20),
  ...over,
})
export const REMNANT_ROWS: RemnantRow[] = [remnant(1, '8.2000'), remnant(2, '6.1000', { grade: 'B', location: { id: LOCATIONS.binA2.id, code: LOCATIONS.binA2.code, name: LOCATIONS.binA2.name } }), remnant(3, '4.1000', { shade: 'Fuori tonalità', outOfShade: true, move: { id: uid('8484', 3), reason: 'RETURN', workOrderNumber: null, occurredAt: at(20, 9) } })]
export const REMNANT_TOTALS: RemnantsPage['totals'] = [{ uom: 'FT2', pieces: 3, area: '18.4000' }, { uom: 'M2', pieces: 1, area: '0.4000' }]
export const REMNANT_MINIMUM: RemnantsPage['minimum'] = { area: '0.1000', uom: 'M2', setting: false }
export const REMNANT_RECORD: RemnantRecord = {
  remnant: REMNANT_ROWS[0]!,
  minimum: { baseArea: '1.0764', setting: false },
  history: [
    { at: at(29, 11, 20), action: 'TAGGED', from: null, to: 'IN_STOCK', by: null, audience: 'FLOOR' },
    { at: at(29, 15, 5), action: 'MOVED', from: LOCATIONS.binA2.code, to: LOCATIONS.cutting.code, by: 'Anna Esempio', audience: 'OFFICE' },
  ],
}
export function remnantsModel(over: Partial<RemnantsListModel> = {}): RemnantsListModel {
  return { prefix: '/w/DEMO', timeZone: 'Europe/Rome', rows: { items: REMNANT_ROWS, more: false, problem: null }, totals: REMNANT_TOTALS, minimum: REMNANT_MINIMUM, open: null, ...over }
}
