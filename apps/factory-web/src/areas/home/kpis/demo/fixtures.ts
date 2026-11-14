import { createElement, type ReactNode } from 'react'
import { measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import { grainsOfKpi, permissionsOfKpi, type KpiFile } from '@nexus/factory-domain/insights/kpis/catalogue'
import { KPI_CATALOGUE } from '@nexus/factory-domain/insights/kpis/registry'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { DrillAnswer, KpiCalculation, KpiItem, KpiLibrary, KpiPeriod, KpiRecord, KpiUse, KpiValue, KpiVersion, OfficeRole, PeriodKind } from '../api'

/**
 * Made-up data for the design cases of Home › Insights › KPI library (SCR-249 the library, SCR-470 a KPI, SCR-471 the records
 * behind it): the standard KPIs of the metric layer with their own standard words (the product's, factory-domain
 * insights/kpis/defs), and invented values, versions, people ("Demo Owner", "Demo Planner"), customers ("Pista Demo Srl"),
 * orders ("SO-DEMO-0101") and figures worked out by hand. Nothing here is a real company, person or number. Design-only (only
 * fixtures import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
const AS_OF = '2026-11-14T09:05:00.000Z'
export const NOW = Date.parse('2026-11-14T09:20:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'home.kpis.view', 'home.kpis.manage', 'roles.view', 'home.reports.view', 'orders.view', 'production.reports.view'],
  planner: ['home.view', 'home.kpis.view', 'home.reports.view', 'orders.view', 'workorders.view', 'planning.view', 'production.reports.view', 'purchasing.view'],
  none: ['home.view'],
} as const
export type Role = keyof typeof ROLES

/** The office pages a design case links (every page of the library is built). */
export const BUILT: ReadonlySet<string> = new Set(['/home/today', '/home/reports', '/home/reports/[key]', '/home/alerts', '/home/kpis', '/home/kpis/[key]', '/home/kpis/[key]/records', '/sales/orders', '/sales/quotes', '/warehouse/shipments', '/production/work-orders', '/production/reports', '/production/cutting', '/warehouse/hides', '/warehouse/receipts', '/purchasing/orders', '/finance/margins'])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- periods ----------------------------------------------------------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
const iso = (date: Date) => date.toISOString().slice(0, 10)
const plus = (day: string, days: number) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000))

/** Twelve periods ending with the one of 14/11/2026 (made-up "today"). */
function periodsOf(kind: PeriodKind): KpiPeriod[] {
  const out: KpiPeriod[] = []
  for (let back = 11; back >= 0; back -= 1) {
    if (kind === 'DAY') {
      const day = plus('2026-11-14', -back)
      out.push({ kind, key: day, from: day, to: day })
    } else if (kind === 'WEEK') {
      const monday = plus('2026-11-09', -7 * back)
      out.push({ kind, key: `2026-W${pad(46 - back)}`, from: monday, to: plus(monday, 6) })
    } else {
      const month = 11 - back
      const year = month < 1 ? 2025 : 2026
      const m = month < 1 ? month + 12 : month
      const from = `${year}-${pad(m)}-01`
      const next = m === 12 ? `${year + 1}-01-01` : `${year}-${pad(m + 1)}-01`
      out.push({ kind: 'MONTH', key: `${year}-${pad(m)}`, from, to: plus(next, -1) })
    }
  }
  return out
}

// ---- values (made up, worked out by hand: a base and a small wave) -----------------------------------------------------------

const WAVE = [0.6, -0.4, 0.9, 0.2, -0.8, 0.5, -0.2, 0.7, -0.6, 0.3, 0.1, 0]

const SERIES: Readonly<Record<string, { base: number; swing: number; decimals: number }>> = {
  'delivery.order_to_ship_days': { base: 7.4, swing: 1.5, decimals: 1 },
  'delivery.otif': { base: 88.4, swing: 4, decimals: 1 },
  'delivery.otif_current': { base: 93.1, swing: 3, decimals: 1 },
  'delivery.shipped_on_time': { base: 91.7, swing: 3.5, decimals: 1 },
  'production.leather_yield': { base: 71.6, swing: 2, decimals: 1 },
  'production.order_to_start_days': { base: 3.2, swing: 0.9, decimals: 1 },
  'production.output': { base: 412, swing: 60, decimals: 0 },
  'production.scrap_rate': { base: 2.4, swing: 0.8, decimals: 1 },
  'production.wip_age_days': { base: 4.6, swing: 1.1, decimals: 1 },
  'production.wip_pieces': { base: 1180, swing: 140, decimals: 0 },
  'production.wip_value': { base: 6_420_000, swing: 520_000, decimals: 0 },
  'purchasing.receipt_lines': { base: 38, swing: 9, decimals: 0 },
  'purchasing.supplier_on_time': { base: 84.2, swing: 5, decimals: 1 },
  'sales.margin_actual': { base: 36.8, swing: 2.4, decimals: 1 },
  'sales.margin_quoted': { base: 38.5, swing: 1.6, decimals: 1 },
  'sales.order_lines_in': { base: 64, swing: 14, decimals: 0 },
  'sales.order_margin': { base: 37.9, swing: 2, decimals: 1 },
  'sales.orders_in': { base: 4_860_000, swing: 900_000, decimals: 0 },
  'sales.quote_to_order_days': { base: 9.5, swing: 2.2, decimals: 1 },
}

const seriesOf = (key: string) => {
  const spec = SERIES[key] ?? { base: 10, swing: 2, decimals: 0 }
  return WAVE.map((wave) => (spec.base + wave * spec.swing).toFixed(spec.decimals))
}

/** A KPI's value in my scope: 12 periods, the last current; `problem` and `hide` make the cases without a value. */
export function valueOf(file: KpiFile | null, change: Omit<Partial<KpiValue>, 'period'> & { hide?: boolean; kind?: PeriodKind } = {}): KpiValue {
  const { hide, kind, ...rest } = change
  if (!file) return { period: null, value: null, currency: null, converted: [], asOf: null, stale: false, live: false, missingDays: 0, problem: 'NO_CALCULATION', periods: [], ...rest }
  const periods = periodsOf(kind ?? file.period)
  const values = seriesOf(file.key)
  const current = periods.at(-1)!
  return {
    period: { kind: current.kind, key: current.key, from: current.from, to: current.to },
    value: hide ? null : values.at(-1)!,
    currency: file.unit === 'MONEY' ? 'EUR' : null,
    converted: [],
    asOf: AS_OF,
    stale: false,
    live: false,
    missingDays: 0,
    problem: null,
    periods: periods.map((p, index) => ({ ...p, value: hide ? null : values[index]! })),
    ...rest,
  }
}

// ---- versions ---------------------------------------------------------------------------------------------------------------

const ROLE_IDS: Readonly<Record<string, string>> = { sales: uid('a001', 1), planner: uid('a001', 2), production_manager: uid('a001', 3), finance: uid('a001', 4), buyer: uid('a001', 5), warehouse: uid('a001', 6), owner: uid('a001', 7) }

function calculationOf(file: KpiFile): KpiCalculation {
  return {
    kind: file.calc.kind,
    measures: measuresOfCalc(file.calc),
    period: file.period,
    unit: file.unit,
    grain: file.grain,
    ownerRole: file.ownerRole,
    drill: file.drill
      ? file.drill.kind === 'REPORT'
        ? { kind: 'REPORT', key: file.drill.key, api: null, terms: { ...file.drill.filters } }
        : { kind: 'LIST', key: null, api: file.drill.api, terms: { ...file.drill.query } }
      : null,
  }
}

let next = 0
export function versionOf(file: KpiFile, kpiVersion: number, state: KpiVersion['state'], change: Partial<KpiVersion> = {}): KpiVersion {
  next += 1
  return {
    id: uid('b002', next),
    kpiVersion,
    state,
    ...file.words,
    sourceRecords: [...file.sourceRecords],
    measureKeys: measuresOfCalc(file.calc),
    owner: { roleId: ROLE_IDS[file.ownerRole] ?? uid('a001', 99), key: file.ownerRole, name: null },
    unit: file.unit,
    grain: file.grain,
    basedOnId: null,
    changeNote: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    createdBy: 'Demo Owner',
    activatedAt: state === 'DRAFT' ? null : '2026-09-01T08:00:00.000Z',
    activatedBy: state === 'DRAFT' ? null : 'Demo Owner',
    endedAt: null,
    endedBy: null,
    version: 1,
    ...change,
  }
}

export const fileOf = (key: string): KpiFile => KPI_CATALOGUE.find((file) => file.key === key)!

const NOT_INSTALLED = new Set(['production.leather_yield', 'sales.quote_to_order_days'])
const USES: Readonly<Record<string, number>> = { 'delivery.otif': 3, 'delivery.shipped_on_time': 1, 'production.output': 1, 'production.scrap_rate': 1, 'sales.orders_in': 1, 'sales.order_margin': 1 }

/** The OTIF history: v1 superseded, v2 in force, v3 a draft (a new customer rule). */
export const OTIF_VERSIONS: KpiVersion[] = (() => {
  const file = fileOf('delivery.otif')
  const v1 = versionOf(file, 1, 'SUPERSEDED', {
    nameEn: 'On-time delivery',
    nameIt: 'Consegne puntuali',
    definitionEn: 'The share of order lines shipped by the date first promised to the customer.',
    definitionIt: 'La quota delle righe d’ordine spedite entro la data promessa per prima al cliente.',
    createdAt: '2026-03-02T08:10:00.000Z',
    activatedAt: '2026-03-02T08:12:00.000Z',
    endedAt: '2026-09-14T07:40:00.000Z',
    endedBy: 'Demo Owner',
    version: 3,
  })
  const v2 = versionOf(file, 2, 'ACTIVE', { basedOnId: v1.id, changeNote: 'Only complete lines count as on time; fee lines left out.', createdAt: '2026-09-14T07:35:00.000Z', activatedAt: '2026-09-14T07:40:00.000Z', version: 2 })
  const v3 = versionOf(file, 3, 'DRAFT', {
    basedOnId: v2.id,
    changeNote: 'Say plainly that a line closed short counts by what is left.',
    definitionEn: `${file.words.definitionEn} A line closed short counts by the garments left to ship.`,
    definitionIt: `${file.words.definitionIt} Una riga chiusa in difetto conta per i capi rimasti da spedire.`,
    createdAt: '2026-11-12T15:20:00.000Z',
    createdBy: 'Demo Planner',
    activatedAt: null,
    activatedBy: null,
  })
  return [v3, v2, v1]
})()

function itemOf(file: KpiFile, role: Role): KpiItem {
  const calculation = calculationOf(file)
  const installed = !NOT_INSTALLED.has(file.key)
  // As the API reads it: a measure's list outside the role → NO_ACCESS; a money right the role lacks → NEEDS_GRAIN.
  // The owner holds every right (owner every()).
  const held = new Set<string>(ROLES[role])
  const value =
    role === 'owner'
      ? valueOf(file)
      : !permissionsOfKpi(file).every((permission) => held.has(permission))
        ? valueOf(file, { problem: 'NO_ACCESS', hide: true, asOf: null })
        : grainsOfKpi(file).length > 0
          ? valueOf(file, { problem: 'NEEDS_GRAIN', hide: true, asOf: null })
          : valueOf(file)
  if (file.key === 'delivery.otif') return { key: file.key, calculation, shown: OTIF_VERSIONS[1]!, inForce: { id: OTIF_VERSIONS[1]!.id, kpiVersion: 2 }, drafts: 1, measuresDiffer: false, standardWords: null, uses: USES[file.key] ?? 0, value }
  if (file.key === 'purchasing.supplier_on_time') {
    const draft = versionOf(file, 1, 'DRAFT')
    return { key: file.key, calculation, shown: draft, inForce: null, drafts: 1, measuresDiffer: false, standardWords: null, uses: 0, value }
  }
  if (file.key === 'sales.order_margin') {
    const v1 = versionOf(file, 1, 'ACTIVE', { measureKeys: ['orders.value', 'orders.margin'] })
    return { key: file.key, calculation, shown: v1, inForce: { id: v1.id, kpiVersion: 1 }, drafts: 0, measuresDiffer: true, standardWords: null, uses: USES[file.key] ?? 0, value }
  }
  if (!installed) return { key: file.key, calculation, shown: null, inForce: null, drafts: 0, measuresDiffer: false, standardWords: { ...file.words }, uses: 0, value }
  const v1 = versionOf(file, 1, 'ACTIVE')
  return { key: file.key, calculation, shown: v1, inForce: { id: v1.id, kpiVersion: 1 }, drafts: 0, measuresDiffer: false, standardWords: null, uses: USES[file.key] ?? 0, value }
}

/** A KPI the company had and withdrew, whose calculation is not in this version of the product (made up). */
const QUOTES_SENT: KpiItem = (() => {
  const retired: KpiVersion = {
    id: uid('b002', 900),
    kpiVersion: 1,
    state: 'RETIRED',
    nameIt: 'Preventivi inviati',
    nameEn: 'Quotes sent',
    definitionIt: 'Il numero di preventivi inviati ai clienti nel periodo.',
    definitionEn: 'The number of quotes sent to customers in the period.',
    formulaIt: 'conteggio dei preventivi inviati nel periodo',
    formulaEn: 'count of the quotes sent in the period',
    sourceRecords: ['Quote'],
    measureKeys: ['quotes.sent'],
    owner: { roleId: ROLE_IDS.sales!, key: 'sales', name: null },
    unit: 'COUNT',
    grain: null,
    basedOnId: null,
    changeNote: null,
    createdAt: '2026-02-02T09:00:00.000Z',
    createdBy: 'Demo Owner',
    activatedAt: '2026-02-02T09:01:00.000Z',
    activatedBy: 'Demo Owner',
    endedAt: '2026-10-20T10:30:00.000Z',
    endedBy: 'Demo Owner',
    version: 2,
  }
  return { key: 'sales.quotes_sent', calculation: null, shown: retired, inForce: null, drafts: 0, measuresDiffer: false, standardWords: null, uses: 0, value: valueOf(null) }
})()

export function libraryFor(role: Role): KpiLibrary {
  const items = KPI_CATALOGUE.map((file) => itemOf(file, role))
  return { asOf: AS_OF, kpis: [...items, QUOTES_SENT].sort((a, b) => a.key.localeCompare(b.key)) }
}

const itemFor = (key: string, role: Role = 'owner'): KpiItem => libraryFor(role).kpis.find((item) => item.key === key)!

/** A KPI's record: the item with its versions, where it is used and 12 periods. */
export function recordFor(key: string, role: Role = 'owner', change: Partial<KpiRecord> = {}): KpiRecord {
  const item = itemFor(key, role)
  const versions = key === 'delivery.otif' ? OTIF_VERSIONS : key === 'sales.quotes_sent' ? [QUOTES_SENT.shown!] : item.shown ? [item.shown] : []
  const usedIn: KpiUse[] =
    key === 'delivery.otif'
      ? [
          { usedIn: 'DASHBOARD', useKey: 'owner-group', since: '2026-09-14T07:40:00.000Z' },
          { usedIn: 'REPORT', useKey: 'sales.late-orders', since: '2026-09-14T07:40:00.000Z' },
          { usedIn: 'ALERT', useKey: 'ORDER_LATE_RISK', since: '2026-10-02T06:00:00.000Z' },
        ]
      : key === 'production.output'
        ? [{ usedIn: 'DASHBOARD', useKey: 'today', since: '2026-11-13T18:00:00.000Z' }]
        : []
  return { ...item, versions, usedIn, ...change }
}

/** Office roles a KPI may be owned by (made up; the owner holds roles.view). */
export const OFFICE_ROLES: OfficeRole[] = [
  { id: ROLE_IDS.owner!, key: 'owner', name: 'Owner', system: true, audience: 'office', archivedAt: null },
  { id: ROLE_IDS.sales!, key: 'sales', name: 'Sales', system: true, audience: 'office', archivedAt: null },
  { id: ROLE_IDS.planner!, key: 'planner', name: 'Planner', system: true, audience: 'office', archivedAt: null },
  { id: ROLE_IDS.production_manager!, key: 'production_manager', name: 'Production manager', system: true, audience: 'office', archivedAt: null },
  { id: ROLE_IDS.finance!, key: 'finance', name: 'Finance', system: true, audience: 'office', archivedAt: null },
  { id: uid('a001', 20), key: 'custom-delivery-desk', name: 'Delivery desk (demo)', system: false, audience: 'office', archivedAt: null },
]

// ---- the records behind a KPI (made-up rows) -----------------------------------------------------------------------------------

const ref = (block: string, n: number, code: string, name: string) => ({ id: uid(block, n), code, name })
const CUSTOMERS = [ref('c003', 1, 'C-DEMO-01', 'Pista Demo Srl'), ref('c003', 2, 'C-DEMO-02', 'Team Esempio'), ref('c003', 3, 'C-DEMO-03', 'Moto Prova Spa')]
const SITES = [ref('d004', 1, 'S1', 'Demo plant'), ref('d004', 2, 'S2', 'Demo workshop')]
const STYLES = [ref('e005', 1, 'ST-DEMO-10', 'Track jacket (demo)'), ref('e005', 2, 'ST-DEMO-20', 'Touring trousers (demo)'), ref('e005', 3, 'ST-DEMO-30', 'One-piece suit (demo)')]
const SEASON = ref('f006', 1, 'SS27', 'Spring/Summer 2027 (demo)')
const LINES = [ref('a007', 1, 'L1', 'Line 1'), ref('a007', 2, 'L2', 'Line 2')]
const SUPPLIERS = [ref('b008', 1, 'SUP-DEMO-1', 'Conceria Demo'), ref('b008', 2, 'SUP-DEMO-2', 'Tessuti Esempio')]
const record = (type: string, block: string, n: number, label: string) => ({ type, id: uid(block, n), label })

export const OTIF_DRILL: DrillAnswer = {
  name: 'otif',
  data: {
    kpiKey: 'delivery.otif',
    promise: 'FIRST',
    period: { from: '2026-11-01', to: '2026-11-14' },
    asOf: AS_OF,
    overall: { due: 6, onTime: 5, late: 1, pct: '83.3' },
    byCustomer: [
      { customer: CUSTOMERS[0]!, due: 3, onTime: 3, pct: '100.0' },
      { customer: CUSTOMERS[1]!, due: 2, onTime: 1, pct: '50.0' },
      { customer: CUSTOMERS[2]!, due: 1, onTime: 1, pct: '100.0' },
    ],
    bySite: [
      { site: SITES[0]!, due: 4, onTime: 3, pct: '75.0' },
      { site: SITES[1]!, due: 2, onTime: 2, pct: '100.0' },
    ],
    byMonth: [{ month: '2026-11', due: 6, onTime: 5, pct: '83.3' }],
    rows: [1, 2, 3, 4, 5, 6].map((n) => {
      const late = n === 4
      return {
        record: record('SalesOrder', 'a009', n, `SO-DEMO-01${pad(n)}`),
        lineId: uid('a010', n),
        seq: 10,
        order: { id: uid('a009', n), number: `SO-DEMO-01${pad(n)}` },
        customer: CUSTOMERS[n % 3]!,
        style: STYLES[n % 3]!,
        family: (['JACKET', 'TROUSERS', 'SUIT'] as const)[n % 3]!,
        site: SITES[n % 2]!,
        season: SEASON,
        priority: n === 2 ? ('HIGH' as const) : ('NORMAL' as const),
        due: 10 + n * 2,
        firstPromise: `2026-11-${pad(2 + n * 2)}`,
        currentPromise: `2026-11-${pad(2 + n * 2)}`,
        promise: `2026-11-${pad(2 + n * 2)}`,
        shippedByPromise: late ? 6 : 10 + n * 2,
        completeOn: late ? null : `2026-11-${pad(1 + n * 2)}`,
        outcome: late ? ('LATE' as const) : ('ON_TIME' as const),
        lateDays: late ? 4 : 0,
      }
    }),
    more: 0,
  },
}

export const LEAD_DRILL: DrillAnswer = {
  name: 'lead-times',
  data: {
    kpiKey: 'delivery.order_to_ship_days',
    kind: 'ORDER_TO_SHIP',
    period: { from: '2026-11-01', to: '2026-11-14' },
    asOf: AS_OF,
    overall: { orders: 4, medianDays: '7.0', p25Days: '6.0', p75Days: '9.0', spreadDays: '3.0', averageDays: '7.5', minDays: 5, maxDays: 11 },
    families: [
      { family: 'JACKET', orders: 3, medianDays: '7.0', p25Days: '6.0', p75Days: '8.0', spreadDays: '2.0', averageDays: '6.7', minDays: 5, maxDays: 8 },
      { family: 'SUIT', orders: 1, medianDays: '11.0', p25Days: '11.0', p75Days: '11.0', spreadDays: '0.0', averageDays: '11.0', minDays: 11, maxDays: 11 },
    ],
    rows: [5, 7, 8, 11].map((days, i) => ({
      record: record('SalesOrder', 'a011', i, `SO-DEMO-02${pad(i)}`),
      order: { id: uid('a011', i), number: `SO-DEMO-02${pad(i)}`, orderDate: `2026-10-${pad(20 + i)}` },
      customer: CUSTOMERS[i % 3]!,
      family: i === 3 ? ('SUIT' as const) : ('JACKET' as const),
      season: SEASON,
      priority: 'NORMAL' as const,
      fromDay: `2026-10-${pad(20 + i)}`,
      toDay: plus(`2026-10-${pad(20 + i)}`, days),
      days,
    })),
    more: 0,
  },
}

export function wipDrill(withValue: boolean): DrillAnswer {
  return {
    name: 'wip',
    data: {
      kpiKey: 'production.wip_pieces',
      asOf: AS_OF,
      overall: { workOrders: 3, pieces: 96, waiting: 41, value: withValue ? 1_284_500 : null, currency: withValue ? 'EUR' : null },
      stages: [
        { line: LINES[0]!, operation: { code: 'ASM', name: 'Assembly' }, workOrders: 2, waiting: 26, ageing: { D0_2: 10, D3_5: 12, D6_10: 4, D11_PLUS: 0 } },
        { line: LINES[1]!, operation: { code: 'FIN', name: 'Finishing' }, workOrders: 1, waiting: 15, ageing: { D0_2: 0, D3_5: 7, D6_10: 0, D11_PLUS: 8 } },
      ],
      rows: [
        { n: 1, line: LINES[0]!, age: 3, waited: 1, band: 'D3_5' as const, pieces: 40, value: 512_000 },
        { n: 2, line: LINES[0]!, age: 6, waited: 2, band: 'D6_10' as const, pieces: 32, value: 431_500 },
        { n: 3, line: LINES[1]!, age: 12, waited: 5, band: 'D11_PLUS' as const, pieces: 24, value: 341_000 },
      ].map((row) => ({
        record: record('WorkOrder', 'a012', row.n, `WO-DEMO-03${pad(row.n)}`),
        workOrder: { id: uid('a012', row.n), number: `WO-DEMO-03${pad(row.n)}`, status: 'IN_PROGRESS' },
        site: SITES[0]!,
        line: row.line,
        style: STYLES[row.n % 3]!,
        releasedOn: plus('2026-11-14', -row.age),
        week: '2026-W46',
        pieces: row.pieces,
        ageDays: row.age,
        waitedDays: row.waited,
        band: row.band,
        value: withValue ? row.value : null,
        currency: withValue ? 'EUR' : null,
        stages: [{ code: 'ASM', name: 'Assembly', waiting: Math.round(row.pieces / 2) }],
      })),
      more: 0,
    },
  }
}

export const LEATHER_DRILL: DrillAnswer = {
  name: 'leather-yield',
  data: {
    kpiKey: 'production.leather_yield',
    period: { from: '2026-11-01', to: '2026-11-14' },
    asOf: AS_OF,
    overall: { cutM2: '42.60', patternM2: '30.50', wasteM2: '12.10', yieldPct: '71.6', wastePct: '28.4', hides: 9 },
    byGrade: [
      { grade: 'A', cutM2: '28.40', patternM2: '21.30', wasteM2: '7.10', yieldPct: '75.0', wastePct: '25.0', hides: 6 },
      { grade: 'B', cutM2: '14.20', patternM2: '9.20', wasteM2: '5.00', yieldPct: '64.8', wastePct: '35.2', hides: 3 },
    ],
    byLot: [{ lot: { id: uid('a013', 1), code: 'LOT-DEMO-1', supplierLotRef: 'CD-77' }, supplier: SUPPLIERS[0]!, cutM2: '42.60', patternM2: '30.50', wasteM2: '12.10', yieldPct: '71.6', wastePct: '28.4', hides: 9 }],
    byStyle: [
      { style: STYLES[0]!, cutM2: '24.10', patternM2: '17.60', wasteM2: '6.50', yieldPct: '73.0', wastePct: '27.0', hides: 5 },
      { style: STYLES[2]!, cutM2: '18.50', patternM2: '12.90', wasteM2: '5.60', yieldPct: '69.7', wastePct: '30.3', hides: 4 },
    ],
    rows: [1, 2, 3].map((n) => ({
      record: record('Hide', 'a014', n, `H-DEMO-${pad(n, 3)}`),
      hide: { id: uid('a014', n), code: `H-DEMO-${pad(n, 3)}`, grade: n === 3 ? 'B' : 'A' },
      lot: { id: uid('a013', 1), code: 'LOT-DEMO-1', supplierLotRef: 'CD-77' },
      supplier: SUPPLIERS[0]!,
      site: SITES[0]!,
      workOrder: { id: uid('a012', n), number: `WO-DEMO-03${pad(n)}` },
      style: STYLES[n === 3 ? 2 : 0]!,
      lastCutOn: `2026-11-${pad(4 + n)}`,
      cutM2: n === 3 ? '4.70' : '4.80',
      patternM2: n === 3 ? '3.05' : '3.60',
      yieldPct: n === 3 ? '64.9' : '75.0',
    })),
    more: 0,
  },
}

export function marginDrill(withAmounts: boolean): DrillAnswer {
  const fig = (value: number, quotedCost: number, actualCost: number) => {
    const quotedMargin = value - quotedCost
    const actualMargin = value - actualCost
    const pct = (margin: number) => ((margin * 100) / value).toFixed(1)
    return {
      value: withAmounts ? value : null,
      quotedCost: withAmounts ? quotedCost : null,
      actualCost: withAmounts ? actualCost : null,
      quotedMargin: withAmounts ? quotedMargin : null,
      actualMargin: withAmounts ? actualMargin : null,
      quotedPct: pct(quotedMargin),
      actualPct: pct(actualMargin),
      changePts: (Number(pct(actualMargin)) - Number(pct(quotedMargin))).toFixed(1),
    }
  }
  return {
    name: 'margin',
    data: {
      kpiKey: 'sales.margin_actual',
      period: { from: '2026-11-01', to: '2026-11-14' },
      asOf: AS_OF,
      currency: 'EUR',
      converted: [],
      unconverted: 0,
      overall: { ...fig(2_400_000, 1_480_000, 1_516_000), garments: 30, orders: 2 },
      byCustomer: [
        { customer: CUSTOMERS[0]!, orders: 1, garments: 18, ...fig(1_440_000, 880_000, 900_000) },
        { customer: CUSTOMERS[1]!, orders: 1, garments: 12, ...fig(960_000, 600_000, 616_000) },
      ],
      byStyle: [
        { style: STYLES[0]!, garments: 18, ...fig(1_440_000, 880_000, 900_000) },
        { style: STYLES[2]!, garments: 12, ...fig(960_000, 600_000, 616_000) },
      ],
      rows: [
        { record: record('SalesOrder', 'a015', 1, 'SO-DEMO-0401'), order: { id: uid('a015', 1), number: 'SO-DEMO-0401' }, customer: CUSTOMERS[0]!, season: SEASON, lastShippedOn: '2026-11-06', garments: 18, ...fig(1_440_000, 880_000, 900_000) },
        { record: record('SalesOrder', 'a015', 2, 'SO-DEMO-0402'), order: { id: uid('a015', 2), number: 'SO-DEMO-0402' }, customer: CUSTOMERS[1]!, season: SEASON, lastShippedOn: '2026-11-11', garments: 12, ...fig(960_000, 600_000, 616_000) },
      ],
      more: 0,
    },
  }
}

export function supplyDrill(withParts: boolean): DrillAnswer {
  return {
    name: 'supply',
    data: {
      kpiKey: 'purchasing.supplier_on_time',
      period: { from: '2026-11-01', to: '2026-11-14' },
      asOf: AS_OF,
      overall: { received: 5, onTime: 4, late: 1, pct: '80.0' },
      bySupplier: [
        { supplier: SUPPLIERS[0]!, received: 3, onTime: 2, pct: '66.7', worstLateDays: 3 },
        { supplier: SUPPLIERS[1]!, received: 2, onTime: 2, pct: '100.0', worstLateDays: 0 },
      ],
      rows: [1, 2, 3, 4, 5].map((n) => ({
        record: record('GoodsReceipt', 'a016', n, `GR-DEMO-${pad(n, 3)}`),
        purchaseOrder: { id: uid('a017', n), number: `PO-DEMO-05${pad(n)}` },
        seq: 10,
        receipt: { id: uid('a016', n), number: `GR-DEMO-${pad(n, 3)}` },
        supplier: SUPPLIERS[n <= 3 ? 0 : 1]!,
        item: ref('a018', n, `ART-DEMO-${n}`, n <= 3 ? 'Cowhide 1.2 mm (demo)' : 'Mesh lining (demo)'),
        category: n <= 3 ? ('LEATHER' as const) : ('LINING' as const),
        site: SITES[0]!,
        due: `2026-11-${pad(2 + n)}`,
        postedOn: n === 2 ? `2026-11-${pad(5 + n)}` : `2026-11-${pad(2 + n)}`,
        onTime: n !== 2,
        lateDays: n === 2 ? 3 : 0,
      })),
      more: 0,
      shortages: withParts
        ? { workOrders: [{ record: record('WorkOrder', 'a012', 2, 'WO-DEMO-0302'), workOrder: { id: uid('a012', 2), number: 'WO-DEMO-0302', status: 'RELEASED' }, site: SITES[0]!, style: STYLES[1]!, shortages: 2, materials: ['ART-DEMO-1', 'ART-DEMO-4'], neededBy: '2026-11-18' }], materials: 2, more: 0 }
        : null,
      cover: withParts
        ? { windowDays: 30, rows: [{ site: SITES[0]!, item: ref('a018', 1, 'ART-DEMO-1', 'Cowhide 1.2 mm (demo)'), colour: ref('a019', 1, 'BLK', 'Black'), uom: 'm²', onHand: '64.00', hides: 14, usedInWindow: '96.00', perDay: '3.20', coverDays: '20.0', oldestLotDays: 41 }] }
        : null,
    },
  }
}
