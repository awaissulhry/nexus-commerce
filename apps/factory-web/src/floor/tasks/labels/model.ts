import type { LabelBlock, LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import type { ScanRead } from '../../scan/scan-model'
import type { JobStatus, LabelPrinter, LabelsView, PrintedLine, RenderedLabel, Tracking, ViewCell } from './api'

/**
 * The garment labels' rules at the final operation (SCR-096; design floor.labels), pure: what a scan opens, each size's
 * place on the pad (what is left to label), the certificate gate of the picked size in words, which print the screen
 * offers and why one is held, the printer it prints on, the print jobs' states, and the label as the DS LabelPreview
 * draws it. No money; no person; the batch or serial as the style says (MES-076).
 */

/** What a code scanned on this screen asks: the office's lookup, a badge (switch person), or a code that is none of ours. */
export type LabelsScan = { kind: 'lookup'; code: string } | { kind: 'badge'; code: string } | { kind: 'notHere'; code: string; why: 'otherLabel' | 'otherFactory' | 'typo' }

export function labelsScan(read: ScanRead): LabelsScan {
  switch (read.kind) {
    case 'badge':
      return { kind: 'badge', code: read.code }
    case 'otherFactory':
      return { kind: 'notHere', code: read.code, why: 'otherFactory' }
    case 'typo':
      return { kind: 'notHere', code: read.code, why: 'typo' }
    case 'free':
      // A traveller's work order number as the office prints it, typed or scanned.
      return { kind: 'lookup', code: read.code }
    case 'label':
      return read.type === 'bundle' || read.type === 'serial' || read.type === 'workOrder' || read.type === 'batch' ? { kind: 'lookup', code: read.code } : { kind: 'notHere', code: read.code, why: 'otherLabel' }
  }
}

// ---- refusals in our words -------------------------------------------------------------------------------------------------

/** The label rules this screen says in its own words (`refusal.<CODE>.title|body` of floor-labels); others keep the API's. */
export const WORDED_REFUSALS = [
  'FLOOR_NOT_READY',
  'WORK_ORDER_NOT_OPEN',
  'NO_LABEL_TEMPLATE',
  'NO_BATCH_NUMBER',
  'NO_FINAL_OPERATION',
  'NOTHING_FINISHED',
  'NOTHING_TO_LABEL',
  'MORE_THAN_FINISHED',
  'CERTIFICATE',
  'TEMPLATE_NOT_ACTIVE',
  'LABEL_NOT_PRINTABLE',
  'NO_PRINTER',
  'MORE_THAN_PRINTED',
  'SERIAL_VOID',
  'SERIAL_SHIPPED',
] as const
export const isWorded = (code: string): boolean => (WORDED_REFUSALS as readonly string[]).includes(code)

// ---- the sizes ---------------------------------------------------------------------------------------------------------------

export interface SizeModel {
  id: string
  size: string
  colourwayCode: string
  colourwayName: string
  /** Good garments at the final operation; null: the routing has no scanned operation. */
  finished: number | null
  labelled: number
  reprinted: number
  toLabel: number
  overLabelled: number
  /** The gate (certificate) and every other label rule say this size prints today. */
  printable: boolean
}

export interface ColourGroup {
  code: string
  name: string
  sizes: SizeModel[]
}

const sizeOf = (cell: ViewCell): SizeModel => ({
  id: cell.workOrderSizeId,
  size: cell.size,
  colourwayCode: cell.colourwayCode,
  colourwayName: cell.colourwayName,
  finished: cell.finished,
  labelled: cell.labelled,
  reprinted: cell.reprinted,
  toLabel: cell.toLabel,
  overLabelled: cell.overLabelled,
  printable: cell.printable && cell.refusal === null && cell.gate.outcome !== 'refused',
})

/** The pad: one group of size buttons per colour, in the work order's order. */
export function colourGroups(cells: readonly ViewCell[]): ColourGroup[] {
  const groups = new Map<string, ColourGroup>()
  for (const cell of cells) {
    const group = groups.get(cell.colourwayCode) ?? { code: cell.colourwayCode, name: cell.colourwayName, sizes: [] }
    group.sizes.push(sizeOf(cell))
    groups.set(cell.colourwayCode, group)
  }
  return [...groups.values()]
}

/** The size the screen opens on: the scanned one, else the first with something to label, else the first. */
export function firstCell(cells: readonly ViewCell[], wanted: string | null): string | null {
  if (wanted && cells.some((cell) => cell.workOrderSizeId === wanted)) return wanted
  return (cells.find((cell) => cell.toLabel > 0) ?? cells[0])?.workOrderSizeId ?? null
}

// ---- the certificate gate of the picked size ----------------------------------------------------------------------------------

export type GateModel =
  /** Green: the certificate in force covers this style, colour and size today. */
  | { kind: 'covered'; standard: string; ppeClass: string | null; number: string; validTo: string }
  /** No certificate is asked for this style (not a PPE). */
  | { kind: 'notRequired' }
  /** Red: the certificate gate or another label rule refuses this size today (its code; the API's words as data). */
  | { kind: 'refused'; code: string; message: string; fix: string }

export function gateOf(cell: ViewCell): GateModel {
  if (cell.refusal) return { kind: 'refused', code: cell.refusal.code, message: cell.refusal.message, fix: cell.refusal.fix }
  if (cell.gate.outcome === 'refused') return { kind: 'refused', code: 'CERTIFICATE', message: cell.gate.words, fix: '' }
  if (cell.gate.outcome === 'covered' && cell.gate.certificate) {
    const certificate = cell.gate.certificate
    return { kind: 'covered', standard: certificate.standard, ppeClass: certificate.ppeClass, number: certificate.number, validTo: certificate.validTo }
  }
  return { kind: 'notRequired' }
}

// ---- the printer -------------------------------------------------------------------------------------------------------------

export type PrinterChoice =
  /** The site's only label printer that takes this label: no question asked. */
  | { kind: 'one'; printer: LabelPrinter }
  /** Several take it: the person picks one (kept for the visit). */
  | { kind: 'pick'; printers: LabelPrinter[]; picked: LabelPrinter | null }
  /** None at this site takes the label's size: printing waits for the office. */
  | { kind: 'none'; others: number }

export function printerChoice(printers: readonly LabelPrinter[], picked: string | null): PrinterChoice {
  const holding = printers.filter((printer) => printer.holdsLabel)
  if (holding.length === 0) return { kind: 'none', others: printers.length }
  if (holding.length === 1) return { kind: 'one', printer: holding[0]! }
  return { kind: 'pick', printers: holding, picked: holding.find((printer) => printer.id === picked) ?? null }
}

/** The printer a print names: null asks the API's own choice (the site's only one). */
export function printerIdOf(choice: PrinterChoice): string | null {
  return choice.kind === 'pick' ? (choice.picked?.id ?? null) : choice.kind === 'one' ? choice.printer.id : null
}

// ---- what the screen offers ----------------------------------------------------------------------------------------------------

/** Why a print waits (a key of floor-labels `held.*`), or null. */
export type HeldKey = 'offline' | 'busy' | 'blocked' | 'refused' | 'noPrinter' | 'pickPrinter' | 'nothingFinished' | 'scanSerial' | 'nothingLeft' | null

export type MainAction =
  /** Print the picked size's finished garments without a label (one tap after the size). */
  | { kind: 'print'; count: number; held: HeldKey }
  /** Everything of the size is labelled: print its batch labels again, with a reason. */
  | { kind: 'reprint'; printed: number; held: HeldKey }
  /** A serial style: the scanned serial's label again, with a reason. */
  | { kind: 'reprintSerial'; serial: string; held: HeldKey }
  /** Nothing to print for this size now (said why). */
  | { kind: 'none'; held: Exclude<HeldKey, null> }

export interface Context {
  readonly online: boolean
  readonly busy: boolean
  readonly blocked: boolean
  readonly printer: PrinterChoice
  readonly tracking: Tracking
  /** The serial scanned on this screen, when it belongs to the picked size. */
  readonly serial: { readonly id: string; readonly serial: string; readonly workOrderSizeId: string } | null
}

/** A print's held reason, first the one that stops everything. */
function heldFor(context: Context): HeldKey {
  if (!context.online) return 'offline'
  if (context.blocked) return 'blocked'
  if (context.busy) return 'busy'
  if (context.printer.kind === 'none') return 'noPrinter'
  if (context.printer.kind === 'pick' && !context.printer.picked) return 'pickPrinter'
  return null
}

export function mainAction(size: SizeModel | null, context: Context): MainAction {
  if (!size) return { kind: 'none', held: 'nothingLeft' }
  const held = heldFor(context)
  if (!size.printable) return size.toLabel > 0 ? { kind: 'print', count: size.toLabel, held: 'refused' } : { kind: 'none', held: 'refused' }
  if (size.toLabel > 0) return { kind: 'print', count: size.toLabel, held }
  if (size.labelled > 0) {
    if (context.tracking === 'BATCH') return { kind: 'reprint', printed: size.labelled, held }
    if (context.serial && context.serial.workOrderSizeId === size.id) return { kind: 'reprintSerial', serial: context.serial.serial, held }
    return { kind: 'none', held: 'scanSerial' }
  }
  return { kind: 'none', held: 'nothingFinished' }
}

/** "Print all": every printable size's labels still to print; held when there is nothing. */
export function printAll(groups: readonly ColourGroup[], context: Context): { count: number; sizes: number; held: HeldKey } {
  const sizes = groups.flatMap((group) => group.sizes).filter((size) => size.printable && size.toLabel > 0)
  const count = sizes.reduce((sum, size) => sum + size.toLabel, 0)
  return { count, sizes: sizes.length, held: heldFor(context) ?? (count === 0 ? 'nothingLeft' : null) }
}

/** Every size is labelled (nothing finished is waiting for a label). */
export const allLabelled = (cells: readonly { toLabel: number }[]): boolean => cells.every((cell) => cell.toLabel === 0)

// ---- the print jobs --------------------------------------------------------------------------------------------------------------

export interface JobModel {
  id: string
  /** The size the labels are for ("NERO 52"), and the serial for a serial style. */
  what: string
  serial: string | null
  copies: number
  status: JobStatus
  /** Why it failed, as the printer said (data). */
  detail: string | null
  version: number
  reprint: boolean
}

export const jobMoving = (status: JobStatus): boolean => status === 'QUEUED' || status === 'SENT'

/** The jobs of a print's answer, one per size (BATCH: N copies) or one per serial. */
export function jobsOf(lines: readonly PrintedLine[], reprint = false): JobModel[] {
  return lines.flatMap((line): JobModel[] => {
    const what = `${line.colourwayCode} ${line.size}`
    if (line.serials.length > 0) return line.serials.flatMap((serial): JobModel[] => (serial.job ? [{ id: serial.job.id, what, serial: serial.serial, copies: serial.job.copies, status: serial.job.status, detail: serial.job.lastError ?? serial.problem, version: serial.job.version, reprint }] : []))
    return line.job ? [{ id: line.job.id, what, serial: null, copies: line.job.copies, status: line.job.status, detail: line.job.lastError ?? line.problem, version: line.job.version, reprint }] : []
  })
}

/** Labels of a print that made no job (the label was refused when it was rendered again after the commit). */
export function problemsOf(lines: readonly PrintedLine[]): { what: string; problem: string }[] {
  return lines.flatMap((line) => {
    const what = `${line.colourwayCode} ${line.size}`
    if (line.serials.length > 0) return line.serials.flatMap((serial) => (!serial.job && serial.problem ? [{ what: `${what} · ${serial.serial}`, problem: serial.problem }] : []))
    return !line.job && line.problem ? [{ what, problem: line.problem }] : []
  })
}

// ---- the label as the DS draws it ---------------------------------------------------------------------------------------------

/** Text fields of the label that print as their lines; the model is the label's heading. */
const HEADING = 'model'

/**
 * The rendered label (compliance/labels' blocks, in the template's order) as the DS LabelPreview's layout: the CE mark
 * and the PPE pictogram as marks (stand-ins until the real artwork exists), the texts in their languages, the care
 * symbols as a row of marks, the batch or serial as a Code 128 barcode. Consecutive marks share a row.
 */
export function previewLayout(label: RenderedLabel, size: { widthMm: string; heightMm: string } | null, name: string): LabelLayout {
  const widthMm = Number(size?.widthMm ?? label.fit?.widthMm ?? 60) || 60
  const heightMm = Number(size?.heightMm ?? label.fit?.heightMm ?? 90) || 90
  const blocks: LabelBlock[] = []
  let marks: LabelBlock[] = []
  const flush = () => {
    if (marks.length === 1) blocks.push(marks[0]!)
    else if (marks.length > 1) blocks.push({ kind: 'row', blocks: marks })
    marks = []
  }
  for (const block of label.blocks) {
    const graphic = block.graphic
    if (graphic?.kind === 'CE') {
      marks.push({ kind: 'mark', id: 'CE', label: graphic.notifiedBodyNumber ? `CE ${graphic.notifiedBodyNumber}` : 'CE', sizeMm: 9 })
      continue
    }
    if (graphic?.kind === 'PICTOGRAM') {
      if (graphic.pictogram !== 'NONE') marks.push({ kind: 'mark', id: graphic.pictogram, label: [graphic.standardCode, graphic.ppeClass].filter(Boolean).join(' ') || graphic.pictogram, sizeMm: 9 })
      continue
    }
    flush()
    if (graphic?.kind === 'CARE') {
      if (graphic.symbols.length > 0) blocks.push({ kind: 'row', blocks: graphic.symbols.map((symbol) => ({ kind: 'mark' as const, id: `care-${symbol.code}`, label: symbol.words || symbol.mark, sizeMm: 6 })) })
      continue
    }
    if (graphic?.kind === 'BARCODE') {
      blocks.push(graphic.value ? { kind: 'barcode', value: graphic.value, heightMm: 7 } : { kind: 'text', text: block.value ?? '—', size: 'md', bold: true, align: 'center' })
      continue
    }
    const text = block.lines.map((line) => line.text).filter(Boolean)
    if (text.length === 0 && block.value) text.push(block.value)
    if (text.length === 0) continue
    if (block.field === HEADING) blocks.push({ kind: 'title', text: text.join(' · '), size: 'md' })
    else for (const line of text) blocks.push({ kind: 'text', text: line, size: 'sm' })
  }
  flush()
  return { name, widthMm, heightMm, paddingMm: 2, blocks }
}

/** The picked size's label view: the API's preview of exactly that cell (another cell's is never shown under its name). */
export const previewFor = (view: LabelsView, cellId: string | null, previewCellId: string | null): RenderedLabel | null => (cellId && cellId === previewCellId ? view.preview : null)
