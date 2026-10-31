import { heldGrains, type Grain } from '../../auth/grains/grains'
import { COSTING_VIEW } from '../../costing/permissions'
import { holds, type Actor, type Permission } from '../../core/permissions'
import { CERTIFICATES_VIEW } from '../../compliance/certificates/permissions'
import { INVENTORY_STOCK_VIEW } from '../../inventory/permissions'
import { INVOICES_VIEW } from '../../invoicing/permissions'
import { PLANNING_VIEW } from '../../planning/permissions'
import { PRODUCTION_REPORTS_VIEW } from '../../production/reports/permissions'
import { WORKORDERS_VIEW } from '../../production/work-orders/permissions'
import { PURCHASING_VIEW } from '../../purchasing/permissions'
import { QUALITY_LOTS_VIEW } from '../../quality/lab/permissions'
import { QUALITY_NCR_VIEW } from '../../quality/ncr/permissions'
import { RECEIVABLES_VIEW } from '../../receivables/permissions'
import { ORDERS_VIEW } from '../../sales/orders/permissions'
import { FLOW_LENSES, type FlowLens } from '../flow'

/**
 * My numbers (B-W2a-79; ANA-001 role home dashboards; design home.today `key-numbers` and pop:number-explain): three to
 * five numbers per role lens of Today (the flow strip's lenses: the lens picked there picks the numbers, as it picks My
 * lists), each against its target where the design names one, each with "How this number is made", each a link to the
 * list or report behind it. One metric layer: a number names the report that lists its rows (home.reports).
 *
 *   permission  the list it counts (a person without it never gets the number)
 *   grain       price, cost or margin: the number appears only with its grain (never a locked tile)
 *   target      the design's targets only (lines late 0, shipped on time 95 %); set by the standard pack, not editable yet
 *   history     an 8-week sparkline can be made from the records' own dates; else the number is counted now only
 *   list        the area list that shows exactly its rows (API list + its address terms), when one does
 *   report      the report (and its filters) that lists its rows
 *
 * Counts per order, work order, line, lot or document: never per person (Owner answers W1, F2).
 */

export const NUMBER_UNITS = ['COUNT', 'PERCENT', 'MONEY'] as const
export type NumberUnit = (typeof NUMBER_UNITS)[number]

export const TARGET_DIRECTIONS = ['AT_MOST', 'AT_LEAST'] as const
export type TargetDirection = (typeof TARGET_DIRECTIONS)[number]

/** What the reader is told about a value against its target (with an icon, never colour alone). */
export const TARGET_WORDS = ['ON_TARGET', 'ABOVE_TARGET', 'BELOW_TARGET'] as const
export type TargetWord = (typeof TARGET_WORDS)[number]

export interface NumberTarget {
  readonly value: number
  readonly direction: TargetDirection
}

export interface NumberRule {
  readonly key: string
  readonly lens: FlowLens
  readonly label: string
  readonly unit: NumberUnit
  readonly grain: Grain | null
  readonly permission: Permission
  readonly target: NumberTarget | null
  readonly history: boolean
  readonly list: { readonly api: string; readonly query: Readonly<Record<string, string>> } | null
  readonly report: { readonly key: string; readonly filters: Readonly<Record<string, string>> } | null
  /** How this number is made, in words. */
  readonly definition: string
  readonly formula: string
  readonly sources: string
  readonly period: string
}

/** Who set the targets (the design's "target and who set it"): the standard pack, until the KPI library (W2b) edits them. */
export const TARGET_SET_BY = 'The standard report pack (targets become editable with the KPI library).'

/** Every period is cut at the site's midnight (Europe/Rome). */
export const CUT_OFF = 'Days run from midnight to midnight at the site (Europe/Rome); weeks start on Monday.'

/** At most this many numbers per lens (the design: three to five). */
export const MAX_NUMBERS = 5

const rule = (value: NumberRule): NumberRule => Object.freeze(value)

export const NUMBER_RULES: readonly NumberRule[] = Object.freeze([
  // ---- Sales orders (owner, sales, finance, planner …) ---------------------------------------------------------------
  rule({
    key: 'orders.inThisWeek',
    lens: 'ORDERS',
    label: 'Orders in this week',
    unit: 'MONEY',
    grain: 'price',
    permission: ORDERS_VIEW,
    target: null,
    history: true,
    list: null,
    report: { key: 'sales.orders-in', filters: { period: 'THIS_WEEK' } },
    definition: 'The net value of the sales orders taken this week.',
    formula: 'Sum of the net amount (before VAT) of every order with an order date this week, cancelled orders left out.',
    sources: 'Sales orders',
    period: 'This week, Monday to today; the line shows the last 8 weeks.',
  }),
  rule({
    key: 'orders.late',
    lens: 'ORDERS',
    label: 'Late orders',
    unit: 'COUNT',
    grain: null,
    permission: ORDERS_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/sales/orders', query: { late: 'true' } },
    report: { key: 'sales.late-orders', filters: {} },
    definition: 'Open orders whose promise date has passed.',
    formula: 'Count of orders confirmed, in production, ready or partly shipped with a promise date before today.',
    sources: 'Sales orders',
    period: 'Now.',
  }),
  rule({
    key: 'orders.promisedThisWeek',
    lens: 'ORDERS',
    label: 'Promised this week',
    unit: 'COUNT',
    grain: null,
    permission: ORDERS_VIEW,
    target: null,
    history: false,
    list: null,
    report: { key: 'sales.open-orders', filters: { promise: 'THIS_WEEK' } },
    definition: 'Open orders promised to the customer for this week.',
    formula: 'Count of open orders with a promise date from Monday to Sunday of this week.',
    sources: 'Sales orders',
    period: 'This week, Monday to Sunday.',
  }),
  rule({
    key: 'orders.shippedOnTime',
    lens: 'ORDERS',
    label: 'Shipped on time',
    unit: 'PERCENT',
    grain: null,
    permission: ORDERS_VIEW,
    target: { value: 95, direction: 'AT_LEAST' },
    history: true,
    list: null,
    report: { key: 'sales.shipments-on-time', filters: { period: 'LAST_8_WEEKS' } },
    definition: 'The share of shipments that left on or before the order’s promise date.',
    formula: 'Shipments shipped in the last 4 weeks that left on or before their order’s promise date, divided by every shipment shipped in those weeks.',
    sources: 'Shipments and their sales orders',
    period: 'The last 4 weeks; the line shows each of the last 8 weeks.',
  }),
  rule({
    key: 'orders.marginThisMonth',
    lens: 'ORDERS',
    label: 'Margin this month',
    unit: 'PERCENT',
    grain: 'margin',
    permission: COSTING_VIEW,
    target: null,
    history: false,
    list: { api: '/costing/margins', query: {} },
    report: { key: 'sales.margin-by-order', filters: { period: 'THIS_MONTH' } },
    definition: 'The average margin of the orders taken this month, from the estimate now.',
    formula: 'Average estimate margin % of the orders with an order date this month (orders without a known cost left out).',
    sources: 'Sales orders, their work orders and cost entries',
    period: 'This month, from the 1st to today.',
  }),
  // ---- Work orders (planner, production) -----------------------------------------------------------------------------
  rule({
    key: 'workorders.late',
    lens: 'WORK_ORDERS',
    label: 'Work orders late',
    unit: 'COUNT',
    grain: null,
    permission: WORKORDERS_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/production/work-orders', query: { view: 'late' } },
    report: { key: 'production.wip-by-stage', filters: { late: 'LATE' } },
    definition: 'Open work orders past their due date.',
    formula: 'Count of work orders in draft, released, in progress or on hold with a due date before today.',
    sources: 'Work orders',
    period: 'Now.',
  }),
  rule({
    key: 'planning.shortages',
    lens: 'WORK_ORDERS',
    label: 'Short of material',
    unit: 'COUNT',
    grain: null,
    permission: PLANNING_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: null,
    report: { key: 'planning.shortages', filters: { workOrders: 'RELEASED' } },
    definition: 'Released work orders that miss a material they need.',
    formula: 'Count of released or started work orders with at least one material short or arriving after it is needed, in the latest plan.',
    sources: 'The latest planning run, work orders and purchase orders',
    period: 'Now, as of the latest planning run.',
  }),
  rule({
    key: 'planning.loadNextWeek',
    lens: 'WORK_ORDERS',
    label: 'Load next week',
    unit: 'PERCENT',
    grain: null,
    permission: PLANNING_VIEW,
    target: null,
    history: false,
    list: { api: '/planning/capacity', query: {} },
    report: null,
    definition: 'The booked work of next week against the capacity of the lines and work centres.',
    formula: 'Booked standard minutes of next week divided by the available minutes (people × working minutes × efficiency) of every line and work centre.',
    sources: 'The planning board, line capacity and the site calendars',
    period: 'Next week, Monday to Sunday.',
  }),
  rule({
    key: 'production.goodLastDay',
    lens: 'WORK_ORDERS',
    label: 'Good garments, last working day',
    unit: 'COUNT',
    grain: null,
    permission: PRODUCTION_REPORTS_VIEW,
    target: null,
    history: false,
    list: { api: '/production/reports/daily', query: {} },
    report: { key: 'production.daily', filters: {} },
    definition: 'Garments that came out of the lines and work centres on the last working day.',
    formula: 'Good garments through each line’s last operation, summed over the lines and work centres of your sites.',
    sources: 'Floor scans, work orders and the site calendars',
    period: 'The last working day of each site’s calendar.',
  }),
  // ---- Purchase orders (buyer) ---------------------------------------------------------------------------------------
  rule({
    key: 'purchasing.notConfirmed',
    lens: 'PURCHASE_ORDERS',
    label: 'Not confirmed after 2 days',
    unit: 'COUNT',
    grain: null,
    permission: PURCHASING_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/purchasing/orders', query: { waitingOver48h: 'true' } },
    report: null,
    definition: 'Purchase orders sent more than 48 hours ago that the supplier has not confirmed.',
    formula: 'Count of purchase orders in Sent with a send time more than 48 hours ago.',
    sources: 'Purchase orders',
    period: 'Now.',
  }),
  rule({
    key: 'purchasing.lateDeliveries',
    lens: 'PURCHASE_ORDERS',
    label: 'Deliveries late',
    unit: 'COUNT',
    grain: null,
    permission: PURCHASING_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/purchasing/orders', query: { due: 'LATE' } },
    report: { key: 'purchasing.receipts-due', filters: { state: 'LATE' } },
    definition: 'Purchase orders with goods still to come after the date the supplier confirmed (or we asked).',
    formula: 'Count of open purchase orders with a line whose expected date (confirmed, else asked) is before today and is not all received.',
    sources: 'Purchase orders and goods receipts',
    period: 'Now.',
  }),
  rule({
    key: 'purchasing.dueThisWeek',
    lens: 'PURCHASE_ORDERS',
    label: 'Deliveries due this week',
    unit: 'COUNT',
    grain: null,
    permission: PURCHASING_VIEW,
    target: null,
    history: false,
    list: { api: '/purchasing/orders', query: { due: 'THIS_WEEK' } },
    report: { key: 'purchasing.receipts-due', filters: { state: 'THIS_WEEK' } },
    definition: 'Purchase orders with goods expected from today to Sunday.',
    formula: 'Count of open purchase orders with a line expected this week and not all received.',
    sources: 'Purchase orders and goods receipts',
    period: 'This week, today to Sunday.',
  }),
  // ---- Invoices (finance) --------------------------------------------------------------------------------------------
  rule({
    key: 'finance.overdue',
    lens: 'INVOICES',
    label: 'Overdue from customers',
    unit: 'MONEY',
    grain: 'price',
    permission: RECEIVABLES_VIEW,
    target: null,
    history: false,
    list: { api: '/receivables/ageing', query: {} },
    report: { key: 'finance.overdue-receivables', filters: {} },
    definition: 'What customers owe us past the due date.',
    formula: 'Sum of the open amounts of issued invoices whose due date has passed, credit notes and payments taken off.',
    sources: 'Invoices, payments and their due dates',
    period: 'Now.',
  }),
  rule({
    key: 'finance.sdiRefused',
    lens: 'INVOICES',
    label: 'Refused by SDI',
    unit: 'COUNT',
    grain: null,
    permission: INVOICES_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/invoicing/invoices', query: { status: 'REJECTED' } },
    report: null,
    definition: 'Invoices the tax authority’s exchange (SDI) refused: they must be corrected and sent again.',
    formula: 'Count of invoices in Rejected.',
    sources: 'Invoices and the SDI answers',
    period: 'Now.',
  }),
  rule({
    key: 'finance.invoicedThisWeek',
    lens: 'INVOICES',
    label: 'Invoiced this week',
    unit: 'MONEY',
    grain: 'price',
    permission: INVOICES_VIEW,
    target: null,
    history: true,
    list: { api: '/invoicing/invoices', query: {} },
    report: null,
    definition: 'The net value invoiced this week.',
    formula: 'Sum of the net totals of the invoices issued this week, credit notes taken off.',
    sources: 'Invoices and credit notes',
    period: 'This week, Monday to today; the line shows the last 8 weeks.',
  }),
  rule({
    key: 'finance.stockValue',
    lens: 'INVOICES',
    label: 'Stock value',
    unit: 'MONEY',
    grain: 'cost',
    permission: INVENTORY_STOCK_VIEW,
    target: null,
    history: false,
    list: { api: '/costing/valuation', query: {} },
    report: { key: 'finance.stock-value', filters: {} },
    definition: 'What the stock and the work in progress are worth at cost.',
    formula: 'Sum of the value of every stock move up to now (leather, materials, trims, packaging, finished goods) plus the cost entries of the work in progress.',
    sources: 'Stock moves and their valuation, work order cost entries',
    period: 'Now.',
  }),
  // ---- Lots and quality (inspector, buyer, warehouse) ----------------------------------------------------------------
  rule({
    key: 'quality.lotsOnHold',
    lens: 'LOTS',
    label: 'Lots on hold',
    unit: 'COUNT',
    grain: null,
    permission: QUALITY_LOTS_VIEW,
    target: null,
    history: false,
    list: { api: '/quality/lots', query: { view: 'onHold' } },
    report: null,
    definition: 'Received lots that may not be used yet: in quarantine or blocked.',
    formula: 'Count of lots in Quarantine or Blocked.',
    sources: 'Lots and their quality decisions',
    period: 'Now.',
  }),
  rule({
    key: 'quality.ncrOverdue',
    lens: 'LOTS',
    label: 'Containment overdue',
    unit: 'COUNT',
    grain: null,
    permission: QUALITY_NCR_VIEW,
    target: { value: 0, direction: 'AT_MOST' },
    history: false,
    list: { api: '/quality/ncr', query: { view: 'overdue' } },
    report: { key: 'quality.open-ncrs', filters: { overdue: 'OVERDUE' } },
    definition: 'Open nonconformances whose containment is past its due date.',
    formula: 'Count of nonconformances still open with the containment (or an open action) due before now.',
    sources: 'Nonconformances',
    period: 'Now.',
  }),
  rule({
    key: 'quality.ncrOpen',
    lens: 'LOTS',
    label: 'Open nonconformances',
    unit: 'COUNT',
    grain: null,
    permission: QUALITY_NCR_VIEW,
    target: null,
    history: false,
    list: { api: '/quality/ncr', query: { view: 'open' } },
    report: { key: 'quality.open-ncrs', filters: {} },
    definition: 'Nonconformances not closed yet.',
    formula: 'Count of nonconformances open, contained or decided.',
    sources: 'Nonconformances',
    period: 'Now.',
  }),
  rule({
    key: 'compliance.certificatesExpiring',
    lens: 'LOTS',
    label: 'Certificates expiring in 90 days',
    unit: 'COUNT',
    grain: null,
    permission: CERTIFICATES_VIEW,
    target: null,
    history: false,
    list: null,
    report: { key: 'compliance.certificates-expiring', filters: { within: 'NEXT_90_DAYS' } },
    definition: 'Valid certificates that end in the next 90 days.',
    formula: 'Count of certificates in Valid whose last valid day is from today to 90 days from now.',
    sources: 'Certificates',
    period: 'Today to 90 days from now.',
  }),
])

/** The numbers of a lens the actor may see: its list's permission and, for money, its grain. At most five. */
export function numbersFor(actor: Actor, lens: FlowLens): NumberRule[] {
  const held = heldGrains(actor)
  return NUMBER_RULES.filter((entry) => entry.lens === lens && holds(actor, entry.permission) && (entry.grain === null || held.has(entry.grain))).slice(0, MAX_NUMBERS)
}

/** The lenses that have numbers for the actor, in the flow strip's order. */
export function numberLensesFor(actor: Actor): FlowLens[] {
  return FLOW_LENSES.filter((lens) => numbersFor(actor, lens).length > 0)
}

/** A value against its target (null: no target, or no value). */
export function targetWordOf(value: number | null, target: NumberTarget | null): TargetWord | null {
  if (value === null || target === null) return null
  if (target.direction === 'AT_MOST') return value <= target.value ? 'ON_TARGET' : 'ABOVE_TARGET'
  return value >= target.value ? 'ON_TARGET' : 'BELOW_TARGET'
}

/** Every problem of the registry (a test holds it empty). */
export function numberProblems(rules: readonly NumberRule[] = NUMBER_RULES): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const entry of rules) {
    if (keys.has(entry.key)) problems.push(`${entry.key}: twice`)
    keys.add(entry.key)
    if (!(FLOW_LENSES as readonly string[]).includes(entry.lens)) problems.push(`${entry.key}: unknown lens`)
    if (entry.unit === 'MONEY' && entry.grain === null) problems.push(`${entry.key}: money says its grain`)
    if (!entry.list && !entry.report) problems.push(`${entry.key}: links to the list or the report behind it`)
    if (!entry.definition || !entry.formula || !entry.sources || !entry.period) problems.push(`${entry.key}: says how it is made`)
  }
  for (const lens of FLOW_LENSES) {
    const count = rules.filter((entry) => entry.lens === lens).length
    if (count < 3 || count > MAX_NUMBERS) problems.push(`${lens}: three to five numbers (has ${count})`)
  }
  return problems
}
