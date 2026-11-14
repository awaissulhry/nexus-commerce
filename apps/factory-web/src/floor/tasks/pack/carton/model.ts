import type { QueueItem } from '../../../queue/model'
import { codeKey } from '../../shared/as-of'
import type { TaskProblem } from '../../shared/task-api'
import type { PackLine } from '../api'
import type { Bench, BenchCarton, BenchPackaging } from './api'

/**
 * Scan into the carton (B-W2b-387; design floor.pack "Scan into the carton"; LOG-007, LOG-003, LOG-010, LOG-013), as rules
 * without fetching or React — the container asks, these decide, the tests hold them:
 *
 *   grid       the size grid, ordered against packed, live: per style and colour each size's packed of ordered, and the
 *              cells a batch label may be (the packer taps one when the label names no size)
 *   cartons    each carton as the bench shows it: "Carton 2 of 3" once closed (open: its place), its packaging, weights,
 *              contents by colour and size with their batch, its marks printed or due again, the one scans go into
 *   left       what packing still needs before Packed, in codes the view words (never the API's English)
 *   main       the step's one main action: Close carton, Print the marks again, or Packed
 *   refusal    a refused scan's code (`refusal/<CODE>`), the one the screen words big and clear
 *   kept       the scans of this shipment the tablet keeps while the network is gone, and those refused when sent
 *   close      Close carton's choices: the packaging (its own, the suggested default, the only one) and the weight
 */

// ---- the size grid ----------------------------------------------------------------------------------------------------------

export type GridState = 'todo' | 'part' | 'done'

export interface GridCell {
  readonly size: string
  /** The work order cells of this colour and size (a scan of a batch label names one). */
  readonly cellIds: readonly string[]
  readonly ordered: number
  readonly packed: number
  readonly state: GridState
}

export interface GridRow {
  readonly key: string
  readonly styleCode: string
  readonly colourwayCode: string
  readonly serialTracked: boolean
  /** The batches (lots) of its garments on the shipment. */
  readonly batches: readonly string[]
  /** One per size of the grid's columns; null: this style and colour is not on the shipment in that size. */
  readonly cells: readonly (GridCell | null)[]
}

export interface PackGrid {
  readonly sizes: readonly string[]
  readonly rows: readonly GridRow[]
  readonly ordered: number
  readonly packed: number
}

const stateOf = (ordered: number, packed: number): GridState => (packed >= ordered ? 'done' : packed > 0 ? 'part' : 'todo')

/** Letter sizes in their order (a run of them reads small to large). */
const LETTER_SIZES = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL']

/**
 * The sizes as the grid's columns: numbers small to large, letter sizes in their run, anything else as the lines name them
 * (the bench gives each row's sizes in its lines' order, which two rows need not share).
 */
export function sizeColumns(sizes: readonly string[]): string[] {
  const unique = [...new Set(sizes)]
  if (unique.every((size) => /^\d+(?:[.,]\d+)?$/.test(size))) return [...unique].sort((a, b) => Number.parseFloat(a.replace(',', '.')) - Number.parseFloat(b.replace(',', '.')))
  if (unique.every((size) => LETTER_SIZES.includes(size.toUpperCase()))) return [...unique].sort((a, b) => LETTER_SIZES.indexOf(a.toUpperCase()) - LETTER_SIZES.indexOf(b.toUpperCase()))
  return unique
}

/** The bench's grid with its sizes as columns (`sizeColumns`), each row's cells under them. */
export function packGrid(bench: Pick<Bench, 'grid'>): PackGrid {
  const sizes = sizeColumns(bench.grid.flatMap((row) => row.sizes.map((entry) => entry.size)))
  let ordered = 0
  let packed = 0
  const rows = bench.grid.map((row) => ({
    key: `${row.styleCode}|${row.colourwayCode}`,
    styleCode: row.styleCode,
    colourwayCode: row.colourwayCode,
    serialTracked: row.serialTracked,
    batches: row.batchNumbers,
    cells: sizes.map((size) => {
      const entry = row.sizes.find((cell) => cell.size === size)
      if (!entry) return null
      ordered += entry.ordered
      packed += entry.packed
      return { size, cellIds: entry.cellIds, ordered: entry.ordered, packed: entry.packed, state: stateOf(entry.ordered, entry.packed) }
    }),
  }))
  return { sizes, rows, ordered, packed }
}

/** A cell's name as the floor reads it ("GIA-01 NERO 52": codes, never translated). */
export const cellName = (row: Pick<GridRow, 'styleCode' | 'colourwayCode'>, size: string): string => `${row.styleCode} ${row.colourwayCode} ${size}`

/** The grid cell holding a work order cell, with its row. */
export function gridCellOf(grid: PackGrid, cellId: string): { row: GridRow; cell: GridCell } | null {
  for (const row of grid.rows) for (const cell of row.cells) if (cell?.cellIds.includes(cellId)) return { row, cell }
  return null
}

/**
 * The cells a batch label (its batch or its work order's number) may be on this shipment, with garments still to scan:
 * the packer taps one when the label names no size (SIZE_NEEDED). `lines`: the shipment's lines as packing read them
 * (each names its cell's work order and batch); without them, the grid rows that name the batch.
 */
export function cellsOfBatch(code: string, grid: PackGrid, lines: readonly Pick<PackLine, 'workOrderSizeId' | 'workOrderNumber' | 'batchNumber'>[] | null): string[] {
  const key = codeKey(code)
  const named = lines
    ? new Set(lines.filter((line) => codeKey(line.workOrderNumber) === key || (line.batchNumber !== null && codeKey(line.batchNumber) === key)).map((line) => line.workOrderSizeId))
    : null
  const found: string[] = []
  for (const row of grid.rows) {
    const rowNamed = named === null && row.batches.some((batch) => codeKey(batch) === key)
    for (const cell of row.cells) {
      if (!cell || cell.packed >= cell.ordered) continue
      const ids = named ? cell.cellIds.filter((id) => named.has(id)) : rowNamed ? cell.cellIds : []
      if (ids.length > 0) found.push(ids[0]!)
    }
  }
  return found
}

// ---- the cartons --------------------------------------------------------------------------------------------------------------

export interface CartonContent {
  /** "GIA-01 NERO 52". */
  readonly label: string
  readonly quantity: number
  readonly batch: string | null
  readonly serials: number
}

export interface PackCartonView {
  readonly id: string
  readonly seq: number
  readonly closed: boolean
  /** "n of N" printed on it (closed); null while open. */
  readonly numbered: { readonly n: number; readonly of: number } | null
  /** The shipment's cartons now. */
  readonly count: number
  readonly labelled: boolean
  /** Its marks say what it is now (closed and printed since); `due`: closed, to print again; `none`: open. */
  readonly marks: 'current' | 'due' | 'none'
  /** Scans without a carton named go into it. */
  readonly current: boolean
  readonly packaging: { readonly id: string; readonly name: string; readonly kind: string } | null
  readonly grossKg: string | null
  readonly netKg: string | null
  readonly garments: number
  readonly contents: readonly CartonContent[]
}

export function cartonsOf(bench: Pick<Bench, 'cartons' | 'openCartonId'>): PackCartonView[] {
  const count = bench.cartons.length
  return [...bench.cartons]
    .sort((a, b) => a.seq - b.seq)
    .map((carton) => {
      const contents = new Map<string, { label: string; quantity: number; batch: string | null; serials: number }>()
      for (const content of carton.contents) {
        const label = `${content.styleCode} ${content.colourwayCode} ${content.size}`
        const key = `${label}|${content.batchNumber ?? ''}`
        const entry = contents.get(key) ?? { label, quantity: 0, batch: content.batchNumber, serials: 0 }
        contents.set(key, { ...entry, quantity: entry.quantity + content.quantity, serials: entry.serials + content.serials.length })
      }
      return {
        id: carton.id,
        seq: carton.seq,
        closed: carton.closed,
        numbered: carton.closed && carton.cartonNumber !== null ? { n: carton.cartonNumber, of: carton.cartonCount ?? count } : null,
        count,
        labelled: carton.labelled,
        marks: carton.closed ? (carton.marksCurrent ? 'current' : 'due') : 'none',
        current: carton.id === bench.openCartonId,
        packaging: carton.packagingType,
        grossKg: carton.grossWeightKg,
        netKg: carton.netWeightKg,
        garments: carton.garments,
        contents: [...contents.values()],
      }
    })
}

/** The carton scans go into (null: the next scan opens a new one). */
export const currentCartonOf = (cartons: readonly PackCartonView[]): PackCartonView | null => cartons.find((carton) => carton.current) ?? null

/** A carton's marks code ("SH-00012-2"), as the marks print it: the shipment's number and the carton's. */
export const cartonMarkCode = (shipmentNumber: string, seq: number): string => `${shipmentNumber.replace(/[^\x21-\x7e]/g, '')}-${seq}`

/** The carton of this shipment whose marks code was scanned, or null (the marks carry `<shipment number>-<n>`). */
export function cartonOfMarks(code: string, shipmentNumber: string, cartons: readonly PackCartonView[]): PackCartonView | null {
  const key = codeKey(code)
  return cartons.find((carton) => codeKey(cartonMarkCode(shipmentNumber, carton.seq)) === key) ?? null
}

// ---- what packing still needs, and the step's main action --------------------------------------------------------------------

export type BenchLeft =
  | { readonly kind: 'noLines' }
  | { readonly kind: 'toScan'; readonly count: number }
  | { readonly kind: 'serials' }
  | { readonly kind: 'open'; readonly seqs: readonly number[] }
  | { readonly kind: 'unweighed'; readonly seqs: readonly number[] }
  | { readonly kind: 'empty'; readonly seqs: readonly number[] }
  | { readonly kind: 'marks'; readonly seqs: readonly number[] }

/** What the shipment needs before Packed (the bench's problems and the move to PACKED's: every carton weighed, none empty). */
export function benchLeft(bench: Pick<Bench, 'grid' | 'problems'>, cartons: readonly PackCartonView[]): BenchLeft[] {
  const left: BenchLeft[] = []
  const grid = packGrid(bench)
  if (grid.ordered === 0) left.push({ kind: 'noLines' })
  if (grid.ordered > grid.packed) left.push({ kind: 'toScan', count: grid.ordered - grid.packed })
  if (bench.problems.includes('SERIALS_NOT_IN_CARTONS')) left.push({ kind: 'serials' })
  const open = cartons.filter((carton) => !carton.closed && !carton.labelled && carton.garments > 0).map((carton) => carton.seq)
  if (open.length > 0) left.push({ kind: 'open', seqs: open })
  const unweighed = cartons.filter((carton) => carton.closed && carton.garments > 0 && carton.grossKg === null).map((carton) => carton.seq)
  if (unweighed.length > 0) left.push({ kind: 'unweighed', seqs: unweighed })
  const empty = cartons.filter((carton) => carton.garments === 0 && !carton.labelled).map((carton) => carton.seq)
  if (empty.length > 0) left.push({ kind: 'empty', seqs: empty })
  const marks = cartons.filter((carton) => carton.marks === 'due' && carton.garments > 0).map((carton) => carton.seq)
  if (marks.length > 0) left.push({ kind: 'marks', seqs: marks })
  return left
}

export type BenchMain =
  /** Close the carton scans go into (it has garments): one tap after the pad. */
  | { readonly kind: 'close'; readonly carton: PackCartonView }
  /** Every carton is closed but some marks show an old count: print them again. */
  | { readonly kind: 'marks'; readonly seqs: readonly number[] }
  /** Nothing left: the shipment is packed. */
  | { readonly kind: 'packed' }
  /** Nothing to do with one tap: why (the first thing left, or "scan a garment"). */
  | { readonly kind: 'none'; readonly why: BenchLeft | null }

export function benchMain(cartons: readonly PackCartonView[], left: readonly BenchLeft[]): BenchMain {
  const current = currentCartonOf(cartons)
  if (current && current.garments > 0) return { kind: 'close', carton: current }
  // Another open carton with garments (one a take-out opened again): close that one.
  const open = cartons.find((carton) => !carton.closed && !carton.labelled && carton.garments > 0)
  if (open) return { kind: 'close', carton: open }
  const marks = left.find((item) => item.kind === 'marks')
  if (marks && left.every((item) => item.kind === 'marks')) return { kind: 'marks', seqs: marks.seqs }
  if (left.length === 0) return { kind: 'packed' }
  return { kind: 'none', why: left.find((item) => item.kind !== 'marks') ?? left[0] ?? null }
}

// ---- a refused scan -----------------------------------------------------------------------------------------------------------

/** The bench's refusals the floor words itself (factory-domain shipping/cartons/rules CARTON_REFUSALS). */
export const CARTON_REFUSALS = [
  'UNKNOWN_CODE',
  'WRONG_BATCH',
  'WRONG_STYLE',
  'WRONG_COLOUR',
  'WRONG_SIZE',
  'EXTRA_PIECE',
  'SERIAL_NEEDED',
  'SIZE_NEEDED',
  'NOT_RELEASED',
  'NOT_FOR_ORDER',
  'OTHER_SHIPMENT',
  'ALREADY_PACKED',
  'NOT_IN_CARTON',
  'ON_HOLD',
  'QUALITY_HOLD',
  'NOT_DRAFT',
  'CARTON_CLOSED',
  'CARTON_LABELLED',
  'TOO_MANY_CARTONS',
  'EMPTY_CARTON',
  'NOT_SCANNED',
  'PACKAGING_NEEDED',
  'PACKAGING_NOT_PARCEL',
  'PACKAGING_OFF',
] as const
export type CartonRefusalCode = (typeof CARTON_REFUSALS)[number]

/** A refusal's code the floor words, or null (another refusal: the screen says it is refused, in its own words). */
export function refusalCodeOf(code: string | null | undefined): CartonRefusalCode | null {
  return code && (CARTON_REFUSALS as readonly string[]).includes(code) ? (code as CartonRefusalCode) : null
}

/** The code of a refused write's problem, when it is the bench's. */
export const problemRefusal = (problem: TaskProblem): CartonRefusalCode | null => (problem.kind === 'refused' ? refusalCodeOf(problem.code) : null)

/** A hold's reason code (factory-db ShipmentHoldReason) the floor words; another code reads as "a hold". */
export const HOLD_REASONS = ['CREDIT', 'DEPOSIT', 'BALANCE_UNPAID', 'QUALITY', 'CUSTOMER_REQUEST', 'OTHER'] as const
export type HoldReason = (typeof HOLD_REASONS)[number]
export const holdReasonOf = (reason: string): HoldReason => ((HOLD_REASONS as readonly string[]).includes(reason) ? (reason as HoldReason) : 'OTHER')

/**
 * What the last scan did, said big beside the scan field (never a toast): a garment in (its size's count after it), out, kept
 * on the tablet, refused by its code, a batch label that names no size (the grid's cells to tap), a carton's own marks.
 * `seq` grows with every scan, so the same words twice still flash.
 */
export type FlashBody = { readonly code: string } & (
  | { readonly kind: 'in'; readonly cell: string; readonly carton: number; readonly newCarton: boolean; readonly packed: number; readonly ordered: number }
  | { readonly kind: 'out'; readonly cell: string; readonly carton: number; readonly reopened: boolean }
  | { readonly kind: 'kept' }
  | { readonly kind: 'refused'; readonly refusal: CartonRefusalCode | null }
  | { readonly kind: 'chooseSize'; readonly cellIds: readonly string[] }
  | { readonly kind: 'cartonLabel'; readonly carton: number }
  | { readonly kind: 'needsNetwork' }
)
export type ScanFlash = { readonly seq: number } & FlashBody

/** A garment in, from the scan's answer: its cell's name and count on the grid after it. */
export function inFlash(seq: number, code: string, grid: PackGrid, scan: { readonly cellId: string; readonly cartonSeq: number; readonly newCarton: boolean }): ScanFlash {
  const found = gridCellOf(grid, scan.cellId)
  return { seq, code, kind: 'in', cell: found ? cellName(found.row, found.cell.size) : '', carton: scan.cartonSeq, newCarton: scan.newCarton, packed: found?.cell.packed ?? 0, ordered: found?.cell.ordered ?? 0 }
}

// ---- the scans the tablet keeps ---------------------------------------------------------------------------------------------

export interface KeptScan {
  readonly id: string
  readonly code: string
  readonly at: string
  /** Refused when it was sent: the bench's code (null: another refusal). */
  readonly refusal: CartonRefusalCode | null
}

/** This shipment's scans on the tablet: those waiting for the network, and those the office refused when they arrived. */
export function keptScans(items: readonly QueueItem[], shipmentId: string): { waiting: KeptScan[]; refused: KeptScan[] } {
  const own = items.filter((item) => item.kind === 'shipping.carton.scan' && item.payload.shipmentId === shipmentId)
  const view = (item: QueueItem): KeptScan => ({ id: item.clientEventId, code: String(item.payload.code ?? ''), at: item.occurredAt, refusal: refusalCodeOf(item.refusal?.code) })
  return { waiting: own.filter((item) => item.state === 'waiting').map(view), refused: own.filter((item) => item.state === 'refused').map(view) }
}

/** A queued scan of this shipment was recorded (or refused) since the last look: the bench is read again. */
export const settledSince = (before: readonly QueueItem[], after: readonly QueueItem[], shipmentId: string): boolean =>
  before.some((item) => item.kind === 'shipping.carton.scan' && item.payload.shipmentId === shipmentId && item.state === 'waiting' && after.find((next) => next.clientEventId === item.clientEventId)?.state !== 'waiting')

// ---- Close carton -------------------------------------------------------------------------------------------------------------

export interface CloseChoice {
  readonly cartonId: string
  readonly seq: number
  readonly packagingId: string | null
  /** Kilograms on the pad; null: not typed yet. */
  readonly weight: number | null
}

/** Close carton opens with the carton's own packaging, else the suggested default, else the only one in use. */
export function closeChoice(carton: Pick<PackCartonView, 'id' | 'seq' | 'packaging' | 'grossKg'>, bench: Pick<Bench, 'packagingTypes' | 'suggestedPackagingTypeId'>): CloseChoice {
  const inUse = (id: string | null | undefined) => (id && bench.packagingTypes.some((type) => type.id === id) ? id : null)
  const packagingId = inUse(carton.packaging?.id) ?? inUse(bench.suggestedPackagingTypeId) ?? (bench.packagingTypes.length === 1 ? bench.packagingTypes[0]!.id : null)
  return { cartonId: carton.id, seq: carton.seq, packagingId, weight: carton.grossKg === null ? null : Number.parseFloat(carton.grossKg) }
}

/** Why Close carton waits: no packaging chosen (and none in use), no weight typed. */
export function closeHeld(choice: CloseChoice, types: readonly BenchPackaging[]): 'noPackaging' | 'packaging' | 'weight' | null {
  if (types.length === 0) return 'noPackaging'
  if (!choice.packagingId) return 'packaging'
  if (choice.weight === null || !(choice.weight > 0)) return 'weight'
  return null
}

/** Heavier than the packaging takes (its most weight), as the API warns. */
export function overweight(choice: CloseChoice, types: readonly BenchPackaging[]): string | null {
  const type = types.find((entry) => entry.id === choice.packagingId)
  if (!type?.maxWeightKg || choice.weight === null) return null
  return choice.weight > Number.parseFloat(type.maxWeightKg) ? type.maxWeightKg : null
}

/** The marks of a closed carton, as Close carton answered: printed (with its jobs), or why not. */
export interface MarksNote {
  readonly cartonId: string
  readonly seq: number
  readonly n: number
  readonly of: number
  readonly printed: boolean
  readonly jobIds: readonly string[]
  /** The print problem's code (the API's error code: validation_failed, invalid_state, forbidden, conflict …). */
  readonly problem: string | null
  readonly overweight: boolean
}

/** A print problem's code the floor words, else 'other'. */
export const MARKS_PROBLEMS = ['validation_failed', 'invalid_state', 'forbidden', 'conflict'] as const
export const marksProblemOf = (code: string | null): (typeof MARKS_PROBLEMS)[number] | 'other' => (code && (MARKS_PROBLEMS as readonly string[]).includes(code) ? (code as (typeof MARKS_PROBLEMS)[number]) : 'other')

/** The carton's facts for its marks preview (what the floor knows of the marks: never the address or the order). */
export function marksFacts(carton: Pick<BenchCarton, 'contents' | 'garments'>): { styles: string; sizes: string; batches: string } {
  const unique = (values: readonly string[]) => [...new Set(values)]
  return {
    styles: unique(carton.contents.map((content) => `${content.styleCode} ${content.colourwayCode}`)).join(', '),
    sizes: unique(carton.contents.map((content) => content.size)).join(', '),
    batches: unique(carton.contents.flatMap((content) => (content.batchNumber ? [content.batchNumber] : []))).join(', '),
  }
}
