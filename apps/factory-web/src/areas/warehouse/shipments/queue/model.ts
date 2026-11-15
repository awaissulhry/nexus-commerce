import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { BulkHoldModel } from '../holds/model'
import { words, type Read, type Words } from './shared/depth'
import type { AtRisk, CarrierCard, ProblemList, QueueRisk, QueueRow, SearchPage, ShipToday, SiteDay } from './api'

/**
 * The shipments list in depth, pure (SCR-590 / SCR-591; design warehouse.shipments sh-grid "Rows ▾ views: Ship today
 * (default) · At risk of missing the promise (W2b, LOG-110) · Open · Shipped · All", sh-grid "search by order, tracking
 * number, SSCC, customer PO or serial (W2b, LOG-120)", sh-metrics "Exceptions (W2b)", sh-cutoff): which grid the page draws,
 * the queue's view model, what a risk is called and how loud, the CSV of the picked rows.
 */

/** The rows views this step draws (the others stay the W1 list's). */
export const DEPTH_VIEWS = ['today', 'atRisk', 'exceptions'] as const
export type DepthView = (typeof DEPTH_VIEWS)[number]
export const isDepthView = (rows: string): rows is DepthView => (DEPTH_VIEWS as readonly string[]).includes(rows)

/** A search term the API takes (2 to 80 characters). */
export const SEARCH_MIN = 2
export const isSearch = (q: string): boolean => q.trim().length >= SEARCH_MIN

/** What the page's grid shows: a search (any status), one of this step's views, or the W1 list (null). */
export function gridOf(rows: string, q: string): 'search' | DepthView | null {
  if (isSearch(q)) return 'search'
  return isDepthView(rows) ? rows : null
}

/** The status a rows view narrows a search to (a state view), else every status. */
export function searchStatusOf(rows: string): ShipmentStatus | null {
  return ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'].includes(rows) ? (rows as ShipmentStatus) : null
}

export const RISK_TONE: Record<QueueRisk, 'danger' | 'warning' | 'info' | 'neutral' | 'success'> = {
  LATE: 'danger',
  HELD: 'danger',
  MISSED_CUT_OFF: 'danger',
  AT_RISK: 'warning',
  DUE_TODAY: 'info',
  LATER: 'neutral',
  NO_DATE: 'neutral',
}

export interface QueueDepthModel {
  /** Which grid replaces the W1 list (null: the W1 list). */
  readonly grid: 'search' | DepthView | null
  /** The sites the reader sees (from the at-risk read), the one Ship today reads. */
  readonly sites: readonly SiteDay[] | null
  readonly siteId: string | null
  readonly today: Read<ShipToday>
  readonly atRisk: Read<AtRisk>
  readonly exceptions: Read<ProblemList>
  /** The search's pages so far (null: no search). */
  readonly search: Read<SearchPage> | null
  readonly searchMore: boolean
  /** A cut-off card pressed (`?carrier=`): today's rows of that carrier. */
  readonly carrier: string | null
  readonly hold: BulkHoldModel | null
  readonly mayHold: boolean
  readonly mayManage: boolean
  readonly viewOrders: boolean
  readonly prefix: string
  /** Design cases: the starting selection. */
  readonly selected?: readonly string[]
}

export interface QueueDepthActions {
  onSite?: (siteId: string) => void
  onRetry?: () => void
  onSearchMore?: () => void
  onCarrier?: (carrier: string | null) => void
  onOpen?: (id: string) => void
  onHold?: (picked: readonly { id: string; number: string; status: string }[]) => void
  onHoldReason?: (reason: NonNullable<BulkHoldModel['reason']>) => void
  onHoldText?: (text: string) => void
  onHoldGo?: () => void
  onHoldClose?: () => void
  onExport?: (rows: readonly QueueRow[]) => void
  onPlan?: (salesOrderId: string) => void
}

/** The Exceptions tile's count (the open tracking problems), null while unknown. */
export const exceptionsCount = (model: Pick<QueueDepthModel, 'exceptions'>): number | null => (model.exceptions.state === 'ready' && !model.exceptions.value.truncated ? model.exceptions.value.problems.length : null)

/** The today rows of the pressed card (or all of them). */
export const todayRows = (today: ShipToday, carrier: string | null): QueueRow[] => (carrier ? today.shipments.filter((row) => row.carrierKey === carrier) : today.shipments)

/** A carrier card's name: the carrier, our own van, the customer collects, or none chosen yet. */
export function cardName(card: Pick<CarrierCard, 'transportBy' | 'carrierName' | 'carrierCode'>): Words {
  if (card.transportBy === 'SENDER') return words('carrier.ownVan')
  if (card.transportBy === 'RECIPIENT') return words('carrier.collects')
  if (card.carrierName || card.carrierCode) return words('carrier.named', { name: card.carrierName ?? card.carrierCode ?? '' })
  return words('carrier.none')
}

const cell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The picked queue rows as CSV (Export N): number, status, risk, order, PO, customer, carrier, ship by, parcels, garments, holds. */
export function queueCsv(rows: readonly QueueRow[], say: { header: (column: string) => string; status: (status: string) => string; risk: (risk: QueueRisk) => string; hold: (reason: string) => string }): string {
  const columns = ['number', 'status', 'risk', 'order', 'customerPo', 'customer', 'carrier', 'shipBy', 'parcels', 'garments', 'holds'] as const
  const lines = rows.map((row) => [row.number, say.status(row.status), say.risk(row.risk), row.salesOrderNumber, row.customerRef, row.partyName, row.carrierName ?? row.carrierCode ?? row.transportBy, row.shipBy, row.parcels, row.garments, row.holdReasons.map(say.hold).join(' / ')].map(cell).join(','))
  return [columns.map((column) => cell(say.header(column))).join(','), ...lines].join('\n')
}
