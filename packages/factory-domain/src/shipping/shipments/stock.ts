/**
 * Shipping from finished-goods stock as well as from the release (B-W2a-48 with B-W2a-12; GAP-003, MES-011, LOG-004).
 * A work order cell's released garments either went into finished goods ("Report finished to stock": PRODUCTION_RECEIPT
 * moves of the work order into a finished-goods place) or wait where quality released them. When a shipment leaves, the
 * garments of each of its cells come out of finished goods first, as far as the work order still has them there, and
 * the rest leaves straight from the release. Pure rules; apps/factory-api's modules/shipping/shipments posts the moves
 * (postMoves, in the shipping command) and modules/production/completion reads what the shipments took.
 *
 *   in stock (of the cell)   the work order's garments of the cell's SKU put into finished goods (receipts less their
 *                            reversals) less those shipments already took out of it
 *   on hand (per place)      the SKU's FINISHED item at each finished-goods place of the site (every work order's)
 *   taken                    min(garments shipped, in stock, Σ on hand), place by place in the order given
 *
 * The batch (the work order) is what the shipment names, so only the cell's own work order's garments are taken: another
 * batch of the same SKU stays where it is. A garment taken from stock is counted once: "Report finished to stock" counts
 * the shipments' garments that did NOT come from stock (`fromRelease`), never both.
 */

export interface StockCell {
  readonly cellId: string
  /** "WO-0001 BLK 52". */
  readonly label: string
  /** Garments of the cell on the shipment that leaves. */
  readonly garments: number
  /** The work order's garments of the cell still in finished goods (never below 0). */
  readonly inStock: number
  /** The SKU's finished-goods places of the site with what each holds now, in the order to take from. */
  readonly places: readonly { readonly locationId: string; readonly code: string; readonly onHand: number }[]
}

export interface StockTake {
  readonly cellId: string
  readonly label: string
  readonly garments: number
  /** Out of finished goods, per place (only places it takes from). */
  readonly fromPlaces: readonly { readonly locationId: string; readonly code: string; readonly quantity: number }[]
  readonly fromStock: number
  /** Straight from the release (never went into stock, or no longer there). */
  readonly fromRelease: number
}

const max0 = (value: number): number => (value > 0 ? value : 0)

/** What each cell of a leaving shipment takes out of finished goods (see the file's comment). */
export function takeFromStock(cells: readonly StockCell[]): StockTake[] {
  return cells.map((cell) => {
    let wanted = Math.min(max0(cell.garments), max0(cell.inStock))
    const fromPlaces: { locationId: string; code: string; quantity: number }[] = []
    for (const place of cell.places) {
      if (wanted === 0) break
      const quantity = Math.min(wanted, max0(place.onHand))
      if (quantity === 0) continue
      fromPlaces.push({ locationId: place.locationId, code: place.code, quantity })
      wanted -= quantity
    }
    const fromStock = fromPlaces.reduce((sum, place) => sum + place.quantity, 0)
    return { cellId: cell.cellId, label: cell.label, garments: cell.garments, fromPlaces, fromStock, fromRelease: max0(cell.garments) - fromStock }
  })
}

/** The work order's garments of a cell still in finished goods: received (net of reversals) less taken by shipments. */
export const cellInStock = (received: number, takenByShipments: number): number => max0(received - takenByShipments)

/**
 * The garments of a cell on shipments that did not come out of finished goods (B-W2a-12's `onShipments` for "Report
 * finished to stock"): every shipment line that is not CANCELLED, less what leaving shipments took from stock.
 */
export const onShipmentsFromRelease = (onShipments: number, takenFromStock: number): number => max0(onShipments - takenFromStock)

/** The note a move out of finished goods carries (the ledger's "why"). */
export const stockMoveNote = (shipmentNumber: string, label: string): string => `Shipped on ${shipmentNumber}: ${label} out of finished goods to the customer.`

// ---- W2b (B-W2b-19): SHIPMENT moves name the shipment's line ----------------------------------------------------------

/** One line of the shipment of a cell: its garments (a cell's garments may sit on several lines, one per parcel). */
export interface CellLine {
  readonly lineId: string
  readonly garments: number
}

/** One SHIPMENT move: out of a place, for a line, so many garments. */
export interface LineTake {
  readonly lineId: string
  readonly locationId: string
  readonly quantity: number
}

/**
 * A cell's take out of finished goods split over its shipment lines (B-W2b-19: a SHIPMENT move names its ShipmentLine):
 * the places in their order, the lines in theirs, never more for a line than its garments. What is left of a line comes
 * from the release (no move).
 */
export function splitTakeByLines(fromPlaces: readonly { readonly locationId: string; readonly quantity: number }[], lines: readonly CellLine[]): LineTake[] {
  const left = lines.map((line) => ({ lineId: line.lineId, room: max0(line.garments) }))
  const takes: LineTake[] = []
  for (const place of fromPlaces) {
    let wanted = max0(place.quantity)
    for (const line of left) {
      if (wanted === 0) break
      const quantity = Math.min(wanted, line.room)
      if (quantity === 0) continue
      const last = takes[takes.length - 1]
      if (last && last.lineId === line.lineId && last.locationId === place.locationId) takes[takes.length - 1] = { ...last, quantity: last.quantity + quantity }
      else takes.push({ lineId: line.lineId, locationId: place.locationId, quantity })
      line.room -= quantity
      wanted -= quantity
    }
  }
  return takes
}

// ---- W2b (B-W2b-19): a carrier-returned shipment back into finished goods (the B-W2a-48 gap) --------------------------

/**
 * A shipment the carrier brought back (RETURNED: Sendcloud's tracking says it went back to the sender) puts its
 * garments back into finished goods once the warehouse has them: one move INTO a finished-goods place per cell, the
 * cell's SKU's FINISHED item, the cell's work order, valued at the item's frozen standard as every finished garment
 * that comes into stock (B-W2a-F7). Once per shipment. The garments stay on the returned shipment's lines (its history),
 * so "Report finished to stock" never counts them twice: the moves are ADJUSTMENTs in (the ledger has no reason of its
 * own for them), apart from PRODUCTION_RECEIPT and from the shipment's SHIPMENT moves out, marked by their key
 * `shipping.carrierReturn:<shipment id>:<n>`; the cell's garments in stock count them in.
 */
export const CARRIER_RETURN_STATES = ['NOT_RETURNED', 'AWAITED', 'RECEIVED'] as const
export type CarrierReturnState = (typeof CARRIER_RETURN_STATES)[number]

/** Where a shipment's carrier return stands: not returned, returned and not received yet, received into stock. */
export const carrierReturnState = (status: string, received: boolean): CarrierReturnState => (received ? 'RECEIVED' : status === 'RETURNED' ? 'AWAITED' : 'NOT_RETURNED')

/** Why a shipment's garments cannot go back into finished goods now (empty: they can). */
export function carrierReturnProblems(facts: { readonly number: string; readonly status: string; readonly received: boolean; readonly garments: number }): string[] {
  if (facts.received) return [`${facts.number}'s garments are back in finished goods already.`]
  if (facts.status !== 'RETURNED') {
    return [`${facts.number} is ${facts.status}: its garments go back into finished goods once the carrier brought it back (RETURNED: the carrier's tracking says so).`]
  }
  if (facts.garments <= 0) return [`${facts.number} has no garments to put back.`]
  return []
}

/** The note of a carrier return's move (the ledger's "why"). */
export const carrierReturnNote = (shipmentNumber: string, label: string, note: string | null): string =>
  `Carrier return of ${shipmentNumber}: ${label} back into finished goods.${note ? ` ${note}` : ''}`
