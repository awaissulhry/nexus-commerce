import type { Issue } from '../../core/errors'
import { MAX_LABEL_COPIES } from '../../labels/zpl'
import { formatScanId } from '../../numbering/scan-id'
import { NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE, type FloorReadiness } from '../../privacy/readiness'
import { cellLabel } from '../cutting/rules'
import { finalOperationOf, standingKey, standingScans, type ScanFact, type ScanOperation } from '../scans/rules'
import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * Batch or serial at the final operation, and the garment labels behind the certificate gate (B-W1-44; MES-076,
 * PRD-348, QHS-051, PRD-331; PLAN §4.7 stage 13a-labels; Q31; A2 SCR-096 floor.labels): pure rules, figures by hand in
 * serials.vitest.test.ts.
 *
 *   what is finished   the good garments of a cell at the work order's final operation (the last scanned one, B-W1-42's
 *                      finalOperationOf), from whole-garment ACTIVE bundles: per bundle here (finishedBundles: a
 *                      serial's bundle), per cell by the scans module (scanProgressOf)
 *   what is labelled   a BATCH style (Q31 (a), the default): the labels printed for the cell, reprints not counted; a
 *                      SERIAL style (Q31 (b)): the cell's live (not VOID) serials, one label each
 *   to label           finished − labelled, never below 0; more labels than finished garments are never printed
 *                      (planLabels). Labels already printed above what is finished now (an undo or correction at the
 *                      final operation after the print) are shown as `overLabelled`, for the office to sort out
 *   the gate           every label is rendered for its cell on the day (compliance/labels renderLabel with B-W1-12's
 *                      certificate gate); a cell whose label is not printable is refused in the gate's own words
 *                      (gateRefusal), the other cells print: "refused for that size only"
 *   reprint            the same batch number or serial again, with a reason; a BATCH reprint replaces at most the labels
 *                      printed for the cell; a void or shipped serial's label is never printed again
 *   void               a MADE serial (a spoilt label, a garment scrapped after the final operation), with a reason; a
 *                      RELEASED one goes back only through a release reversal (B-W1-45), a SHIPPED one never
 * Every refusal is {code, message, fix, cellId}: the message says what is wrong, the fix ONE thing to do, in words a
 * person at the bench reads (design 02 "a refusal is a full-screen state").
 */

export const GARMENT_TRACKINGS = ['BATCH', 'SERIAL'] as const
export type GarmentTracking = (typeof GARMENT_TRACKINGS)[number]

export const GARMENT_SERIAL_STATUSES = ['MADE', 'RELEASED', 'SHIPPED', 'VOID'] as const
export type GarmentSerialStatus = (typeof GARMENT_SERIAL_STATUSES)[number]

/** The work order states in which garment labels are given (the GarmentSerial trigger's: RELEASED, IN_PROGRESS, COMPLETED). */
export const LABEL_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'COMPLETED'])
/** … and printed again: also CLOSED (a garment still in the house whose label was damaged). */
export const REPRINT_STATUSES: readonly WorkOrderStatus[] = Object.freeze([...LABEL_STATUSES, 'CLOSED'])

/** A BATCH cell's labels in one print job (the label printer's copies). */
export const MAX_BATCH_LABELS = MAX_LABEL_COPIES
/** Serials given in one request (each its own label and print job). */
export const MAX_SERIALS_AT_ONCE = 100

/** A reason (reprint, void): 3 to 200 characters. */
export const REASON_MIN = 3
export const REASON_MAX = 200

/** The kinds of entries of the label log (PRD-348: every print and reprint, with its reason). */
export const LABEL_LOG_KINDS = ['PRINT', 'REPRINT'] as const
export type LabelLogKind = (typeof LABEL_LOG_KINDS)[number]

export const LABEL_REFUSALS = [
  'FLOOR_NOT_READY',
  'WORK_ORDER_NOT_OPEN',
  'NO_LABEL_TEMPLATE',
  'NO_BATCH_NUMBER',
  'NO_FINAL_OPERATION',
  'UNKNOWN_CELL',
  'CELL_TWICE',
  'NOTHING_FINISHED',
  'NOTHING_TO_LABEL',
  'MORE_THAN_FINISHED',
  'TOO_MANY_AT_ONCE',
  'CERTIFICATE',
  'TEMPLATE_NOT_ACTIVE',
  'LABEL_NOT_PRINTABLE',
  'NO_SERIAL_SERIES',
  'NO_PRINTER',
  'SERIAL_TRACKED',
  'BATCH_TRACKED',
  'MORE_THAN_PRINTED',
  'SERIAL_VOID',
  'SERIAL_SHIPPED',
  'SERIAL_RELEASED',
] as const
export type LabelRefusalCode = (typeof LABEL_REFUSALS)[number]

export interface LabelRefusal {
  readonly code: LabelRefusalCode
  /** What is wrong, in words. */
  readonly message: string
  /** ONE thing to do about it. */
  readonly fix: string
  /** The cell it is about; null: the whole request. */
  readonly cellId: string | null
}

const refusal = (code: LabelRefusalCode, message: string, fix: string, cellId: string | null = null): LabelRefusal => ({ code, message, fix, cellId })
const garments = (count: number): string => `${count} garment${count === 1 ? '' : 's'}`
const labels = (count: number): string => `${count} label${count === 1 ? '' : 's'}`
const stateWords = (status: WorkOrderStatus): string => status.toLowerCase().replace(/_/g, ' ')

// ---- the work order and its cells ---------------------------------------------------------------------------------------------

export interface LabelWorkOrder {
  readonly number: string
  readonly status: WorkOrderStatus
  readonly batchNumber: string | null
  /** The label template frozen at release (WorkOrder.labelTemplateId). */
  readonly labelTemplateId: string | null
  /** The final operation's words ("Op 40 SEED-PACK"); null: no scanned operation. */
  readonly finalOperation: string | null
}

export interface LabelCell {
  readonly cellId: string
  readonly colourwayCode: string
  readonly size: string
  /** The cell's pieces. */
  readonly quantity: number
  /** Good garments at the final operation; null: the routing has no scanned operation. */
  readonly finished: number | null
  /** BATCH: labels printed (first prints; reprints not counted). SERIAL: live (not VOID) serials. */
  readonly labelled: number
}

export interface LabelState {
  /** Finished garments without their label yet. */
  readonly toLabel: number
  /** Labels above what is finished now (an undo or correction at the final operation after the print). */
  readonly overLabelled: number
}

export function labelState(cell: Pick<LabelCell, 'finished' | 'labelled'>): LabelState {
  const finished = cell.finished ?? 0
  return { toLabel: Math.max(0, finished - cell.labelled), overLabelled: Math.max(0, cell.labelled - finished) }
}

const labelOf = (cell: Pick<LabelCell, 'colourwayCode' | 'size'>): string => cellLabel(cell.colourwayCode, cell.size)

/** Why no garment label of the work order may be given now (null: they may, cell by cell). */
export function workOrderRefusal(workOrder: LabelWorkOrder): LabelRefusal | null {
  if (!LABEL_STATUSES.includes(workOrder.status)) {
    return refusal(
      'WORK_ORDER_NOT_OPEN',
      `Work order ${workOrder.number} is ${stateWords(workOrder.status)}: garment labels are printed while it is released, in progress or completed.`,
      'Check that this is the right work order; the office can tell you where its garments are.',
    )
  }
  if (workOrder.labelTemplateId === null) {
    return refusal('NO_LABEL_TEMPLATE', `Work order ${workOrder.number} was released without a garment label: no label can print for it.`, 'Tell the office: the work order needs its label before any garment is labelled.')
  }
  if (workOrder.batchNumber === null) {
    return refusal('NO_BATCH_NUMBER', `Work order ${workOrder.number} has no batch number: a PPE label always carries one (Reg. (EU) 2016/425 art. 8(5)).`, 'Tell the office: the batch number is given when the work order is released.')
  }
  if (workOrder.finalOperation === null) {
    return refusal(
      'NO_FINAL_OPERATION',
      `Work order ${workOrder.number} has no scanned operation, so no garment is counted finished: labels follow the final operation's report.`,
      'Tell the office: the work order needs a scanned final operation in its routing.',
    )
  }
  return null
}

/** One cell's ask: its garments to label (default: every finished garment without a label). */
export interface LabelAsk {
  readonly cellId: string
  readonly count?: number | undefined
}

export interface LabelLine {
  readonly cellId: string
  readonly count: number
}

export type LabelPlan = { readonly ok: true; readonly lines: readonly LabelLine[] } | { readonly ok: false; readonly refusal: LabelRefusal }

const refused = (value: LabelRefusal): LabelPlan => ({ ok: false, refusal: value })

/**
 * What a print gives, per cell: the cells asked (or, with no ask, "Print all": every cell with finished garments
 * without a label), each at most what it still has to label. A count above it, an unknown or repeated cell, or more
 * than one request prints is refused whole: nothing prints (the certificate gate is the API's next step, per cell).
 */
export function planLabels(input: { readonly workOrder: LabelWorkOrder; readonly tracking: GarmentTracking; readonly cells: readonly LabelCell[]; readonly asks: readonly LabelAsk[] | null }): LabelPlan {
  const blocked = workOrderRefusal(input.workOrder)
  if (blocked) return refused(blocked)
  const byId = new Map(input.cells.map((cell) => [cell.cellId, cell]))
  const lines: LabelLine[] = []
  if (input.asks === null) {
    for (const cell of input.cells) {
      const { toLabel } = labelState(cell)
      if (toLabel > 0) lines.push({ cellId: cell.cellId, count: toLabel })
    }
    if (lines.length === 0) {
      const finished = input.cells.reduce((sum, cell) => sum + (cell.finished ?? 0), 0)
      return refused(
        finished === 0
          ? refusal('NOTHING_FINISHED', `No garment of work order ${input.workOrder.number} is finished yet: labels print after the report at ${input.workOrder.finalOperation}.`, `Report the bundles at ${input.workOrder.finalOperation} first.`)
          : refusal('NOTHING_TO_LABEL', `Every finished garment of work order ${input.workOrder.number} has its label (${garments(finished)}).`, 'Nothing to print: to replace a damaged label, reprint it.'),
      )
    }
  } else {
    const seen = new Set<string>()
    for (const ask of input.asks) {
      const cell = byId.get(ask.cellId)
      if (!cell) return refused(refusal('UNKNOWN_CELL', `This colourway and size is not a cell of work order ${input.workOrder.number}.`, 'Pick a size of this work order.', ask.cellId))
      if (seen.has(cell.cellId)) return refused(refusal('CELL_TWICE', `${labelOf(cell)} is asked twice.`, 'Ask each size once, with its count.', cell.cellId))
      seen.add(cell.cellId)
      const { toLabel } = labelState(cell)
      if (toLabel === 0) {
        return refused(
          (cell.finished ?? 0) === 0
            ? refusal('NOTHING_FINISHED', `No garment of ${labelOf(cell)} is finished yet: its labels print after the report at ${input.workOrder.finalOperation}.`, `Report its bundles at ${input.workOrder.finalOperation} first.`, cell.cellId)
            : refusal('NOTHING_TO_LABEL', `Every finished garment of ${labelOf(cell)} has its label (${garments(cell.finished ?? 0)}).`, 'Nothing to print: to replace a damaged label, reprint it.', cell.cellId),
        )
      }
      const count = ask.count ?? toLabel
      if (!Number.isSafeInteger(count) || count < 1) return refused(refusal('TOO_MANY_AT_ONCE', `${labelOf(cell)}: ask at least one label.`, 'Type how many labels to print.', cell.cellId))
      if (count > toLabel) {
        return refused(
          refusal(
            'MORE_THAN_FINISHED',
            `${labelOf(cell)} has ${garments(cell.finished ?? 0)} finished and ${cell.labelled} of them labelled: ${toLabel} still ${toLabel === 1 ? 'needs' : 'need'} a label, not ${count}.`,
            `Print ${toLabel}, or report more garments at ${input.workOrder.finalOperation} first.`,
            cell.cellId,
          ),
        )
      }
      lines.push({ cellId: cell.cellId, count })
    }
  }
  if (input.tracking === 'BATCH') {
    const over = lines.find((line) => line.count > MAX_BATCH_LABELS)
    if (over) return refused(refusal('TOO_MANY_AT_ONCE', `${labelOf(byId.get(over.cellId)!)}: ${labels(over.count)} is more than one print job holds (${MAX_BATCH_LABELS}).`, `Print at most ${MAX_BATCH_LABELS} at a time.`, over.cellId))
  } else {
    const total = lines.reduce((sum, line) => sum + line.count, 0)
    if (total > MAX_SERIALS_AT_ONCE) {
      return refused(refusal('TOO_MANY_AT_ONCE', `${garments(total)} need a serial: at most ${MAX_SERIALS_AT_ONCE} are given at a time.`, `Print one size at a time, or at most ${MAX_SERIALS_AT_ONCE} labels.`))
    }
  }
  return { ok: true, lines }
}

// ---- the certificate gate and the label --------------------------------------------------------------------------------------

/**
 * Why a cell's rendered garment label may not print (null: it may): the certificate gate's refusal in its own words
 * (an expired, suspended or withdrawn certificate, a size or colourway outside the coverage), a label template that is
 * no longer ACTIVE, or any other problem of the label (compliance/labels renderLabel `problems`).
 */
export function gateRefusal(cell: Pick<LabelCell, 'cellId' | 'colourwayCode' | 'size'>, label: { readonly printable: boolean; readonly problems: readonly Issue[] }): LabelRefusal | null {
  if (label.printable) return null
  const gate = label.problems.find((problem) => problem.path === 'certificate')
  if (gate) return refusal('CERTIFICATE', gate.message, 'Tell quality: the labels of this size print only once a valid certificate covers it.', cell.cellId)
  const status = label.problems.find((problem) => problem.path === 'status')
  if (status) return refusal('TEMPLATE_NOT_ACTIVE', `The label layout of ${labelOf(cell)} was retired: ${status.message}`, 'Tell the office.', cell.cellId)
  return refusal(
    'LABEL_NOT_PRINTABLE',
    `The garment label of ${labelOf(cell)} cannot print: ${label.problems.map((problem) => problem.message).join(' ')}`,
    'Tell the office: the label or the style needs fixing before this size is labelled.',
    cell.cellId,
  )
}

// ---- reprint and void ----------------------------------------------------------------------------------------------------------

/** A BATCH cell's labels printed again (the batch number, a reason): at most the labels printed for it. */
export function batchReprintRefusal(input: { readonly workOrder: Pick<LabelWorkOrder, 'number' | 'status'>; readonly tracking: GarmentTracking; readonly cell: LabelCell | undefined; readonly cellId: string; readonly count: number }): LabelRefusal | null {
  const { workOrder, cell } = input
  if (!REPRINT_STATUSES.includes(workOrder.status)) {
    return refusal('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${stateWords(workOrder.status)}: its garment labels are not printed again.`, 'Check that this is the right work order.')
  }
  if (input.tracking === 'SERIAL') return refusal('SERIAL_TRACKED', `Work order ${workOrder.number} gives a serial to each garment: a label is reprinted per serial.`, "Scan or pick the garment's serial, then reprint its label.", input.cellId)
  if (!cell) return refusal('UNKNOWN_CELL', `This colourway and size is not a cell of work order ${workOrder.number}.`, 'Pick a size of this work order.', input.cellId)
  if (cell.labelled === 0) return refusal('MORE_THAN_PRINTED', `No label of ${labelOf(cell)} was printed yet: a reprint replaces labels already printed.`, 'Print the labels first.', cell.cellId)
  if (input.count > cell.labelled) {
    return refusal('MORE_THAN_PRINTED', `${labels(cell.labelled)} of ${labelOf(cell)} ${cell.labelled === 1 ? 'was' : 'were'} printed: a reprint replaces at most ${cell.labelled}, not ${input.count}.`, `Reprint at most ${cell.labelled}.`, cell.cellId)
  }
  if (input.count > MAX_BATCH_LABELS) return refusal('TOO_MANY_AT_ONCE', `${labels(input.count)} is more than one print job holds (${MAX_BATCH_LABELS}).`, `Reprint at most ${MAX_BATCH_LABELS} at a time.`, cell.cellId)
  return null
}

export interface SerialFacts {
  readonly serial: string
  readonly status: GarmentSerialStatus
  readonly workOrderSizeId: string
}

/** A serial's label printed again (the same serial, a reason): never for a void or shipped serial. */
export function serialReprintRefusal(input: { readonly workOrder: Pick<LabelWorkOrder, 'number' | 'status'>; readonly serial: SerialFacts }): LabelRefusal | null {
  const { workOrder, serial } = input
  if (!REPRINT_STATUSES.includes(workOrder.status)) {
    return refusal('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${stateWords(workOrder.status)}: its garment labels are not printed again.`, 'Check that this is the right garment.', serial.workOrderSizeId)
  }
  if (serial.status === 'VOID') return refusal('SERIAL_VOID', `Serial ${serial.serial} is void: its label is never printed again.`, 'Give the garment a new serial: print its label from the sizes.', serial.workOrderSizeId)
  if (serial.status === 'SHIPPED') return refusal('SERIAL_SHIPPED', `Serial ${serial.serial} left on a shipment: its label is not printed here.`, 'Check the serial on the garment.', serial.workOrderSizeId)
  return null
}

/** A serial voided (a spoilt label, a garment scrapped after the final operation): only while MADE. */
export function voidRefusal(serial: SerialFacts): LabelRefusal | null {
  if (serial.status === 'VOID') return refusal('SERIAL_VOID', `Serial ${serial.serial} is void already.`, 'Nothing to do.', serial.workOrderSizeId)
  if (serial.status === 'SHIPPED') return refusal('SERIAL_SHIPPED', `Serial ${serial.serial} left on a shipment: it is never voided.`, 'Check the serial on the garment.', serial.workOrderSizeId)
  if (serial.status === 'RELEASED') {
    return refusal('SERIAL_RELEASED', `Serial ${serial.serial} is released by quality: it goes back to made or void only through a reversal of its release.`, 'Ask quality to reverse the release first.', serial.workOrderSizeId)
  }
  return null
}

/** The site's floor is ready for real work (platform/privacy floorReadinessFor's answer; null: the site is not in scope). */
export function labelsReadyRefusal(readiness: FloorReadiness | null): LabelRefusal | null {
  if (readiness?.readyForFloor) return null
  const missing = readiness
    ? [...(readiness.privacy.ready ? [] : readiness.privacy.notes.filter((note) => note === NO_DPIA_NOTE || note === NO_WORKER_NOTICE_NOTE)), ...(readiness.rules.readyForFloor ? [] : readiness.rules.notes)]
    : []
  const words = missing.length > 0 ? missing : (readiness?.notes ?? ['The floor rules of this site are not set up.'])
  return refusal('FLOOR_NOT_READY', `Garment labels are held at this site until its floor is ready: ${words.join(' ')}`, 'Ask the office to finish the floor set-up.')
}

// ---- serials and their bundles ------------------------------------------------------------------------------------------------

/** The text of a garment serial: a SERIAL scannable id of the tenant (`SN-<tag>-<ref>-<check>`). */
export function serialText(tenantTag: string, ref: number): string {
  return formatScanId({ type: 'SERIAL', tenantTag, ref })
}

export interface FinishedBundle {
  readonly bundleId: string
  readonly cellId: string
  /** Its good garments at the final operation (its standing report there). */
  readonly finished: number
}

/**
 * Each ACTIVE whole-garment bundle's good garments at the final operation, in the order given (oldest first): the same
 * standing reports the scans module sums per cell (wipOf's finished), so the bundles of a cell add up to it.
 */
export function finishedBundles(input: {
  readonly operations: readonly ScanOperation[]
  readonly bundles: readonly { readonly id: string; readonly workOrderSizeId: string; readonly part: string | null; readonly status: string }[]
  readonly scans: readonly ScanFact[]
}): FinishedBundle[] {
  const final = finalOperationOf(input.operations)
  if (!final) return []
  const standing = standingScans(input.scans)
  return input.bundles
    .filter((bundle) => bundle.status === 'ACTIVE' && bundle.part === null)
    .map((bundle) => ({ bundleId: bundle.id, cellId: bundle.workOrderSizeId, finished: standing.get(standingKey(bundle.id, final.id))?.goodQuantity ?? 0 }))
}

/**
 * The bundle of each new serial of a cell (MES-076: the serial reaches the bundle, its cut log entries and hides): the
 * cell's bundles in order, each up to its finished garments less the live serials it holds already; null when no bundle
 * has room left (a serial given before its bundle was known).
 */
export function assignBundles(bundles: readonly FinishedBundle[], held: ReadonlyMap<string, number>, count: number): (string | null)[] {
  const out: (string | null)[] = []
  for (const bundle of bundles) {
    let free = bundle.finished - (held.get(bundle.bundleId) ?? 0)
    while (free > 0 && out.length < count) {
      out.push(bundle.bundleId)
      free--
    }
  }
  while (out.length < count) out.push(null)
  return out
}

// ---- the label log --------------------------------------------------------------------------------------------------------------

export interface LabelLogFact {
  readonly kind: LabelLogKind
  readonly cellId: string
  readonly quantity: number
}

/** Per cell: labels printed (PRINT entries) and printed again (REPRINT entries). */
export function printedPerCell(entries: readonly LabelLogFact[]): Map<string, { printed: number; reprinted: number }> {
  const out = new Map<string, { printed: number; reprinted: number }>()
  for (const entry of entries) {
    const row = out.get(entry.cellId) ?? { printed: 0, reprinted: 0 }
    if (entry.kind === 'PRINT') row.printed += entry.quantity
    else row.reprinted += entry.quantity
    out.set(entry.cellId, row)
  }
  return out
}
