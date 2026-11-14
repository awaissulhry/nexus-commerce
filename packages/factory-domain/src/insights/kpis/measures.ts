import type { Grain } from '../../auth/grains/grains'
import { COSTING_VIEW } from '../../costing/permissions'
import type { Permission } from '../../core/permissions'
import { INVENTORY_STOCK_VIEW } from '../../inventory/permissions'
import { PRODUCTION_REPORTS_VIEW } from '../../production/reports/permissions'
import { ORDERS_VIEW } from '../../sales/orders/permissions'

/**
 * The measures of the metric layer (B-W2b-428; ANA-069 reporting projections): what the daily and hourly facts (factory-db
 * FactDaily / FactHourly, B-W2b-381) count, each rebuilt from its records (apps/factory-api modules/insights/facts/sources)
 * for a company, a site of it or a line of the site, one business day (or hour) of that place's clock. A KPI reads
 * measures (KpiDefinition.measureKeys); nothing reads a fact whose measure is not here.
 *
 *   source       the records it is rebuilt from (one reader in the API per source; a source rebuilds all its measures)
 *   unit         COUNT (records), PIECES (garments or parts) — kept in `value`; MONEY — kept in minor units of the
 *                company's currency in the column of its grain (priceAmount, costAmount, marginAmount)
 *   kind         FLOW: what happened that day (a period sums its days); BALANCE: what stood at the day's end (a period
 *                reads its last day)
 *   levels       the places it is kept at: COMPANY (siteId and lineId null), SITE (the whole site), LINE (a line of the
 *                site; only lines with something to count)
 *   hourly       also kept per whole hour of the site's clock (FactHourly; the shifts are read from them)
 *   permission   the list its records belong to: a person without it never reads the measure; with a grant limited to
 *                some customers (`partyScoped` measures) the person's value is computed from their own records, the same
 *                calculation as the facts', since facts keep no customer
 *   unconverted  money in another currency than the company's is counted in the company's currency at the day's rate
 *                (platform/currency); records with no rate of their day are left out and counted in this measure, and a
 *                value that would hide them says MIXED_CURRENCIES instead
 *
 * Never a measure of a person: no worker, operator or office person is a place (Statuto dei Lavoratori art. 4; Owner answer
 * W1); a line's output is the line's.
 */

export const MEASURE_SOURCES = ['ORDERS', 'SHIPMENTS', 'PRODUCTION', 'WIP', 'RECEIPTS'] as const
export type MeasureSource = (typeof MEASURE_SOURCES)[number]

export const MEASURE_UNITS = ['COUNT', 'PIECES', 'MONEY'] as const
export type MeasureUnit = (typeof MEASURE_UNITS)[number]

export const MEASURE_KINDS = ['FLOW', 'BALANCE'] as const
export type MeasureKind = (typeof MEASURE_KINDS)[number]

export const MEASURE_LEVELS = ['COMPANY', 'SITE', 'LINE'] as const
export type MeasureLevel = (typeof MEASURE_LEVELS)[number]

/** The money grains a fact may hold (never wages or pay: a fact is never about a person). */
export type FactGrain = Extract<Grain, 'price' | 'cost' | 'margin'>

export interface Measure {
  readonly key: string
  readonly source: MeasureSource
  readonly unit: MeasureUnit
  /** MONEY only: the grain its amounts need. */
  readonly grain: FactGrain | null
  readonly kind: MeasureKind
  readonly levels: readonly MeasureLevel[]
  readonly hourly: boolean
  readonly permission: Permission
  readonly partyScoped: boolean
  /** The records it is rebuilt from (model names). */
  readonly records: readonly string[]
  readonly unconverted: string | null
}

const measure = (value: Measure): Measure => Object.freeze({ ...value, levels: Object.freeze([...value.levels]), records: Object.freeze([...value.records]) })

const ORDERS_RECORDS = ['SalesOrder', 'SalesOrderLine'] as const
const orders = (key: string, unit: MeasureUnit, grain: FactGrain | null, permission: Permission = ORDERS_VIEW): Measure =>
  measure({ key, source: 'ORDERS', unit, grain, kind: 'FLOW', levels: ['COMPANY'], hourly: false, permission, partyScoped: true, records: ORDERS_RECORDS, unconverted: unit === 'MONEY' ? 'orders.unconverted' : null })

export const MEASURES: readonly Measure[] = Object.freeze([
  // Sales orders taken, by their order date (cancelled orders left out): their lines, their net value, the net value of the
  // lines whose cost at order is known and their margin at order (net − cost at order of those lines).
  orders('orders.lines_in', 'COUNT', null),
  orders('orders.value', 'MONEY', 'price'),
  orders('orders.value_costed', 'MONEY', 'price', COSTING_VIEW),
  orders('orders.margin', 'MONEY', 'margin', COSTING_VIEW),
  orders('orders.unconverted', 'COUNT', null),
  // Shipments that left (SHIPPED or DELIVERED), by the day they left, of orders with a promise date; and those that left on or
  // before it.
  measure({ key: 'shipments.shipped', source: 'SHIPMENTS', unit: 'COUNT', grain: null, kind: 'FLOW', levels: ['COMPANY'], hourly: false, permission: ORDERS_VIEW, partyScoped: true, records: ['Shipment', 'SalesOrder'], unconverted: null }),
  measure({ key: 'shipments.on_time', source: 'SHIPMENTS', unit: 'COUNT', grain: null, kind: 'FLOW', levels: ['COMPANY'], hourly: false, permission: ORDERS_VIEW, partyScoped: true, records: ['Shipment', 'SalesOrder'], unconverted: null }),
  // The floor's output and scrap, counted as the daily production report counts them (factory-domain production/reports/daily:
  // good pieces at a lane's last operation, scrap at any operation and the scrap of finished rework), per site and line, per day
  // and per hour of the site's clock.
  measure({ key: 'production.output_pieces', source: 'PRODUCTION', unit: 'PIECES', grain: null, kind: 'FLOW', levels: ['SITE', 'LINE'], hourly: true, permission: PRODUCTION_REPORTS_VIEW, partyScoped: false, records: ['OperationScan', 'ReworkOrder'], unconverted: null }),
  measure({ key: 'production.scrap_pieces', source: 'PRODUCTION', unit: 'PIECES', grain: null, kind: 'FLOW', levels: ['SITE', 'LINE'], hourly: true, permission: PRODUCTION_REPORTS_VIEW, partyScoped: false, records: ['OperationScan', 'ReworkOrder'], unconverted: null }),
  // Work in progress at cost at the day's end: the balance of the work orders' cost ledger of the site (what was put on the work
  // orders less what left them to finished goods, variances and closes), in the company's currency.
  measure({ key: 'wip.cost', source: 'WIP', unit: 'MONEY', grain: 'cost', kind: 'BALANCE', levels: ['SITE'], hourly: false, permission: COSTING_VIEW, partyScoped: false, records: ['WorkOrderCostEntry'], unconverted: null }),
  // Goods receipt lines posted that day at the site (a reversed receipt drops out).
  measure({ key: 'receipts.lines', source: 'RECEIPTS', unit: 'COUNT', grain: null, kind: 'FLOW', levels: ['SITE'], hourly: false, permission: INVENTORY_STOCK_VIEW, partyScoped: false, records: ['GoodsReceipt', 'GoodsReceiptLine'], unconverted: null }),
])

const BY_KEY: ReadonlyMap<string, Measure> = new Map(MEASURES.map((entry) => [entry.key, entry]))

export const measureOf = (key: string): Measure | null => BY_KEY.get(key) ?? null

/** The measures one source rebuilds. */
export const measuresOfSource = (source: MeasureSource): Measure[] => MEASURES.filter((entry) => entry.source === source)

/** A measure key as the facts keep it: lower-case dotted words (`orders.lines_in`), up to 100 characters (the DB's rule). */
export const MEASURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** The lowest level a measure is read at for a place filter: a line when one is named and the measure keeps lines, else its first level. */
export function levelFor(entry: Measure, place: { readonly lineId?: string | null | undefined }): MeasureLevel {
  if (place.lineId && entry.levels.includes('LINE')) return 'LINE'
  return entry.levels[0]!
}
