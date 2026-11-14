import type { HoldReason } from '../../../pack/carton/model'

/**
 * A carton on Scan anything (B-W2b-387; design floor.scan "What you scanned": "Carton (W2b)"; LOG-019): the code its marks
 * carry — `<shipment number>-<carton number>` — answers the carton as a packer needs it, from the API's floor view
 * (`GET /shipping/cartons/scan`, shipping.pack): its shipment's number and state, "Carton 2 of 3" or open, packaging and
 * weights, garments by colour and size with the batch, its marks, a hold. Never a customer, an address, a serial or money.
 * Pure: the screen asks, these decide.
 */

/** A code shaped like a carton's marks: something, a hyphen, the carton's number (1 to 99). */
const MARKS_SHAPE = /^.+-(\d{1,2})$/

export function isCartonMarks(code: string): boolean {
  const match = MARKS_SHAPE.exec(code.trim())
  return match !== null && Number.parseInt(match[1]!, 10) >= 1
}

export interface CartonScanCard {
  readonly kind: 'carton'
  /** The code as its marks carry it. */
  readonly code: string
  readonly shipmentNumber: string
  readonly shipmentStatus: 'DRAFT' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'RETURNED' | 'CANCELLED'
  readonly hold: HoldReason | null
  readonly seq: number
  /** "n of N" once closed; null while open. */
  readonly numbered: { readonly n: number; readonly of: number } | null
  readonly cartons: number
  readonly state: 'open' | 'closed' | 'marksDue' | 'labelled'
  readonly packaging: { readonly name: string; readonly kind: string } | null
  readonly grossKg: string | null
  readonly netKg: string | null
  readonly garments: number
  readonly contents: readonly { readonly label: string; readonly quantity: number; readonly batch: string | null; readonly serials: number }[]
}

/** The carton's state as the card's pill says it: a carrier label, marks to print again, closed, or open. */
export function cartonState(carton: { readonly closed: boolean; readonly labelled: boolean; readonly marksCurrent: boolean }): CartonScanCard['state'] {
  if (carton.labelled) return 'labelled'
  if (!carton.closed) return 'open'
  return carton.marksCurrent ? 'closed' : 'marksDue'
}

/** The bench opens a carton's shipment while it is still at the bench (to pack, or packed and waiting for its documents). */
export const opensAtBench = (card: Pick<CartonScanCard, 'shipmentStatus'>): boolean => card.shipmentStatus === 'DRAFT' || card.shipmentStatus === 'PACKED'
