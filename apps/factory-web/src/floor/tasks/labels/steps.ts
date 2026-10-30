import type { LabelsView as LabelsAnswer, Refusal } from './api'
import { allLabelled, colourGroups, gateOf, mainAction, previewLayout, printAll, printerChoice, type JobModel } from './model'
import type { LabelsNote, LabelsStep, OrderModel } from './view/LabelsView'

/**
 * The garment labels' API answer → the view's steps (SCR-096), pure: the container (Labels.tsx) and the design cases
 * (fixtures.ts) draw the same screen from the same state.
 */

export function orderOf(view: LabelsAnswer): OrderModel {
  return {
    workOrderId: view.workOrder.id,
    number: view.workOrder.number,
    batchNumber: view.workOrder.batchNumber,
    style: { code: view.workOrder.style.code, name: view.workOrder.style.name },
    tracking: view.tracking,
    label: view.label ? { code: view.label.code, revision: view.label.revision, widthMm: view.label.widthMm, heightMm: view.label.heightMm } : null,
    finalOperation: view.finalOperation ? { seq: view.finalOperation.seq, name: view.finalOperation.name } : null,
  }
}

export interface LabelsState {
  readonly view: LabelsAnswer
  /** The cell whose label `view.preview` is. */
  readonly previewCell: string | null
  readonly picked: string | null
  readonly printer: string | null
  readonly serial: { readonly id: string; readonly serial: string; readonly workOrderSizeId: string } | null
  readonly online: boolean
  readonly busy: boolean
  readonly jobs: JobModel[]
  readonly refused: Refusal[]
  readonly problems: { what: string; problem: string }[]
  readonly note: LabelsNote | null
  /** The cell whose label is being read. */
  readonly reading: string | null
  readonly printedTotal: number
}

/** The labels step of a work order as the screen draws it. */
export function labelsStepOf(state: LabelsState): Extract<LabelsStep, { kind: 'labels' }> {
  const { view } = state
  const groups = colourGroups(view.cells)
  const size = groups.flatMap((group) => group.sizes).find((entry) => entry.id === state.picked) ?? null
  const cell = view.cells.find((entry) => entry.workOrderSizeId === state.picked) ?? null
  const choice = printerChoice(view.printers, state.printer)
  const context = { online: state.online, busy: state.busy, blocked: Boolean(view.blocked), printer: choice, tracking: view.tracking, serial: state.serial }
  const preview = cell && state.previewCell === cell.workOrderSizeId && view.preview ? view.preview : null
  return {
    kind: 'labels',
    order: orderOf(view),
    groups,
    picked: size,
    gate: cell ? gateOf(cell) : null,
    preview: preview ? previewLayout(preview, view.label, preview.template.name) : null,
    previewReading: state.reading !== null && state.reading === state.picked,
    previewSample: preview?.sample ?? false,
    printer: choice,
    main: mainAction(size, context),
    all: printAll(groups, context),
    jobs: state.jobs,
    refused: state.refused,
    problems: state.problems,
    note: state.note,
    finished: allLabelled(view.cells) && state.printedTotal > 0,
  }
}
