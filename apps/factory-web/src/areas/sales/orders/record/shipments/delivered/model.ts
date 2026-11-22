import type { DeliveryRow } from './api'

/**
 * The order's deliveries (B-W2b-398; LOG-065, LOG-067), pure. F-OS-104 (order SHIPMENTS tab; 18-lead-settles L5): the card
 * "Delivered (from carrier)" went — each Shipments row draws its delivery in its Dates cell (shipments/rows.ts `datesOf`: delivered
 * and how we know, the carrier's later word, Proof ›, came back). What stays here is the proof's own file.
 */

// ---- B-SA-0xxb / F-SA-266b (10-order-page §6.4 "Viewer: … POD … the thread's ONE viewer"): the proof as the viewer lists it, or null
// — no file for this reader (no files.read on the shipment, none kept yet): the row offers its image (shipping.view), else no door.
export function proofFileOf(row: Pick<DeliveryRow, 'pod'>): { readonly id: string; readonly name: string; readonly contentType: string; readonly sizeBytes: number } | null {
  return row.pod?.file ?? null
}
// ---- end B-SA-0xxb
