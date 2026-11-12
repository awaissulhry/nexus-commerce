import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, rolePermissions } from '../../../shell/design-data'
import { scopeOf } from '../../../shell/scope/scope-model'
import { inShell, PREFIX, uid } from '../../quality/_shared/fixtures'
import type { Ageing, AgeingArticle, AgeingType, BucketFigures, Leather, LeatherFigures, LeatherLot, UnitQuantity } from './api'
import { reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'

/**
 * SCR-257 — Warehouse reports with made-up articles, lots, tanneries and figures only ("Demo" names, DEMO- codes, invented
 * numbers): the report of the month with values (the cost grain), the warehouse without values (the share of quantity), all
 * sites, each panel's states (loading as skeletons, one panel failed while the other stands, nothing in stock, nothing moved),
 * a type over two units (left out of the share chart, said), a lot that does not add up, Arrange, the keys, offline, the stock
 * not in the role, no right.
 */

const COMPANY = { id: DEMO_COMPANIES[0].id, code: 'DEMO', name: DEMO_COMPANIES[0].name }
const SITE = { id: DEMO_SITES[0].id, code: 'DN', name: DEMO_SITES[0].name }
const SITE_S = { id: DEMO_SITES[1].id, code: 'DS', name: DEMO_SITES[1].name }
const FROM = '2026-11-01'
const TO = '2026-11-12'
export const NOW = '2026-11-12T07:42:00.000Z'
const head = { company: COMPANY, site: SITE, sites: [SITE], from: FROM, to: TO, today: TO, asOf: NOW }
const SCOPE_ONE = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: SITE.id })
const SCOPE_ALL = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: null })

const q = (uom: UnitQuantity['uom'], quantity: number): UnitQuantity => ({ uom, quantity: quantity.toFixed(4) })
const bucket = (quantities: UnitQuantity[], value: number, share: string | null): BucketFigures => ({ quantities, value, share })
const NONE = (share: string | null = '0.0'): BucketFigures => bucket([], 0, share)

function figures(uom: UnitQuantity['uom'], parts: [number, number, number, number], values: [number, number, number, number], averageDays: string, oldestDays: number, keys: number) {
  const whole = parts.reduce((sum, part) => sum + part, 0)
  const share = (part: number) => (whole > 0 ? ((part / whole) * 100).toFixed(1) : null)
  const at = (index: 0 | 1 | 2 | 3) => (parts[index] > 0 ? bucket([q(uom, parts[index])], values[index], share(parts[index])) : NONE(share(0)))
  return {
    buckets: { d0to90: at(0), d91to180: at(1), d181to365: at(2), overYear: at(3) },
    undated: [],
    whole: { quantities: [q(uom, whole)], value: values.reduce((sum, part) => sum + part, 0) },
    currency: 'EUR',
    mixedCurrencies: false,
    unvalued: 0,
    averageDays,
    oldestDays,
    keys,
  }
}

const article = (n: number, code: string, name: string, colour: string | null, tracked: boolean, body: ReturnType<typeof figures>): AgeingArticle => ({
  item: { id: uid('7561', n), code, name },
  colour: colour ? { id: uid('7562', n), code: colour.slice(0, 3).toUpperCase(), name: colour } : null,
  tracked,
  ...body,
})

const TYPES: AgeingType[] = [
  {
    type: 'LEATHER',
    ...figures('M2', [412.6, 96.3, 41.8, 18.2], [1_798_200, 431_400, 187_100, 79_900], '74.3', 402, 38),
    articles: [
      article(1, 'DEMO-LEA-100', 'Pelle bovina pieno fiore 1,2 mm', 'Nero', true, figures('M2', [286.4, 52.1, 30.5, 18.2], [1_261_500, 229_200, 134_200, 79_900], '81.0', 402, 24)),
      article(2, 'DEMO-LEA-110', 'Pelle bovina stampata 1,4 mm', 'Testa di moro', true, figures('M2', [126.2, 44.2, 11.3, 0], [536_700, 202_200, 52_900, 0], '58.2', 241, 14)),
    ],
    more: 0,
  },
  {
    type: 'LINING',
    ...figures('M', [640, 220, 85, 120], [198_400, 68_200, 26_400, 37_200], '131.6', 478, 9),
    articles: [
      article(3, 'DEMO-LIN-200', 'Fodera in rete 3D', 'Grigio', true, figures('M', [360, 120, 0, 120], [111_600, 37_200, 0, 37_200], '139.4', 478, 5)),
      article(4, 'DEMO-LIN-W36', 'Fodera termica', 'Nero', true, figures('M', [280, 100, 85, 0], [86_800, 31_000, 26_400, 0], '121.7', 260, 4)),
    ],
    more: 0,
  },
  {
    type: 'PROTECTOR',
    ...figures('PCS', [340, 120, 0, 60], [1_360_000, 480_000, 0, 240_000], '96.8', 520, 6),
    articles: [article(5, 'DEMO-PRT-SH', 'Protezione spalla EN 1621-1', null, true, figures('PCS', [340, 120, 0, 60], [1_360_000, 480_000, 0, 240_000], '96.8', 520, 6))],
    more: 0,
  },
  {
    type: 'TRIM',
    ...figures('PCS', [1_200, 0, 400, 0], [48_000, 0, 16_000, 0], '62.5', 233, 2),
    articles: [article(6, 'DEMO-ZIP-08', 'Zip spirale n. 8', 'Nero', false, figures('PCS', [1_200, 0, 400, 0], [48_000, 0, 16_000, 0], '62.5', 233, 2))],
    more: 0,
  },
]

export const AGEING: Ageing = { ...head, sight: { stock: true, cost: true }, asAt: TO, types: TYPES, all: { value: 7_226_100, currency: 'EUR', mixedCurrencies: false, unvalued: 0 }, customerOwned: 1 }

/** The same figures as a reader without the cost grain gets them: no value field at all. */
const strip = <T extends { value?: number | null | undefined }>(row: T): T => {
  const copy = { ...row }
  delete copy.value
  return copy
}
export const noValues = (answer: Ageing): Ageing => ({
  ...answer,
  sight: { stock: true, cost: false },
  all: strip(answer.all),
  types: answer.types.map((type) => {
    const clean = <F extends Pick<AgeingType, 'buckets' | 'whole'>>(row: F): F => ({ ...row, whole: strip(row.whole), buckets: { d0to90: strip(row.buckets.d0to90), d91to180: strip(row.buckets.d91to180), d181to365: strip(row.buckets.d181to365), overYear: strip(row.buckets.overYear) } })
    return { ...clean(type), articles: type.articles.map(clean) }
  }),
})

/** A type over two units: no share and no average (the chart leaves it out and says so). */
const MIXED: Ageing = {
  ...AGEING,
  types: [
    ...AGEING.types,
    {
      type: 'THREAD',
      ...figures('CONE', [40, 0, 12, 0], [12_000, 0, 3_600, 0], '0', 210, 3),
      whole: { quantities: [q('CONE', 52), q('M', 5_000)], value: 18_100 },
      buckets: { d0to90: bucket([q('CONE', 40), q('M', 5_000)], 14_500, null), d91to180: NONE(null), d181to365: bucket([q('CONE', 12)], 3_600, null), overYear: NONE(null) },
      averageDays: null,
      articles: [],
      more: 0,
    },
  ],
}

const lf = (uom: 'M2', v: { start: number; received: number; issued: number; returned: number; remnant: number; scrapped: number; other: number }, values: { start: number; received: number; cut: number; scrapped: number; end: number }, hides: [number, number], addsUp = true): LeatherFigures => {
  const cut = v.issued - v.returned - v.remnant
  const end = v.start + v.received - cut - v.scrapped + v.other
  const text = (value: number) => value.toFixed(4)
  const quantities = { start: text(v.start), received: text(v.received), issued: text(v.issued), returned: text(v.returned), remnant: text(v.remnant), cut: text(cut), scrapped: text(v.scrapped), other: text(v.other), end: text(addsUp ? end : end + 1.5) }
  return { uom, base: quantities, m2: quantities, addsUp, hidesReceived: hides[0], hidesOnHand: hides[1], values, currency: 'EUR' }
}

const TANNERY_A = { id: uid('7563', 1), code: 'DEMO-S1', name: 'Conceria Demo Srl' }
const TANNERY_B = { id: uid('7563', 2), code: 'DEMO-S2', name: 'Pelli Esempio Spa' }
const lot = (n: number, code: string, supplierLotRef: string, supplier: typeof TANNERY_A, children: number, figuresOf: LeatherFigures, dyeBatch: string | null = null): LeatherLot => ({ lot: { id: uid('7564', n), code }, supplier, supplierLotRef, dyeBatch, children, figures: figuresOf })

const LOT_1 = lf('M2', { start: 120.4, received: 0, issued: 64.2, returned: 4.1, remnant: 6.3, scrapped: 1.2, other: 0 }, { start: 52_900, received: 0, cut: 23_600, scrapped: 500, end: 28_800 }, [0, 14])
const LOT_2 = lf('M2', { start: 0, received: 186.5, issued: 42.0, returned: 0, remnant: 3.8, scrapped: 0, other: 0.6 }, { start: 0, received: 820_600, cut: 168_100, scrapped: 0, end: 652_500 }, [36, 31])
const LOT_3 = lf('M2', { start: 96.2, received: 0, issued: 38.6, returned: 2.0, remnant: 4.4, scrapped: 2.8, other: 0 }, { start: 410_900, received: 0, cut: 137_500, scrapped: 12_000, end: 261_400 }, [0, 12])
const add = (a: LeatherFigures, b: LeatherFigures): LeatherFigures => {
  const sum = (key: keyof NonNullable<LeatherFigures['m2']>) => (Number(a.m2![key]) + Number(b.m2![key])).toFixed(4)
  const m2 = { start: sum('start'), received: sum('received'), issued: sum('issued'), returned: sum('returned'), remnant: sum('remnant'), cut: sum('cut'), scrapped: sum('scrapped'), other: sum('other'), end: sum('end') }
  const v = (key: keyof LeatherFigures['values']) => (a.values[key] ?? 0) + (b.values[key] ?? 0)
  return { uom: 'M2', base: m2, m2, addsUp: a.addsUp && b.addsUp, hidesReceived: a.hidesReceived + b.hidesReceived, hidesOnHand: a.hidesOnHand + b.hidesOnHand, values: { start: v('start'), received: v('received'), cut: v('cut'), scrapped: v('scrapped'), end: v('end') }, currency: 'EUR' }
}
const BLACK = add(LOT_1, LOT_2)
export const LEATHER: Leather = {
  ...head,
  sight: { stock: true, cost: true },
  articles: [
    { item: { id: uid('7561', 1), code: 'DEMO-LEA-100', name: 'Pelle bovina pieno fiore 1,2 mm' }, colour: { id: uid('7562', 1), code: 'NER', name: 'Nero' }, figures: BLACK, lots: [lot(1, 'LOT-DEMO-0007', 'TAN-4471', TANNERY_A, 2, LOT_1, 'DB-118'), lot(2, 'LOT-DEMO-0012', 'TAN-4502', TANNERY_A, 0, LOT_2, 'DB-121')] },
    { item: { id: uid('7561', 2), code: 'DEMO-LEA-110', name: 'Pelle bovina stampata 1,4 mm' }, colour: { id: uid('7562', 2), code: 'TES', name: 'Testa di moro' }, figures: LOT_3, lots: [lot(3, 'LOT-DEMO-0009', 'PE-88-2026', TANNERY_B, 0, LOT_3)] },
  ],
  all: add(BLACK, LOT_3),
  more: 0,
  unvaluedMoves: 0,
}
export const leatherNoValues = (answer: Leather): Leather => {
  const clean = (row: LeatherFigures): LeatherFigures => ({ ...row, values: {} })
  return { ...answer, sight: { stock: true, cost: false }, all: clean(answer.all), articles: answer.articles.map((row) => ({ ...row, figures: clean(row.figures), lots: row.lots.map((one) => ({ ...one, figures: clean(one.figures) })) })) }
}
const LOT_3_OFF = lf('M2', { start: 96.2, received: 0, issued: 38.6, returned: 2.0, remnant: 4.4, scrapped: 2.8, other: 0 }, { start: 410_900, received: 0, cut: 137_500, scrapped: 12_000, end: 261_400 }, [0, 12], false)
const NOT_ADDING: Leather = { ...LEATHER, articles: [{ ...LEATHER.articles[1]!, figures: LOT_3_OFF, lots: [lot(3, 'LOT-DEMO-0009', 'PE-88-2026', TANNERY_B, 0, LOT_3_OFF)] }] }

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.read' })

export const OWNER = [...rolePermissions('owner'), 'inventory.reports.view', 'inventory.stock.view', 'money.cost']
export const WAREHOUSE = rolePermissions('warehouse')
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, permissions: readonly string[] = OWNER, search = ''): ReportsModel {
  return {
    prefix: PREFIX,
    can: reportsCan(permissions),
    address: reportsAddressOf(new URLSearchParams(search)),
    scope: SCOPE_ONE,
    range: { from: FROM, to: TO },
    today: TO,
    ageing: ready(AGEING),
    leather: ready(LEATHER),
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    series: 'value',
    measure: 'received',
    ...over,
  }
}

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/warehouse/reports', createElement(ReportsView, { model: value }), 'warehouse')
}

const halfLayout = { order: ['ageing', 'leather'], widths: { ageing: 'half' as const, leather: 'half' as const } }

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-257',
  title: 'Warehouse reports (Warehouse)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'The month with values (cost grain)', model: model(), note: 'Stock ageing by material type (value series, average age), the articles of a type, leather use by article and supplier lot adding up.' },
    { id: 'warehouse', label: 'Warehouse (no cost grain)', model: model({ series: 'share', ageing: ready(noValues(AGEING)), leather: ready(leatherNoValues(LEATHER)) }, WAREHOUSE), note: 'The share of each type\'s quantity; no value anywhere.' },
    { id: 'all-sites', label: 'All sites', model: model({ scope: SCOPE_ALL, ageing: ready({ ...AGEING, site: null, sites: [SITE, SITE_S] }), leather: ready({ ...LEATHER, site: null, sites: [SITE, SITE_S] }) }) },
    { id: 'last-month', label: 'Last month (the monthly review)', model: model({ range: { from: '2026-10-01', to: '2026-10-31' }, address: { from: '2026-10-01', to: '2026-10-31' }, ageing: ready({ ...AGEING, from: '2026-10-01', to: '2026-10-31', asAt: '2026-10-31' }), leather: ready({ ...LEATHER, from: '2026-10-01', to: '2026-10-31' }) }, OWNER, 'from=2026-10-01&to=2026-10-31') },
    { id: 'measure-on-hand', label: 'Leather bars: on hand', model: model({ measure: 'end' }) },
    { id: 'mixed-units', label: 'A type over two units', model: model({ series: 'share', ageing: ready(MIXED) }), note: 'Thread in cones and metres: no share or average, left out of the share chart and said.' },
    { id: 'not-adding', label: 'A lot that does not add up', model: model({ leather: ready(NOT_ADDING) }), note: 'A warning: start + received − cut − scrapped + other differs from the end.' },
    { id: 'loading', label: 'Loading (skeletons)', model: model({ ageing: loading(), leather: loading(), asOf: null }) },
    { id: 'error', label: 'One panel failed, the other stands', model: model({ leather: failed() }), note: 'The panel says what failed and Try again.' },
    { id: 'empty', label: 'Nothing in stock, nothing moved', model: model({ ageing: ready({ ...AGEING, types: [], all: { value: 0, currency: null, mixedCurrencies: false, unvalued: 0 }, customerOwned: 0 }), leather: ready({ ...LEATHER, articles: [] }) }) },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'half-widths', label: 'Panels at half width', model: model({ layout: halfLayout }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'stock-not-in-role', label: 'The page without the stock', model: model({ ageing: ready({ ...AGEING, sight: { stock: false, cost: false }, sites: [], types: [], customerOwned: 0 }), leather: ready({ ...LEATHER, sight: { stock: false, cost: false }, sites: [], articles: [] }) }, ['home.view', 'inventory.reports.view']), note: 'Each panel says the stock is not in the role.' },
    { id: 'no-permission', label: 'No right (sales)', model: model({}, rolePermissions('sales')) },
  ],
})
