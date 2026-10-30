import type { ScanRead } from '../../scan/scan-model'
import { codeKey } from '../shared/as-of'
import type { Labels, PackLine, PackParcel, Packing, PackingRow } from './api'

/**
 * The packing bench's rules (SCR-098; design floor.pack; LOG-002, LOG-039, QHS-073): no fetching, no React — the
 * container asks, these decide, the tests hold them.
 *
 *   cells       a shipment's garments per work order cell (style · colour · size): planned, in a carton, serials
 *   cartons     its parcels with what each holds by size, weighed (= closed) or open
 *   current     the carton a scan goes into: the one picked, else the last open one, else none (the scan adds one)
 *   scan        what a code scanned at the bench is: a serial label, a batch's garment label (or its work order's
 *               number), a shipment's pack slip, or nothing of this shipment — with the reason in the bench's words
 *   left        what packing still needs, in codes the view says in words (never the API's English)
 *   documents   what the station prints once packed, and why each part waits (the office issues the DDT and buys the
 *               labels; a station without its printer)
 */

// ---- cells: a shipment's garments per work order cell ------------------------------------------------------------------

export interface PackCell {
  /** The work order cell (colour × size of a work order). */
  readonly id: string
  readonly styleCode: string
  readonly styleName: string
  readonly colourwayCode: string
  readonly size: string
  readonly batchNumber: string | null
  readonly workOrderNumber: string
  readonly serialTracked: boolean
  /** Garments of the cell on the shipment. */
  readonly planned: number
  /** Of them, in a carton. */
  readonly packed: number
  /** Serials packed (serial-tracked cells). */
  readonly serials: number
  /** A line of the cell not yet in a carton (the next garment comes from it), or null. */
  readonly looseLineId: string | null
  readonly loose: number
}

/** Colour and size as the floor reads them ("RED 52": codes, never translated). */
export const cellLabel = (cell: Pick<PackCell, 'colourwayCode' | 'size'>): string => `${cell.colourwayCode} ${cell.size}`

export function cellsOf(lines: readonly PackLine[]): PackCell[] {
  const byCell = new Map<string, PackLine[]>()
  for (const line of lines) byCell.set(line.workOrderSizeId, [...(byCell.get(line.workOrderSizeId) ?? []), line])
  return [...byCell.entries()].map(([id, group]) => {
    const first = group[0]!
    const loose = group.filter((line) => line.parcelId === null)
    return {
      id,
      styleCode: first.styleCode,
      styleName: first.styleName,
      colourwayCode: first.colourwayCode,
      size: first.size,
      batchNumber: first.batchNumber,
      workOrderNumber: first.workOrderNumber,
      serialTracked: first.serialTracked,
      planned: group.reduce((sum, line) => sum + line.quantity, 0),
      packed: group.filter((line) => line.parcelId !== null).reduce((sum, line) => sum + line.quantity, 0),
      serials: group.reduce((sum, line) => sum + line.serials.length, 0),
      looseLineId: loose[0]?.id ?? null,
      loose: loose.reduce((sum, line) => sum + line.quantity, 0),
    }
  })
}

/** The size grid: per style and colour, each size's packed of planned (the design's "ordered vs packed", live). */
export interface PackGridRow {
  readonly key: string
  readonly label: string
  readonly sizes: readonly { readonly size: string; readonly planned: number; readonly packed: number }[]
}

export function sizeGrid(cells: readonly PackCell[]): { sizes: string[]; rows: PackGridRow[] } {
  const sizes: string[] = []
  for (const cell of cells) if (!sizes.includes(cell.size)) sizes.push(cell.size)
  const rows = new Map<string, { label: string; cells: PackCell[] }>()
  for (const cell of cells) {
    const key = `${cell.styleCode}|${cell.colourwayCode}`
    const row = rows.get(key) ?? { label: `${cell.styleCode} · ${cell.colourwayCode}`, cells: [] }
    row.cells.push(cell)
    rows.set(key, row)
  }
  return {
    sizes,
    rows: [...rows.entries()].map(([key, row]) => ({
      key,
      label: row.label,
      sizes: sizes.map((size) => {
        const own = row.cells.filter((cell) => cell.size === size)
        return { size, planned: own.reduce((sum, cell) => sum + cell.planned, 0), packed: own.reduce((sum, cell) => sum + cell.packed, 0) }
      }),
    })),
  }
}

/** The batches on the shipment (the release line names them). */
export const batchesOf = (lines: readonly PackLine[]): string[] => [...new Set(lines.flatMap((line) => (line.batchNumber ? [line.batchNumber] : [])))]

// ---- cartons -------------------------------------------------------------------------------------------------------------

export interface PackCarton {
  readonly id: string
  readonly version: number
  readonly seq: number
  /** Kilograms as the API keeps them (a decimal string); null: not weighed yet (open). */
  readonly weightKg: string | null
  readonly labelled: boolean
  readonly trackingNumber: string | null
  readonly garments: number
  /** What it holds, by colour and size ("RED 52" × 3). */
  readonly contents: readonly { readonly label: string; readonly quantity: number; readonly serials: number }[]
}

export function cartonsOf(parcels: readonly PackParcel[], lines: readonly PackLine[]): PackCarton[] {
  return [...parcels]
    .sort((a, b) => a.seq - b.seq)
    .map((parcel) => {
      const own = lines.filter((line) => line.parcelId === parcel.id)
      const contents = new Map<string, { label: string; quantity: number; serials: number }>()
      for (const line of own) {
        const label = cellLabel(line)
        const entry = contents.get(label) ?? { label, quantity: 0, serials: 0 }
        contents.set(label, { label, quantity: entry.quantity + line.quantity, serials: entry.serials + line.serials.length })
      }
      return {
        id: parcel.id,
        version: parcel.version,
        seq: parcel.seq,
        weightKg: parcel.grossWeightKg,
        labelled: parcel.trackingNumber !== null || parcel.labelledAt !== null,
        trackingNumber: parcel.trackingNumber,
        garments: own.reduce((sum, line) => sum + line.quantity, 0),
        contents: [...contents.values()],
      }
    })
}

/** The carton a scan goes into: the one picked (when it can still take garments), else the last open one, else none. */
export function currentCarton(cartons: readonly PackCarton[], picked: string | null): PackCarton | null {
  const pickedOne = picked ? cartons.find((carton) => carton.id === picked && !carton.labelled) : undefined
  if (pickedOne) return pickedOne
  return [...cartons].reverse().find((carton) => carton.weightKg === null && !carton.labelled) ?? null
}

/** A weight in kilograms as the API takes it (≤ 4 decimals, above 0), from the pad's number. */
export function weightText(kg: number): string | null {
  const rounded = Math.round(kg * 100) / 100
  if (!Number.isFinite(rounded) || rounded <= 0) return null
  return String(rounded)
}

/** A kept weight back as the pad's number. */
export const weightValue = (text: string | null): number | null => (text === null ? null : Number.parseFloat(text))

// ---- what packing still needs --------------------------------------------------------------------------------------------

export type LeftItem =
  | { readonly kind: 'noLines' }
  | { readonly kind: 'loose'; readonly count: number }
  | { readonly kind: 'noCartons' }
  | { readonly kind: 'unweighed'; readonly seqs: readonly number[] }
  | { readonly kind: 'empty'; readonly seqs: readonly number[] }
  | { readonly kind: 'serials'; readonly count: number }

/** What the shipment still needs before it is packed (the API's guard, in codes): empty = Packing done. */
export function packingLeft(lines: readonly PackLine[], cartons: readonly PackCarton[]): LeftItem[] {
  const left: LeftItem[] = []
  if (lines.length === 0) left.push({ kind: 'noLines' })
  const loose = lines.filter((line) => line.parcelId === null).reduce((sum, line) => sum + line.quantity, 0)
  if (loose > 0) left.push({ kind: 'loose', count: loose })
  if (cartons.length === 0) left.push({ kind: 'noCartons' })
  const unweighed = cartons.filter((carton) => carton.weightKg === null).map((carton) => carton.seq)
  if (unweighed.length > 0) left.push({ kind: 'unweighed', seqs: unweighed })
  const empty = cartons.filter((carton) => carton.garments === 0).map((carton) => carton.seq)
  if (empty.length > 0) left.push({ kind: 'empty', seqs: empty })
  const serials = lines.filter((line) => line.serialTracked).reduce((sum, line) => sum + Math.max(0, line.quantity - line.serials.length), 0)
  if (serials > 0) left.push({ kind: 'serials', count: serials })
  return left
}

// ---- what a scanned code is ------------------------------------------------------------------------------------------------

export type ScanTarget =
  /** A shipment's pack slip (its number): open it. */
  | { readonly kind: 'shipment'; readonly row: PackingRow }
  /** A serial label: the lookup says its cell. */
  | { readonly kind: 'serial'; readonly code: string }
  /** A batch-tracked garment's label (its batch, or its work order's number): one garment of the cell into the carton. */
  | { readonly kind: 'garment'; readonly cell: PackCell }
  /** A serial-tracked style's batch label: each garment is scanned by its serial. */
  | { readonly kind: 'serialTracked'; readonly cell: PackCell }
  /** Every garment of that batch on this shipment is in a carton already. */
  | { readonly kind: 'batchDone'; readonly code: string }
  /** Nothing of this shipment (another one's, a typo, another factory's label). */
  | { readonly kind: 'unknown'; readonly code: string }

/**
 * What a code scanned at the bench is, for the shipment open (null: none open). A shipment's number opens it; a serial
 * label goes to the serial lookup; a batch number or work order number names a cell of the shipment (the first with a
 * garment not in a carton yet). Codes are compared in any case, without spaces.
 */
export function scanTarget(read: ScanRead, packing: { lines: readonly PackLine[] } | null, rows: readonly PackingRow[]): ScanTarget {
  const key = codeKey(read.code)
  const row = rows.find((entry) => codeKey(entry.number) === key)
  if (row) return { kind: 'shipment', row }
  if (!packing) return { kind: 'unknown', code: read.code }
  if (read.kind === 'label' && read.type === 'serial') return { kind: 'serial', code: read.code }
  if (read.kind === 'otherFactory' || read.kind === 'typo') return { kind: 'unknown', code: read.code }
  const cells = cellsOf(packing.lines)
  const named = cells.filter((cell) => (cell.batchNumber !== null && codeKey(cell.batchNumber) === key) || codeKey(cell.workOrderNumber) === key)
  if (named.length === 0) return { kind: 'unknown', code: read.code }
  const open = named.find((cell) => cell.loose > 0)
  if (!open) return { kind: 'batchDone', code: read.code }
  if (open.serialTracked) return { kind: 'serialTracked', cell: open }
  return { kind: 'garment', cell: open }
}

/** Why a scanned serial cannot go in (the lookup's facts), or null: it can. */
export type SerialRefusal = 'notReleased' | 'otherShipment' | 'already' | 'notThisShipment' | 'void' | 'shipped'

export function serialRefusal(serial: { status: string; workOrderSizeId: string; shipmentLineId: string | null }, lines: readonly PackLine[]): SerialRefusal | null {
  if (serial.status === 'VOID') return 'void'
  if (serial.status === 'SHIPPED') return 'shipped'
  if (serial.shipmentLineId !== null) return lines.some((line) => line.id === serial.shipmentLineId) ? 'already' : 'otherShipment'
  if (serial.status !== 'RELEASED') return 'notReleased'
  if (!lines.some((line) => line.workOrderSizeId === serial.workOrderSizeId)) return 'notThisShipment'
  return null
}

/** The API's English refusal of a serial, read back as the bench's code (a fallback when the lookup was not allowed). */
export function serialRefusalOfMessage(message: string): SerialRefusal | 'noRoom' | null {
  if (/only garments quality released are packed/i.test(message)) return 'notReleased'
  if (/packed in another shipment/i.test(message)) return 'otherShipment'
  if (/in this shipment already/i.test(message)) return 'already'
  if (/left without a serial/i.test(message)) return 'noRoom'
  return null
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
export function unpackHeld(cartons: readonly PackCarton[], packing: Pick<Packing, 'documents'>): 'labelled' | 'ddt' | null {
  if (cartons.some((carton) => carton.labelled)) return 'labelled'
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

export interface PackShipment {
  readonly id: string
  readonly number: string
  readonly status: Packing['status']
  readonly carrier: string | null
  readonly transportBy: Packing['transportBy']
  readonly garments: number
  readonly packed: number
  readonly batches: readonly string[]
  readonly cells: readonly PackCell[]
  readonly grid: { readonly sizes: readonly string[]; readonly rows: readonly PackGridRow[] }
  readonly cartons: readonly PackCarton[]
  /** The carton a scan goes into (null: the next scan adds one; always null once packed). */
  readonly current: PackCarton | null
  readonly left: readonly LeftItem[]
}

export function shipmentModel(packing: Packing, picked: string | null): PackShipment {
  const cells = cellsOf(packing.lines)
  const cartons = cartonsOf(packing.parcels, packing.lines)
  return {
    id: packing.id,
    number: packing.number,
    status: packing.status,
    carrier: carrierOf(packing.carrierCode),
    transportBy: packing.transportBy,
    garments: packing.garments,
    packed: cells.reduce((sum, cell) => sum + cell.packed, 0),
    batches: batchesOf(packing.lines),
    cells,
    grid: sizeGrid(cells),
    cartons,
    current: packing.status === 'DRAFT' ? currentCarton(cartons, picked) : null,
    left: packingLeft(packing.lines, cartons),
  }
}
