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
