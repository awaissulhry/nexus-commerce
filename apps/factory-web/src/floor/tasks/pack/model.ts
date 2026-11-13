import type { ScanRead } from '../../scan/scan-model'
import { codeKey } from '../shared/as-of'
import type { Labels, PackLine, PackParcel, Packing, PackingRow } from './api'

/**
 * The packing bench's rules (SCR-098; design floor.pack; LOG-002, LOG-039, QHS-073): no fetching, no React — the
 * container asks, these decide, the tests hold them. Scan into the carton's own rules (the size grid, the cartons, what
 * is left, Close carton) are B-W2b-387's, in carton/model.ts; here:
 *
 *   scan        what a code scanned at the bench is: a shipment's pack slip (or a carton's marks: its shipment), a
 *               garment's label for the shipment open (the office says what it is), or nothing of this station
 *   documents   what the station prints once packed, and why each part waits (the office issues the DDT and buys the
 *               labels; a station without its printer)
 *   head        the shipment as the bench's strip says it
 */

/** A weight in kilograms as the API takes it (≤ 4 decimals, above 0), from the pad's number. */
export function weightText(kg: number): string | null {
  const rounded = Math.round(kg * 100) / 100
  if (!Number.isFinite(rounded) || rounded <= 0) return null
  return String(rounded)
}

/** The batches on the shipment (the release line names them). */
export const batchesOf = (lines: readonly Pick<PackLine, 'batchNumber'>[]): string[] => [...new Set(lines.flatMap((line) => (line.batchNumber ? [line.batchNumber] : [])))]

// ---- what a scanned code is ------------------------------------------------------------------------------------------------

export type ScanTarget =
  /** A shipment's pack slip (its number), or a carton's marks (`<number>-<n>`: `carton` its number): open it. */
  | { readonly kind: 'shipment'; readonly row: PackingRow; readonly carton: number | null }
  /** A garment's label (a serial, a SKU or barcode, a batch label) for the shipment open: the office says what it is. */
  | { readonly kind: 'garment'; readonly code: string }
  /** Nothing of this station (another factory's label, a misread one, or no shipment open). */
  | { readonly kind: 'unknown'; readonly code: string }

/** The carton number a marks code of this shipment names (`<number>-<n>`), or null. */
function cartonOfMarks(key: string, number: string): number | null {
  const own = codeKey(number)
  if (!key.startsWith(`${own}-`)) return null
  const rest = key.slice(own.length + 1)
  return /^\d{1,2}$/.test(rest) && Number.parseInt(rest, 10) >= 1 ? Number.parseInt(rest, 10) : null
}

/**
 * What a code scanned at the bench is, with a shipment open or not (`open`). A shipment's number opens it, and so do its
 * cartons' marks; with a shipment open any other code of this factory is a garment's label, which the office reads (a
 * serial, a SKU or barcode, a batch or work order number). Codes are compared in any case, without spaces.
 */
export function scanTarget(read: ScanRead, open: boolean, rows: readonly PackingRow[]): ScanTarget {
  const key = codeKey(read.code)
  const row = rows.find((entry) => codeKey(entry.number) === key)
  if (row) return { kind: 'shipment', row, carton: null }
  for (const entry of rows) {
    const carton = cartonOfMarks(key, entry.number)
    if (carton !== null) return { kind: 'shipment', row: entry, carton }
  }
  if (!open || read.kind === 'otherFactory' || read.kind === 'typo') return { kind: 'unknown', code: read.code }
  return { kind: 'garment', code: read.code }
}

// ---- after packing: what the station prints ----------------------------------------------------------------------------------

/** Why a part of the documents waits (null: it can print now). */
export type LabelsHeld = 'notNeeded' | 'officeBuys' | 'noPrinter' | 'noRight' | null
export type DocumentsHeld = 'officeIssues' | 'pdfMissing' | 'noPrinter' | null

export interface DocumentsState {
  readonly labels: { readonly held: LabelsHeld; readonly labelled: number; readonly total: number }
  readonly documents: { readonly held: DocumentsHeld; readonly ddtNumber: string | null; readonly ddtDate: string | null; readonly packingList: boolean }
  /** Something prints now with one tap (Print documents). */
  readonly printable: boolean
}

export function documentsState(packing: Pick<Packing, 'transportBy' | 'documents' | 'settings'>, labels: Pick<Labels, 'labelPrinterId' | 'toLabel' | 'parcels'> | null, can: { printLabels: boolean }): DocumentsState {
  const total = labels?.parcels.length ?? 0
  const labelled = labels?.parcels.filter((parcel) => parcel.trackingNumber !== null).length ?? 0
  const labelsHeld: LabelsHeld =
    packing.transportBy !== 'CARRIER' ? 'notNeeded' : !labels || labels.toLabel > 0 || labelled === 0 ? 'officeBuys' : !labels.labelPrinterId ? 'noPrinter' : !can.printLabels ? 'noRight' : null
  const ddt = packing.documents.ddt
  // The DDT is what must travel (DPR 472/1996): without it nothing prints here; the packing list goes with it.
  const documentsHeld: DocumentsHeld = !ddt ? 'officeIssues' : !packing.settings?.documentPrinterId ? 'noPrinter' : !ddt.fileId && !packing.documents.packingList ? 'pdfMissing' : null
  return {
    labels: { held: labelsHeld, labelled, total },
    documents: { held: documentsHeld, ddtNumber: ddt?.number ?? null, ddtDate: ddt?.documentDate ?? null, packingList: packing.documents.packingList !== null },
    printable: labelsHeld === null || documentsHeld === null,
  }
}

/** Unpacking waits while a carton has a carrier label or the shipment has a live DDT (the API's rule). */
export function unpackHeld(packing: Pick<Packing, 'documents'> & { readonly parcels: readonly Pick<PackParcel, 'trackingNumber' | 'labelledAt'>[] }): 'labelled' | 'ddt' | null {
  if (packing.parcels.some((parcel) => parcel.trackingNumber !== null || parcel.labelledAt !== null)) return 'labelled'
  if (packing.documents.ddt) return 'ddt'
  return null
}

/** A print job is still on its way (read it again). */
export const jobMoving = (status: string): boolean => status === 'QUEUED' || status === 'SENT'

/** The shipments the bench lists: DRAFT ones to pack first, then PACKED ones waiting for their documents. */
export function readyRows(rows: readonly PackingRow[]): PackingRow[] {
  return [...rows].filter((row) => row.status === 'DRAFT' || row.status === 'PACKED').sort((a, b) => (a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === 'DRAFT' ? -1 : 1))
}

// ---- the shipment as the bench shows it ----------------------------------------------------------------------------------

/** A carrier's code as the floor reads it ("brt" → "BRT", "poste_italiane" → "POSTE ITALIANE"). */
export const carrierOf = (code: string | null): string | null => (code ? code.toUpperCase().replace(/_/g, ' ') : null)

/** The shipment on the bench's strip: number, state, carrier (or who carries), cartons, the batches released. */
export interface PackHead {
  readonly id: string
  readonly number: string
  readonly status: Packing['status']
  readonly carrier: string | null
  readonly transportBy: Packing['transportBy']
  readonly cartons: number
  readonly batches: readonly string[]
}

export const headOf = (packing: Packing, cartons = packing.parcels.length): PackHead => ({
  id: packing.id,
  number: packing.number,
  status: packing.status,
  carrier: carrierOf(packing.carrierCode),
  transportBy: packing.transportBy,
  cartons,
  batches: batchesOf(packing.lines),
})
