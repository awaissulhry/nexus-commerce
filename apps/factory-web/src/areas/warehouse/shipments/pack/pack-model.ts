import type { Ddt, Shipment } from '../api'
import type { PackDocument } from '../daily-model'
import type { Loaded } from '../record/record-model'

/**
 * SCR-067-pack — the driver's pack's view model (design warehouse.shipments tab:sh-tab-pack "All documents (one merged
 * PDF)": "one print job for the driver's pack"). ShipmentPackView draws it and fetches nothing.
 */
export interface PackModel {
  /** `/w/<company>`. */
  prefix: string
  /** shipping.view: the page may be read at all. */
  allowed: boolean
  /** files.read: the documents' PDFs can be drawn (without it: the sheet only). */
  readFiles: boolean
  /** The company the person works in. */
  company: string
  /** The sender as its DDT prints it (the company's legal name), else the company's name. */
  sender: string
  shipment: Loaded<Shipment>
  /** The live DDT, once issued. */
  ddt: Pick<Ddt, 'number' | 'documentDate' | 'startAt' | 'fileId'> | null
  /** What goes in the pack, in print order; null while reading. */
  documents: PackDocument[] | null
  /** Each document's PDF by its key: the bytes, or why they could not be read (a message key); absent: reading. */
  files: Record<string, { data: Uint8Array | null; problem: string | null }>
  /** The documents ticked for this print (by key). */
  included: string[]
  readAt: string | null
}

export interface PackActions {
  onToggle?: (key: string) => void
  onRetry?: () => void
}
