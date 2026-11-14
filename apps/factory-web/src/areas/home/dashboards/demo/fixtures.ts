import { createElement, type ReactNode } from 'react'
import { BOARDS, boardOf, chooseNumbers, defaultLayout, type DashboardKey } from '@nexus/factory-domain/insights/dashboards/boards'
import { measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import { grainsOfKpi, permissionsOfKpi } from '@nexus/factory-domain/insights/kpis/catalogue'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { isWindowPage, OFFICE_PAGES, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { BoardPanel, Boards, ByCompany, DashLayout, DashNumber, DashPeriod, LayoutPanel, NeedsAction, Numbers, Trends, Wip } from '../api'
import { dashboardsCanOf, DEFAULT_ADDRESS, type DashboardAddress } from '../model'
import type { DashboardsModel, Read } from '../view/types'

/**
 * Made-up data for the design cases of Home › Insights › Dashboards (SCR-031 the role dashboards, SCR-103 the Owner's group view,
 * SCR-490 Present): two invented companies ("Officina Demo S.r.l.", "Pelletteria Esempio S.p.A."), invented sites, invented
 * values worked out by hand for the KPIs of the metric layer (their own standard words, factory-domain insights/kpis/defs), and
 * invented stages. Nothing here is a real company, person or number. Design-only (only fixtures import it); it exports no
 * `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const NOW = Date.parse('2026-11-14T09:20:00.000Z')
const AS_OF = '2026-11-14T09:05:00.000Z'
/** A rebuild over 3 hours before NOW (a stale number). */
export const OLD_AS_OF = '2026-11-14T04:40:00.000Z'

export type Role = 'owner' | 'planner' | 'production_manager' | 'sales' | 'buyer' | 'quality_inspector' | 'finance' | 'floor_supervisor' | 'admin'

/** The navigation and grains a design role holds (the system template's, as the product ships them). */
const permissionsOf = (role: Role): string[] => [...rolePermissions(role === 'admin' ? 'admin' : role), ...(role === 'admin' ? [] : ['home.kpis.view'])]
const GRAINS: Record<Role, readonly string[]> = { owner: ['price', 'cost', 'margin'], planner: [], production_manager: [], sales: ['price', 'margin'], buyer: ['cost'], quality_inspector: [], finance: ['price', 'cost', 'margin'], floor_supervisor: [], admin: [] }

const COMPANY_A = { ...DEMO_COMPANIES[0]!, sites: [{ id: '0190f0e2-2222-7000-8000-000000000001', code: 'NORD', name: 'Stabilimento Demo Nord' }, { id: '0190f0e2-2222-7000-8000-000000000002', code: 'SUD', name: 'Magazzino Demo Sud' }] }
const COMPANY_B = { ...DEMO_COMPANIES[1]!, sites: [{ id: '0190f0e2-2222-7000-8000-000000000003', code: 'EST', name: 'Laboratorio Esempio Est' }] }
export const COMPANIES = [COMPANY_A, COMPANY_B]

/** The Office shell around a page at this address (the role's navigation); a window page in its window frame. */
export function inShell(path: string, page: ReactNode, role: Role = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissionsOf(role))),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- who may read what (the product's own rules, over the role's template) --------------------------------------------------

const mayRead = (role: Role) => (kpiKey: string): boolean => {
  const file = kpiFileOf(kpiKey)
  if (!file) return false
  const held = new Set(permissionsOf(role))
  return permissionsOfKpi(file).every((permission) => held.has(permission)) && grainsOfKpi(file).every((grain) => GRAINS[role].includes(grain))
}

const ROLE_BOARD: Record<Role, DashboardKey | null> = { owner: 'owner-group', planner: 'planner', production_manager: 'plant-manager', sales: 'sales', buyer: 'buyer', quality_inspector: 'quality', finance: 'finance', floor_supervisor: 'line-leader', admin: null }

function boardsFor(role: Role): Boards {
  const can = mayRead(role)
  const mine = ROLE_BOARD[role]
  const order = [...BOARDS.filter((entry) => entry.key === mine), ...BOARDS.filter((entry) => entry.key !== mine)]
  return {
    asOf: AS_OF,
    boards: order.map((entry) => ({
      key: entry.key,
      mine: entry.key === mine,
      panels: entry.panels
        .map((spec) => spec.id)
        .filter((panel): panel is BoardPanel => panel === 'numbers' || panel === 'needs-action' || (panel === 'trends' && can('delivery.shipped_on_time')) || (panel === 'wip' && can('production.wip_pieces')) || (panel === 'by-company' && entry.group)),
    })),
    companies: COMPANIES.map((company) => ({ id: company.id, code: company.code, name: company.name, sites: company.sites.map((site) => ({ ...site })) })),
  }
}

// ---- periods and values ---------------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (date: Date) => date.toISOString().slice(0, 10)
const plus = (day: string, days: number) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000))

function periods(kind: 'WEEK' | 'MONTH' | 'QUARTER'): DashPeriod[] {
  const out: DashPeriod[] = []
  for (let back = 11; back >= 0; back -= 1) {
    if (kind === 'WEEK') {
      const monday = plus('2026-11-09', -7 * back)
      out.push({ kind, key: `2026-W${pad(46 - back)}`, from: monday, to: plus(monday, 6) })
    } else if (kind === 'MONTH') {
      const month = 11 - back
      const year = month < 1 ? 2025 : 2026
      const m = month < 1 ? month + 12 : month
      out.push({ kind, key: `${year}-${pad(m)}`, from: `${year}-${pad(m)}-01`, to: plus(`${m === 12 ? year + 1 : year}-${pad(m === 12 ? 1 : m + 1)}-01`, -1) })
    } else {
      const index = 4 * 2026 + 3 - back
      const year = Math.floor(index / 4)
      const quarter = (index % 4) + 1
      out.push({ kind, key: `${year}-Q${quarter}`, from: `${year}-${pad(quarter * 3 - 2)}-01`, to: plus(`${quarter === 4 ? year + 1 : year}-${pad(quarter === 4 ? 1 : quarter * 3 + 1)}-01`, -1) })
    }
  }
  return out
}

/** Made-up readings per KPI: 12 values (oldest first), in the API's terms (minor units for money, a percent `93.5`). */
const SERIES: Record<string, readonly (string | null)[]> = {
  'sales.orders_in': ['3810000', '4120000', '3975000', '4402000', '4210000', '3890000', '4560000', '4720000', '4390000', '4980000', '5120000', '2860000'],
  'delivery.shipped_on_time': ['91.2', '92.4', '90.1', '93.8', '94.0', '92.7', '95.1', '94.6', '96.0', '93.3', '94.8', '95.6'],
  'delivery.otif': ['84.0', '86.5', '83.2', '88.1', '87.4', '85.9', '89.3', '88.8', '90.2', '87.0', '89.6', '86.7'],
  'delivery.otif_current': ['89.0', '90.5', '88.2', '91.1', '92.4', '90.9', '93.3', '92.8', '94.2', '91.0', '93.6', '91.7'],
  'production.wip_value': ['18240000', '18910000', '19420000', '18730000', '19980000', '20410000', '19650000', '20870000', '21140000', '20320000', '21760000', '22030000'],
  'sales.order_margin': ['36.4', '37.1', '35.8', '38.2', '37.6', '36.9', '38.8', '39.1', '37.4', '38.5', '39.0', '38.3'],
  'sales.margin_actual': ['34.2', '35.0', '33.9', '36.1', null, '35.4', '36.8', '37.0', '35.9', '36.6', '37.2', '36.4'],
  'sales.margin_quoted': ['36.0', '36.8', '35.5', '37.9', null, '36.6', '38.4', '38.9', '37.1', '38.2', '38.8', '38.0'],
  'production.output': ['1840', '1920', '1785', '2010', '1965', '1880', '2105', '2140', '2025', '2190', '2230', '1260'],
  'production.scrap_rate': ['2.4', '2.1', '2.6', '2.0', '1.9', '2.2', '1.8', '1.7', '2.0', '1.6', '1.8', '1.5'],
  'production.wip_pieces': ['612', '640', '655', '630', '672', '690', '668', '701', '715', '694', '728', '736'],
  'production.wip_age_days': ['4.1', '4.3', '4.6', '4.2', '4.8', '5.0', '4.7', '5.2', '5.4', '5.1', '5.6', '5.8'],
  'production.leather_yield': ['78.2', '79.0', '77.6', '80.1', '79.4', '78.8', '80.6', '81.0', '79.9', '80.8', '81.4', '80.2'],
  'production.order_to_start_days': ['6.2', '6.0', '6.5', '5.8', '5.9', '6.3', '5.6', '5.4', '5.7', '5.3', '5.5', '5.1'],
  'sales.order_lines_in': ['142', '156', '149', '168', '161', '150', '174', '181', '166', '188', '193', '104'],
  'sales.quote_to_order_days': ['9.4', '8.9', '9.8', '8.6', '8.8', '9.1', '8.2', '8.0', '8.5', '7.9', '8.1', '7.6'],
  'delivery.order_to_ship_days': ['31.0', '30.4', '32.1', '29.8', '30.0', '30.9', '29.1', '28.7', '29.5', '28.4', '28.9', '28.2'],
  'purchasing.supplier_on_time': ['82.0', '84.5', '81.3', '86.0', '85.2', '83.7', '87.4', '86.9', '88.1', '85.6', '87.9', '88.4'],
  'purchasing.receipt_lines': ['64', '71', '58', '76', '69', '62', '80', '84', '73', '88', '91', '47'],
}

function numberOf(kpiKey: string, standsFor: string | null, kind: 'WEEK' | 'MONTH' | 'QUARTER', change: Partial<DashNumber> = {}): DashNumber {
  const file = kpiFileOf(kpiKey)!
  const list = periods(kind)
  const values = SERIES[kpiKey] ?? list.map(() => null)
  const sources = [...new Set(measuresOfCalc(file.calc).map((key) => measureOf(key)!.source))]
  const stand = standsFor ? kpiFileOf(standsFor)! : null
  return {
    kpiKey,
    unit: file.unit,
    grain: file.grain,
    name: { it: file.words.nameIt, en: file.words.nameEn },
    definition: { it: file.words.definitionIt, en: file.words.definitionEn },
    formula: { it: file.words.formulaIt, en: file.words.formulaEn },
    standsFor: stand ? { kpiKey: stand.key, name: { it: stand.words.nameIt, en: stand.words.nameEn } } : null,
    sources,
    wholeCompany: false,
    period: list.at(-1)!,
    value: values.at(-1) ?? null,
    currency: file.unit === 'MONEY' ? 'EUR' : null,
    converted: [],
    asOf: AS_OF,
    stale: false,
    live: false,
    missingDays: 0,
    problem: null,
    periods: list.map((period, index) => ({ ...period, value: values[index] ?? null })),
    drill: file.drill ? (file.drill.kind === 'REPORT' ? { kind: 'REPORT', key: file.drill.key, api: null, terms: { ...file.drill.filters } } : { kind: 'LIST', key: null, api: file.drill.api, terms: { ...file.drill.query } }) : null,
    ...change,
  }
}

export function numbersFor(role: Role, board: DashboardKey, kind: 'WEEK' | 'MONTH' | 'QUARTER' = 'MONTH', change: (number: DashNumber) => Partial<DashNumber> = () => ({})): Numbers {
  const chosen = chooseNumbers(boardOf(board)!, mayRead(role))
  return { board, asOf: AS_OF, period: kind, numbers: chosen.shown.map((item) => { const number = numberOf(item.kpiKey, item.standsFor, kind); return { ...number, ...change(number) } }), withheld: [...chosen.withheld] }
}

export const NEEDS: NeedsAction = {
  asOf: AS_OF,
  rows: [
    { kind: 'SHIPMENT_AT_RISK', count: 3, severity: 'HIGH', oldestDays: 2, complete: true },
    { kind: 'LOT_HOLD', count: 2, severity: 'HIGH', oldestDays: 3, complete: true },
    { kind: 'RULE_ALERT', count: 4, severity: 'MEDIUM', oldestDays: 1, complete: true },
    { kind: 'WORK_ORDER_HELD', count: 1, severity: 'MEDIUM', oldestDays: 0, complete: true },
    { kind: 'INVOICE_SDI', count: 1, severity: 'LOW', oldestDays: 6, complete: true },
  ],
  all: 14,
  complete: true,
}
export const NEEDS_NONE: NeedsAction = { asOf: AS_OF, rows: [], all: 0, complete: true }

const weeks = periods('WEEK')
export function trendsFor(scopeCompany: boolean, values: readonly (string | null)[] = SERIES['delivery.shipped_on_time']!): Trends {
  const file = kpiFileOf('delivery.shipped_on_time')!
  return {
    kpi: { kpiKey: file.key, unit: file.unit, grain: file.grain, name: { it: file.words.nameIt, en: file.words.nameEn } },
    target: 95,
    weeks,
    values: [...values],
    series: scopeCompany
      ? []
      : [
          { company: { id: COMPANY_A.id, code: COMPANY_A.code, name: COMPANY_A.name }, values: ['92.0', '93.1', '90.8', '94.4', '94.9', '93.2', '95.7', '95.0', '96.6', '94.1', '95.3', '96.2'] },
          { company: { id: COMPANY_B.id, code: COMPANY_B.code, name: COMPANY_B.name }, values: ['88.5', '89.9', '88.2', '91.6', '91.0', '90.8', '93.0', '92.7', '93.8', '90.4', '92.6', '93.1'] },
        ],
    currency: null,
    converted: [],
    asOf: AS_OF,
    stale: false,
    live: false,
    missingDays: 0,
    problem: null,
  }
}

export const WIP: Wip = {
  asOf: AS_OF,
  kpiKey: 'production.wip_pieces',
  overall: { workOrders: 9, pieces: 412, waiting: 236 },
  stages: [
    { code: 'DEMO-CUT', name: 'Cut leather panels', workOrders: 3, waiting: 64, ageing: { D0_2: 40, D3_5: 24, D6_10: 0, D11_PLUS: 0 } },
    { code: 'DEMO-PERF', name: 'Perforate panels', workOrders: 2, waiting: 30, ageing: { D0_2: 30, D3_5: 0, D6_10: 0, D11_PLUS: 0 } },
    { code: 'DEMO-SEW', name: 'Sew and assemble', workOrders: 5, waiting: 96, ageing: { D0_2: 22, D3_5: 38, D6_10: 24, D11_PLUS: 12 } },
    { code: 'DEMO-QC', name: 'Final inspection', workOrders: 2, waiting: 28, ageing: { D0_2: 28, D3_5: 0, D6_10: 0, D11_PLUS: 0 } },
    { code: 'DEMO-PACK', name: 'Pack', workOrders: 1, waiting: 18, ageing: { D0_2: 0, D3_5: 18, D6_10: 0, D11_PLUS: 0 } },
  ],
}

export function byCompanyFor(role: Role): ByCompany {
  const chosen = chooseNumbers(boardOf('owner-group')!, mayRead(role))
  const files = chosen.shown.map((item) => kpiFileOf(item.kpiKey)!)
  const perSite = (key: string) => measuresOfCalc(kpiFileOf(key)!.calc).every((measure) => measureOf(measure)!.levels.includes('SITE'))
  const cell = (key: string, value: string | null, perCompanyOnly = false) => ({ kpiKey: key, value, perCompanyOnly, currency: kpiFileOf(key)!.unit === 'MONEY' ? 'EUR' : null, converted: [], asOf: AS_OF, stale: false, live: false, missingDays: 0, problem: null })
  const A: Record<string, string> = { 'sales.orders_in': '1920000', 'delivery.shipped_on_time': '96.2', 'delivery.otif': '88.4', 'production.wip_value': '15840000', 'sales.order_margin': '39.1', 'production.output': '880', 'production.wip_pieces': '512', 'sales.order_lines_in': '71' }
  const B: Record<string, string> = { 'sales.orders_in': '940000', 'delivery.shipped_on_time': '93.1', 'delivery.otif': '83.0', 'production.wip_value': '6190000', 'sales.order_margin': '36.8', 'production.output': '380', 'production.wip_pieces': '224', 'sales.order_lines_in': '33' }
  const NORD: Record<string, string> = { 'production.wip_value': '15840000', 'production.output': '880', 'production.wip_pieces': '512' }
  const anyPerSite = files.some((file) => perSite(file.key))
  return {
    board: 'owner-group',
    asOf: AS_OF,
    period: periods('MONTH').at(-1)!,
    columns: files.map((file) => ({ kpiKey: file.key, unit: file.unit, grain: file.grain, name: { it: file.words.nameIt, en: file.words.nameEn }, perSite: perSite(file.key) })),
    rows: [
      { company: { id: COMPANY_A.id, code: COMPANY_A.code, name: COMPANY_A.name }, site: null, cells: files.map((file) => cell(file.key, A[file.key] ?? null)), sites: anyPerSite ? { read: 1, of: 2 } : null },
      { company: { id: COMPANY_A.id, code: COMPANY_A.code, name: COMPANY_A.name }, site: COMPANY_A.sites[0]!, cells: files.map((file) => (perSite(file.key) ? cell(file.key, NORD[file.key] ?? null) : cell(file.key, null, true))), sites: null },
      { company: { id: COMPANY_A.id, code: COMPANY_A.code, name: COMPANY_A.name }, site: COMPANY_A.sites[1]!, cells: files.map((file) => (perSite(file.key) ? { ...cell(file.key, null), problem: 'NOT_BUILT' as const } : cell(file.key, null, true))), sites: null },
      { company: { id: COMPANY_B.id, code: COMPANY_B.code, name: COMPANY_B.name }, site: null, cells: files.map((file) => cell(file.key, B[file.key] ?? null)), sites: anyPerSite ? { read: 1, of: 1 } : null },
      { company: { id: COMPANY_B.id, code: COMPANY_B.code, name: COMPANY_B.name }, site: COMPANY_B.sites[0]!, cells: files.map((file) => (perSite(file.key) ? cell(file.key, B[file.key] ?? null) : cell(file.key, null, true))), sites: null },
    ],
  }
}

export function layoutOfBoard(board: DashboardKey, change: (panels: LayoutPanel[]) => LayoutPanel[] = (panels) => panels, saved = false): DashLayout {
  return { board, panels: change(defaultLayout(boardOf(board)!)), saved, version: saved ? 3 : 0, updatedAt: saved ? AS_OF : null }
}

const ready = <T,>(value: T): Read<T> => ({ status: 'ready', value })

/** A whole dashboard for a design role (every panel read), on its own dashboard or the one named, with changes. */
export function dashboardFor(role: Role, change: Partial<DashboardsModel> = {}, board?: DashboardKey): DashboardsModel {
  const boards = boardsFor(role)
  const key = board ?? ROLE_BOARD[role] ?? 'owner-group'
  const entry = boards.boards.find((item) => item.key === key) ?? null
  const address: DashboardAddress = { ...DEFAULT_ADDRESS, board: key, ...(change.address ?? {}) }
  return {
    can: dashboardsCanOf(permissionsOf(role)),
    prefix: PREFIX,
    boards: ready(boards),
    board: entry,
    numbers: ready(numbersFor(role, key, address.period)),
    needs: ready(NEEDS),
    trends: ready(trendsFor(address.company !== null)),
    wip: ready(WIP),
    byCompany: ready(byCompanyFor(role)),
    layout: ready(layoutOfBoard(key)),
    built: OFFICE_PAGES,
    mode: 'page',
    now: NOW,
    ...change,
    address,
  }
}
