import { heldGrains } from '../../auth/grains/grains'
import { holds, type Actor, type Permission } from '../../core/permissions'
import { INVENTORY_REPORTS_VIEW } from '../../inventory/reports/permissions'
import { PLANNING_REPORTS_VIEW } from '../../planning/reports/permissions'
import { PURCHASING_REPORTS_VIEW } from '../../purchasing/reports/permissions'
import { SALES_REPORTS_VIEW } from '../sales-reports/permissions'
import { grainsOfKpi, permissionsOfKpi } from '../kpis/catalogue'
import { kpiFileOf } from '../kpis/registry'
import type { PeriodKind } from '../periods/periods'

/**
 * The dashboards (B-W2b-434; ANA-002 Owner group dashboard, ANA-003 drill-down to the records, ANA-004 data freshness; design
 * home.dashboards, SCR-031 / SCR-103): one ready dashboard per role and the Owner's group view across companies and sites.
 * Every number is a KPI of the metric layer (B-W2b-428, read only through its one calculation), so a number on a dashboard
 * means what the KPI library says it means, names its source and freshness, and opens the records behind it.
 *
 *   roles      the office role templates whose holders see this dashboard first ("my role first")
 *   numbers    the KPIs in order: the first five allowed are shown; a KPI the person may not read (its list or its money grain)
 *              gives its place to the next allowed one (design: "Cost and margin tiles need their grains; replaced by the
 *              next allowed number"), never a locked tile
 *   panels     the dashboard's own order and widths (Arrange changes them per person, saved on the server: DashboardLayout)
 *   group      the Owner's view: every company the person reaches, with the same numbers per company and site
 *
 * No number is of one person (Statuto dei Lavoratori art. 4; Owner answer W1): the KPIs read facts kept per company, site and
 * line only.
 */

export const DASHBOARD_KEYS = ['owner-group', 'plant-manager', 'sales', 'planner', 'buyer', 'quality', 'finance', 'line-leader'] as const
export type DashboardKey = (typeof DASHBOARD_KEYS)[number]

/**
 * A dashboard's own panels (design sections numbers, needs-action, trends — "Are we shipping on time?" — with its second
 * panel "Is work piling up?" (wip), by-company), the ids the seeded layouts use.
 */
export const BOARD_PANELS = ['numbers', 'needs-action', 'trends', 'wip', 'by-company'] as const
export type BoardPanel = (typeof BOARD_PANELS)[number]

export const PANEL_WIDTHS = ['HALF', 'TWO_THIRDS', 'FULL'] as const
export type PanelWidth = (typeof PANEL_WIDTHS)[number]

/** The numbers panel is the one the dashboard exists for: never hidden (design SectionLayout `locked`). */
export const LOCKED_PANEL: BoardPanel = 'numbers'

/** At most this many numbers on a dashboard (design: "Five numbers that answer 'are we OK?'"). */
export const SHOWN_NUMBERS = 5

/** At most this many exceptions in Needs action before "See all N" (design). */
export const NEEDS_ACTION_ROWS = 5

/** The periods a dashboard is read over (design: "This month vs last month"); 12 of them make each number's line. */
export const DASHBOARD_PERIODS = ['WEEK', 'MONTH', 'QUARTER'] as const satisfies readonly PeriodKind[]
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = 'MONTH'
export const SPARK_PERIODS = 12

/** Are we shipping on time? — the KPI of the chart and its line of weeks (design: 12 weeks with the target line). */
export const ON_TIME_KPI = 'delivery.shipped_on_time'
export const ON_TIME_WEEKS = 12
/** The design's target line (the standard pack's 95 %, as Today's "Shipped on time"); targets become editable in W3. */
export const ON_TIME_TARGET = 95

/** Is work piling up? — the KPI whose records the flow strip of stages shows (WIP by stage with ageing). */
export const WIP_KPI = 'production.wip_pieces'

export interface PanelSpec {
  readonly id: BoardPanel
  readonly width: PanelWidth
}

export interface Board {
  readonly key: DashboardKey
  readonly roles: readonly string[]
  readonly numbers: readonly string[]
  readonly panels: readonly PanelSpec[]
  readonly group: boolean
}

const panels = (...specs: readonly (readonly [BoardPanel, PanelWidth])[]): readonly PanelSpec[] => Object.freeze(specs.map(([id, width]) => Object.freeze({ id, width })))
const STANDARD = panels(['numbers', 'FULL'], ['needs-action', 'HALF'], ['trends', 'HALF'], ['wip', 'FULL'])
const board = (value: Board): Board => Object.freeze({ ...value, roles: Object.freeze([...value.roles]), numbers: Object.freeze([...value.numbers]) })

export const BOARDS: readonly Board[] = Object.freeze([
  // The design's Owner numbers: Orders in · Shipped (on time) · Late lines (on time in full) · WIP value (cost) · Margin (margin).
  board({
    key: 'owner-group',
    roles: ['owner'],
    numbers: ['sales.orders_in', 'delivery.shipped_on_time', 'delivery.otif', 'production.wip_value', 'sales.order_margin', 'production.output', 'production.wip_pieces', 'sales.order_lines_in'],
    panels: panels(['numbers', 'FULL'], ['needs-action', 'HALF'], ['trends', 'HALF'], ['by-company', 'FULL'], ['wip', 'FULL']),
    group: true,
  }),
  board({ key: 'plant-manager', roles: ['production_manager'], numbers: ['production.output', 'production.scrap_rate', 'production.wip_pieces', 'production.wip_age_days', 'production.leather_yield', 'production.order_to_start_days', 'delivery.shipped_on_time'], panels: STANDARD, group: false }),
  board({ key: 'sales', roles: ['sales'], numbers: ['sales.orders_in', 'sales.order_lines_in', 'sales.quote_to_order_days', 'delivery.otif', 'sales.order_margin', 'delivery.order_to_ship_days', 'delivery.shipped_on_time'], panels: STANDARD, group: false }),
  board({ key: 'planner', roles: ['planner'], numbers: ['delivery.otif', 'delivery.otif_current', 'delivery.order_to_ship_days', 'production.order_to_start_days', 'production.wip_pieces', 'delivery.shipped_on_time'], panels: STANDARD, group: false }),
  board({ key: 'buyer', roles: ['buyer', 'warehouse'], numbers: ['purchasing.supplier_on_time', 'purchasing.receipt_lines', 'production.leather_yield', 'production.order_to_start_days', 'delivery.otif', 'production.wip_pieces'], panels: STANDARD, group: false }),
  board({ key: 'quality', roles: ['quality_inspector'], numbers: ['production.scrap_rate', 'production.leather_yield', 'purchasing.supplier_on_time', 'delivery.otif', 'production.output', 'delivery.shipped_on_time'], panels: STANDARD, group: false }),
  board({ key: 'finance', roles: ['finance'], numbers: ['sales.orders_in', 'production.wip_value', 'sales.margin_actual', 'sales.margin_quoted', 'sales.order_margin', 'sales.order_lines_in', 'delivery.shipped_on_time'], panels: STANDARD, group: false }),
  board({ key: 'line-leader', roles: ['floor_supervisor'], numbers: ['production.output', 'production.scrap_rate', 'production.wip_pieces', 'production.wip_age_days', 'delivery.shipped_on_time', 'production.leather_yield'], panels: STANDARD, group: false }),
])

const BY_KEY = new Map(BOARDS.map((entry) => [entry.key, entry]))
export const boardOf = (key: string): Board | null => BY_KEY.get(key as DashboardKey) ?? null
export const isDashboardKey = (key: string): key is DashboardKey => BY_KEY.has(key as DashboardKey)

/** The dashboards in the picker's order: the person's own roles' first (in the design's order), then the others. */
export function boardsInOrder(roleKeys: readonly string[]): { readonly key: DashboardKey; readonly mine: boolean }[] {
  const held = new Set(roleKeys)
  const mine = (entry: Board) => entry.roles.some((role) => held.has(role))
  return [...BOARDS.filter(mine), ...BOARDS.filter((entry) => !mine(entry))].map((entry) => ({ key: entry.key, mine: mine(entry) }))
}

/** May the person read this KPI's value (its measures' lists and every money grain it needs)? */
export function mayReadKpi(actor: Actor, kpiKey: string): boolean {
  const file = kpiFileOf(kpiKey)
  if (!file) return false
  const grains = heldGrains(actor)
  return permissionsOfKpi(file).every((permission) => holds(actor, permission)) && grainsOfKpi(file).every((grain) => grains.has(grain))
}

export interface ChosenNumbers {
  /** The KPIs shown, in order (at most five), each with the one it stands in for when it moved up. */
  readonly shown: readonly { readonly kpiKey: string; readonly standsFor: string | null }[]
  /** The board's KPIs the person may not read (their places went to the next allowed ones). */
  readonly withheld: readonly string[]
}

/** The five numbers a person sees on a dashboard: the board's order, a KPI the person may not read replaced by the next allowed. */
export function chooseNumbers(entry: Board, mayRead: (kpiKey: string) => boolean): ChosenNumbers {
  const main = entry.numbers.slice(0, SHOWN_NUMBERS)
  const spares = entry.numbers.slice(SHOWN_NUMBERS).filter(mayRead)
  const withheld: string[] = []
  const shown: { kpiKey: string; standsFor: string | null }[] = []
  for (const key of main) {
    if (mayRead(key)) shown.push({ kpiKey: key, standsFor: null })
    else {
      withheld.push(key)
      const next = spares.shift()
      if (next) shown.push({ kpiKey: next, standsFor: key })
    }
  }
  return { shown, withheld }
}

// ---- report panels pinned to a dashboard (follow-up DB1:01: "Save as dashboard", saved per person on the server) --------

/**
 * What a person may pin to a dashboard: a pinned panel is one more panel of the layout, its id `report:<key>` — a panel of a
 * W2b-5 area report page (`report:sales.intake`, below; "Save as dashboard" on that page) or a report of the report pack
 * (`report:sales.late-orders`, home.reports; its keys are the API's registry, passed in as `packReports`). On the dashboard a
 * pinned panel opens its report; it reads nothing the report page does not read itself.
 */
export interface ReportPanel {
  readonly id: string
  readonly area: 'sales' | 'planning' | 'purchasing' | 'warehouse'
  readonly panel: string
  /** The report page (company-free) and the section it opens on. */
  readonly page: string
  readonly permission: Permission
}

const reportPanel = (area: ReportPanel['area'], panel: string, page: string, permission: Permission): ReportPanel => Object.freeze({ id: `report:${area}.${panel}`, area, panel, page, permission })

export const REPORT_PANELS: readonly ReportPanel[] = Object.freeze([
  ...['strip', 'intake', 'backlog', 'returns'].map((panel) => reportPanel('sales', panel, '/sales/reports', SALES_REPORTS_VIEW)),
  ...['adherence', 'utilisation', 'cover'].map((panel) => reportPanel('planning', panel, '/planning/reports', PLANNING_REPORTS_VIEW)),
  ...['spend', 'late'].map((panel) => reportPanel('purchasing', panel, '/purchasing/reports', PURCHASING_REPORTS_VIEW)),
  ...['ageing', 'leather'].map((panel) => reportPanel('warehouse', panel, '/warehouse/reports', INVENTORY_REPORTS_VIEW)),
])

const REPORT_BY_ID = new Map(REPORT_PANELS.map((entry) => [entry.id, entry]))
export const reportPanelOf = (id: string): ReportPanel | null => REPORT_BY_ID.get(id) ?? null

/** The report-pack key of a pinned panel id (`report:sales.late-orders` → sales.late-orders), when it names one of the pack. */
export const packReportOf = (id: string, packReports: ReadonlySet<string>): string | null => (id.startsWith('report:') && packReports.has(id.slice('report:'.length)) ? id.slice('report:'.length) : null)

/** Is this id a panel a person may pin (an area report panel or a report of the pack)? */
export const isPinnable = (id: string, packReports: ReadonlySet<string>): boolean => reportPanelOf(id) !== null || packReportOf(id, packReports) !== null

// ---- the person's arrangement (design pop:arrange: "Panels, order, widths; server-saved per person") ---------------------

export interface LayoutPanel {
  readonly id: string
  readonly hidden: boolean
  readonly width: PanelWidth
}

/** At most this many panels in a layout (the database's rule: 1 to 40). */
export const MAX_LAYOUT_PANELS = 40

const PANEL_ID = /^[a-z0-9]+([.:_-][a-z0-9]+)*$/

/** The dashboard's own layout (nothing saved yet). */
export const defaultLayout = (entry: Board): LayoutPanel[] => entry.panels.map((spec) => ({ id: spec.id, hidden: false, width: spec.width }))

/**
 * A stored layout read against the dashboard today: unknown ids dropped, the dashboard's panels it did not have yet added at
 * the end (a panel nobody hid is shown), the numbers never hidden. Pinned report panels are kept in their place.
 */
export function layoutOf(entry: Board, stored: readonly LayoutPanel[] | null, packReports: ReadonlySet<string>): LayoutPanel[] {
  if (!stored) return defaultLayout(entry)
  const own = new Set<string>(entry.panels.map((spec) => spec.id))
  const kept = stored.filter((panel) => own.has(panel.id) || isPinnable(panel.id, packReports)).map((panel) => ({ ...panel, hidden: panel.id === LOCKED_PANEL ? false : panel.hidden }))
  const seen = new Set(kept.map((panel) => panel.id))
  return [...kept, ...defaultLayout(entry).filter((panel) => !seen.has(panel.id))]
}

export interface LayoutProblem {
  readonly path: string
  readonly message: string
}

/** What is wrong with a layout a person sends (the database holds the shape too; this says it in words first). */
export function layoutProblems(entry: Board, panelsSent: readonly { readonly id: string; readonly hidden: boolean; readonly width: string }[], packReports: ReadonlySet<string>): LayoutProblem[] {
  const problems: LayoutProblem[] = []
  if (panelsSent.length === 0 || panelsSent.length > MAX_LAYOUT_PANELS) problems.push({ path: 'body/panels', message: `1 to ${MAX_LAYOUT_PANELS} panels.` })
  const own = new Set<string>(entry.panels.map((spec) => spec.id))
  const seen = new Set<string>()
  panelsSent.forEach((panel, index) => {
    if (!PANEL_ID.test(panel.id) || panel.id.length > 120 || (!own.has(panel.id) && !isPinnable(panel.id, packReports))) problems.push({ path: `body/panels/${index}/id`, message: 'Not a panel of this dashboard.' })
    else if (seen.has(panel.id)) problems.push({ path: `body/panels/${index}/id`, message: 'Each panel once.' })
    seen.add(panel.id)
    if (!(PANEL_WIDTHS as readonly string[]).includes(panel.width)) problems.push({ path: `body/panels/${index}/width`, message: 'HALF, TWO_THIRDS or FULL.' })
    if (panel.id === LOCKED_PANEL && panel.hidden) problems.push({ path: `body/panels/${index}/hidden`, message: 'The numbers are always shown.' })
  })
  if (!seen.has(LOCKED_PANEL)) problems.push({ path: 'body/panels', message: 'The numbers are always shown.' })
  return problems
}

/** The key of a person's layout of a dashboard (DashboardLayout.key; the database checks it). */
export const layoutKey = (userId: string, dashboardKey: DashboardKey): string => `dashboard:${userId}:${dashboardKey}`

/** The KPIs a dashboard reads (its numbers, and the on-time chart when it has that panel): its uses in the KPI library. */
export function kpisOfBoard(entry: Board): string[] {
  const keys = new Set(entry.numbers)
  if (entry.panels.some((spec) => spec.id === 'trends')) keys.add(ON_TIME_KPI)
  if (entry.panels.some((spec) => spec.id === 'wip')) keys.add(WIP_KPI)
  return [...keys].sort()
}
