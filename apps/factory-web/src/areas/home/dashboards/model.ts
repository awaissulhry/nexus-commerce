import { REPORT_PANELS, reportPanelOf } from '@nexus/factory-domain/insights/dashboards/boards'
import type { SectionLayoutValue, SectionSpec, SectionWidth } from '@nexus/ui/patterns'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { recordsLinkOf, valueNumber } from '../kpis/model'
import { BOARD_PANELS, DASHBOARD_KEYS, DASHBOARD_PERIODS, type BoardEntry, type BoardPanel, type DashboardKey, type DashboardPeriod, type DashNumber, type LayoutPanel, type NeedsRow, type PanelWidth, type Said } from './api'

/**
 * Rules of Home › Insights › Dashboards (SCR-031 the role dashboards, SCR-103 the Owner's group view, SCR-490 Present; design
 * home.dashboards): the address (which dashboard, the period, the scope), where each number and exception opens, the panels
 * and their arrangement (the DS SectionLayout's value ⇄ the server's layout), pinned reports, and the words of a KPI in the
 * reader's language. Pure: the containers load, the views draw.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string
type Params = Pick<URLSearchParams, 'get'>

export interface DashboardsAbilities {
  /** The KPI library's read (home.kpis.view): every dashboard is made of its KPIs. */
  readonly view: boolean
}

export const dashboardsCanOf = (permissions: readonly string[]): DashboardsAbilities => ({ view: permissions.includes('home.kpis.view') })

/** The live events after which the numbers are read again (a rebuild of the facts; a KPI's words changed). */
export const DASHBOARD_LIVE_EVENTS: readonly string[] = ['facts.rebuilt', 'kpi.changed']

/** How often Present reads everything again on its own (design tab:present "auto-refreshing"), ms. */
export const PRESENT_REFRESH_MS = 5 * 60_000

// ---- the address --------------------------------------------------------------------------------------------------------------

export interface DashboardAddress {
  /** Null: the person's first dashboard (their role's). */
  readonly board: DashboardKey | null
  readonly period: DashboardPeriod
  /** Null: every company the person reaches (design "Scope: All companies"). */
  readonly company: string | null
  readonly site: string | null
}

export const DEFAULT_ADDRESS: DashboardAddress = { board: null, period: 'MONTH', company: null, site: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const asId = (value: string | null): string | null => (value && UUID.test(value) ? value : null)

export function dashboardAddressOf(params: Params): DashboardAddress {
  const board = params.get('board')
  const period = params.get('period')
  return {
    board: board && (DASHBOARD_KEYS as readonly string[]).includes(board) ? (board as DashboardKey) : null,
    period: period && (DASHBOARD_PERIODS as readonly string[]).includes(period) ? (period as DashboardPeriod) : 'MONTH',
    company: asId(params.get('company')),
    site: asId(params.get('site')),
  }
}

const query = (address: DashboardAddress): string => {
  const out = new URLSearchParams()
  if (address.board) out.set('board', address.board)
  if (address.period !== 'MONTH') out.set('period', address.period)
  if (address.company) out.set('company', address.company)
  if (address.site) out.set('site', address.site)
  const text = out.toString()
  return text ? `?${text}` : ''
}

export const dashboardsHref = (prefix: string, address: DashboardAddress): string => `${prefix}/home/dashboards${query(address)}`

/** Present (design tab:present): the same dashboard in its own window, large, refreshing itself. */
export const presentHref = (prefix: string, address: DashboardAddress): string => `${prefix}/home/dashboards/present${query(address)}`

/** The dashboard shown: the address's when the person may see it, else their first (their role's first). */
export function boardShown(boards: readonly BoardEntry[], address: DashboardAddress): BoardEntry | null {
  return boards.find((entry) => entry.key === address.board) ?? boards[0] ?? null
}

// ---- words ------------------------------------------------------------------------------------------------------------------------

/** A KPI's words (data of its version) in the reader's language. */
export const sayIn = (words: Said, locale: Locale): string => (locale === 'it' ? words.it : words.en)

// ---- where things open ------------------------------------------------------------------------------------------------------------

/** Where a number's records open (company-free): its report, its records page over the period shown, or its list. */
export function recordsHrefOf(number: Pick<DashNumber, 'kpiKey' | 'drill' | 'period'>, built: ReadonlySet<string>): string | null {
  return recordsLinkOf(number.kpiKey, { drill: number.drill }, number.period, built)?.href ?? null
}

/** How a number is made: the KPI's record in the library (company-free). */
export const definitionHref = (kpiKey: string): string => `/home/kpis/${encodeURIComponent(kpiKey)}`

/** An exception kind's rows (company-free): the alerts page for rule alerts when it is built, else Today with that kind. */
export function needsHrefOf(row: Pick<NeedsRow, 'kind'>, built: ReadonlySet<string>): string {
  if (row.kind === 'RULE_ALERT' && built.has('/home/alerts')) return '/home/alerts'
  return `/home/today?kind=${encodeURIComponent(row.kind)}`
}

/** "See all N": every exception on Today. */
export const SEE_ALL_HREF = '/home/today?tile=ALERT'

/** A company's cell opens that company's records (the address switches company openly: `/w/<code>/…`). */
export const companyHref = (code: string, href: string): string => `/w/${encodeURIComponent(code)}${href}`

/** The work in progress's records (the KPI's records page). */
export const wipHref = (kpiKey: string, built: ReadonlySet<string>): string | null => (built.has('/home/kpis/[key]/records') ? `/home/kpis/${encodeURIComponent(kpiKey)}/records` : null)

/** The shipments behind the on-time chart: the KPI's report over its last 8 weeks (the report takes its own periods). */
export const onTimeHref = (built: ReadonlySet<string>): string | null => (built.has('/home/reports/[key]') ? '/home/reports/sales.shipments-on-time?period=LAST_8_WEEKS' : null)

// ---- numbers ----------------------------------------------------------------------------------------------------------------------

/** The 12 periods as numbers for the line (money in major units; a missing value keeps its place). */
export const sparkOf = (number: Pick<DashNumber, 'unit' | 'periods'>): (number | null)[] => number.periods.map((period) => valueNumber(number.unit, period.value))

/** "Not enough data yet: 3 of 12 weeks" — how many weeks of a line have a value. */
export const weeksWithData = (values: readonly (string | null)[]): number => values.filter((value) => value !== null).length

// ---- panels and their arrangement -------------------------------------------------------------------------------------------------

export type PinnedPanel = { readonly kind: 'panel'; readonly id: string; readonly area: string; readonly panel: string; readonly page: string } | { readonly kind: 'report'; readonly id: string; readonly key: string }

/** A pinned panel's id read: a W2b-5 report page's panel, or a report of the pack (`report:<key>`); null for a board panel. */
export function pinnedOf(id: string): PinnedPanel | null {
  const panel = reportPanelOf(id)
  if (panel) return { kind: 'panel', id, area: panel.area, panel: panel.panel, page: panel.page }
  if (id.startsWith('report:')) return { kind: 'report', id, key: id.slice('report:'.length) }
  return null
}

export const isBoardPanel = (id: string): id is BoardPanel => (BOARD_PANELS as readonly string[]).includes(id)

const TO_SECTION: Readonly<Record<PanelWidth, SectionWidth>> = { HALF: 'half', TWO_THIRDS: 'two-thirds', FULL: 'full' }
const TO_PANEL: Readonly<Record<SectionWidth, PanelWidth>> = { half: 'HALF', 'two-thirds': 'TWO_THIRDS', full: 'FULL' }

/** The panels a person sees on a board: the server's arrangement, less the board panels they may not see. */
export function visiblePanels(layout: readonly LayoutPanel[], allowed: readonly BoardPanel[]): LayoutPanel[] {
  return layout.filter((panel) => (isBoardPanel(panel.id) ? allowed.includes(panel.id) : pinnedOf(panel.id) !== null))
}

/** The DS SectionLayout's specs (the numbers locked: never hidden, never moved off the top). */
export function sectionSpecs(panels: readonly LayoutPanel[], label: (id: string) => string): SectionSpec[] {
  return panels.map((panel) => ({ id: panel.id, label: label(panel.id), defaultWidth: TO_SECTION[panel.width], ...(panel.id === 'numbers' ? { locked: true } : {}) }))
}

/** The server's arrangement as the DS SectionLayout's value: the shown panels in order and every width. */
export function sectionValue(panels: readonly LayoutPanel[]): SectionLayoutValue {
  return { order: panels.filter((panel) => !panel.hidden).map((panel) => panel.id), widths: Object.fromEntries(panels.map((panel) => [panel.id, TO_SECTION[panel.width]])) }
}

/**
 * The arrangement to save from the dialog's value: the shown panels in their new order, then the hidden ones in their old order;
 * panels the person may not see (kept from before) stay where they were in the hidden part, so nothing is lost.
 */
export function layoutFrom(value: SectionLayoutValue, before: readonly LayoutPanel[]): LayoutPanel[] {
  const shown = value.order.flatMap((id) => {
    const panel = before.find((entry) => entry.id === id)
    return panel ? [{ id, hidden: false, width: TO_PANEL[value.widths[id] ?? TO_SECTION[panel.width]] }] : []
  })
  const rest = before.filter((panel) => !value.order.includes(panel.id)).map((panel) => ({ id: panel.id, hidden: panel.id === 'numbers' ? false : true, width: TO_PANEL[value.widths[panel.id] ?? TO_SECTION[panel.width]] }))
  return [...shown, ...rest]
}

/** The W2b-5 report panels a report page can pin (follow-up DB1:01), by area. */
export const pinnableOf = (area: string): string[] => REPORT_PANELS.filter((panel) => panel.area === area).map((panel) => panel.id)

/** The arrangement after pinning these report panels (each once, shown, half width) to the end of the layout. */
export function withPinned(layout: readonly LayoutPanel[], ids: readonly string[]): LayoutPanel[] {
  const kept = layout.map((panel) => (ids.includes(panel.id) ? { ...panel, hidden: false } : panel))
  const added = ids.filter((id) => !layout.some((panel) => panel.id === id)).map((id) => ({ id, hidden: false, width: 'HALF' as const }))
  return [...kept, ...added]
}

// ---- problems -------------------------------------------------------------------------------------------------------------------

/** A failed read as a message key (the panel says it with Try again). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'error.read'
  if (error.kind === 'forbidden') return 'error.forbidden'
  if (error.kind === 'not_found') return 'error.notFound'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.read'
}

/** A refused save of the arrangement as a message key. */
export function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'error.save'
  if (error.kind === 'conflict') return 'error.stale'
  if (error.kind === 'not_found') return 'error.gone'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'invalid' || error.issues.map(issuePath).some((path) => path.startsWith('body'))) return 'error.invalid'
  return 'error.save'
}

// ---- keys -----------------------------------------------------------------------------------------------------------------------

/** The page's keys (design: 1–5 open number 1–5's records, ⇧A arrange, P present, ? the list), said in the footer's info icon. */
export const DASHBOARD_KEYS_MAP = [
  ['1–5', 'keys.number'],
  ['⇧A', 'keys.arrange'],
  ['P', 'keys.present'],
  ['?', 'keys.help'],
] as const
