import type { ReadyOrder, ShipmentRow, TransportBy } from '../api'
import type { LiveState } from '../hooks'
import type { PrintOutcome } from '../daily-model'
import type { CutOffCard, Phrase, RowView, ShippingAbilities, TileKey } from '../model'
// B-W2b-410
import type { QueueDepthActions, QueueDepthModel } from '../queue/model'
// B-W2b-412
import type { DispatchListActions, DispatchListModel } from '../end-of-day/list-model'

/** SCR-066 — the shipments list's view model (ShipmentsListView draws it and fetches nothing). */
export interface ShipmentsListModel {
  /** `/w/<company>`. */
  prefix: string
  can: ShippingAbilities
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  rows: RowView
  q: string
  /** A cut-off card's carrier (`?carrier=`): today's rows of that carrier only. */
  carrier: string | null
  /** The grid's rows (today's queue: the open shipments, filtered by the carrier when one is pressed). */
  list: { items: ShipmentRow[] | null; more: boolean; problem: string | null }
  /** The carrier cut-off cards of today's queue; null while unread or when the read failed. */
  cards: CutOffCard[] | null
  /** The tiles' counts (null: unknown). */
  tiles: Record<TileKey, number | null> | null
  /** When the rows were read (ISO). */
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase; detail?: string | null } | null
  /** New shipment (sh-new), when open. */
  create: NewShipmentModel | null
  /** B-W2a-71: Print N DDTs (the selection row), when open. */
  printDdts?: PrintDdtsModel | null
  /** B-W2b-410: Ship today and At risk from the queue, Exceptions, the search, Hold N (null in W1's design cases). */
  depth?: QueueDepthModel | null
  /** B-W2b-412: pickups, End of day, Mark handed over (null in the earlier design cases). */
  dispatch?: DispatchListModel | null
  /** Design cases: the starting selection, the focused row, the keys panel. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
}

export interface NewShipmentModel {
  /** Step 1: which order (released goods not shipped yet); step 2: how many of each colour and size. */
  step: 1 | 2
  /** What can still ship, by sales order; null while reading. */
  orders: ReadyOrder[] | null
  problem: string | null
  salesOrderId: string | null
  /** Typed quantities by work order cell. */
  quantities: Record<string, number>
  transportBy: TransportBy
  carrierCode: string
  serviceCode: string
  busy: boolean
  /** A refused create, said inside the dialog. */
  refused: { words: Phrase; detail?: string | null } | null
  // ── F-OP-121 (order page plan N6): Create shipment… from the order page ──
  /** The order page's mode: `salesOrderId` fixed, the same customer's other open orders beside it (ship together, each with its verdict). */
  together?: boolean
  /** The other orders added to this shipment (only ones their verdict allows; none while several orders are held off). */
  others?: string[]
  // ── end F-OP-121 ──
  /** F-OP-122: "Add this order's garments…" — step 2 only, onto this DRAFT of the same customer (the lines route; DRAFT only). */
  join?: { shipmentId: string; number: string } | null
}

/** B-W2a-71 (design sh-grid selection row "Print 4 DDTs"): the selected shipments' live DDTs on their site's document printer. */
export interface PrintDdtsModel {
  /** The selected rows (those without a live DDT are skipped, said so). */
  ids: string[]
  busy: boolean
  /** One per selected shipment once sent: queued, refused (in words) or skipped. */
  outcomes: PrintOutcome[] | null
}

export interface ShipmentsListActions {
  onRows?: (rows: RowView) => void
  onSearch?: (q: string) => void
  onCarrier?: (carrier: string | null) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
  onNew?: () => void
  onNewClose?: () => void
  onNewOrder?: (salesOrderId: string) => void
  onNewStep?: (step: 1 | 2) => void
  onNewQuantity?: (cellId: string, quantity: number) => void
  onNewAll?: () => void
  onNewDelivery?: (next: { transportBy?: TransportBy; carrierCode?: string; serviceCode?: string }) => void
  onNewCreate?: () => void
  /** F-OP-121: ship together — add (or take off) another order of the customer (only one its verdict allows). */
  onNewOther?: (salesOrderId: string, on: boolean) => void
  // B-W2a-71
  onPrintDdts?: (ids: string[]) => void
  onPrintDdtsGo?: () => void
  onPrintDdtsClose?: () => void
  // B-W2b-410
  depth?: QueueDepthActions
  // B-W2b-412
  dispatch?: DispatchListActions
}
