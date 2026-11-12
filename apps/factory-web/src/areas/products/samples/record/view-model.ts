import type { LiveState } from '../../../../shell/live/use-live'
import type { ApprovalView, FitView, RoundView, StyleDetail, SwatchView, WorkOrderOptions } from '../api'
import type { ActivityPanel, Grid, ManualStage, Notice, Phrase, RecordTab, RequestDraft, SamplesCan } from '../model'
import type { DecideActions, DecideModel } from '../view/DecideDialog'

/** A part of the record read on its own (each tab fails alone; the rest of the record stays usable). */
export interface Part<T> {
  value: T | null
  /** The read failed (a message key). */
  problem: string | null
}

export type Loaded = { status: 'loading' } | { status: 'ready'; round: RoundView } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** A cell of a grid being saved (autosave per cell). */
export type CellState = 'saving' | 'saved' | 'failed'

/** The record's dialogs (each one at a time). */
export type RecordDialog =
  | { kind: 'cancel'; reason: string; busy: boolean; notice: Notice | null }
  | { kind: 'nextRound'; dueDate: string; instructions: string; busy: boolean; notice: Notice | null }
  | { kind: 'change'; title: string; reason: string; busy: boolean; notice: Notice | null }
  | { kind: 'testResult'; result: 'PASSED' | 'FAILED' | null; busy: boolean; notice: Notice | null }
  | { kind: 'shipment'; direction: 'OUTBOUND' | 'RETURN'; carrierName: string; trackingNumber: string; trackingUrl: string; note: string; busy: boolean; notice: Notice | null; lines: readonly Phrase[] }
  | {
      kind: 'workOrder'
      options: WorkOrderOptions | null
      problem: string | null
      /** B-W2b-284: on order lines, or without one (an internal or uncharged proto, fit or salesman round). */
      mode: 'lines' | 'none'
      lineIds: readonly string[]
      /** "none" only: the colourway of the round's cells of any colourway. */
      colourwayId: string
      siteId: string
      dueDate: string
      busy: boolean
      notice: Notice | null
      made: { id: string; number: string } | null
    }

export interface FitState {
  part: Part<FitView>
  /** Cells being saved, by `<point>/<size>`. */
  cells: Readonly<Record<string, CellState>>
  /** When the last cell was saved. */
  savedAt: string | null
  /** A refused cell, in our words. */
  failed: Phrase | null
  /** The comment being written. */
  comment: { pointOfMeasureId: string; bodyArea: string; text: string; busy: boolean; notice: Notice | null }
  /** A comment being resolved, reopened or removed. */
  working: string | null
}

export interface SampleRecordModel {
  /** `/w/<company>`. */
  prefix: string
  me: string
  today: string
  can: SamplesCan
  tab: RecordTab
  /** Activity's panel (`?panel=approvals` from "Ask the customer"). */
  panel: ActivityPanel | null
  loaded: Loaded
  asOf: string | null
  live: LiveState
  /** Someone changed the round while this page holds unsaved work (Read it again). */
  stale: string | null
  notice: Notice | null
  /** The places a refusal named. */
  lines: readonly Phrase[]
  busy: boolean
  /** The Request tab: the draft (null: as saved), the style's colourways, sizes and revisions (product.styles.view). */
  request: { draft: RequestDraft | null; style: Part<StyleDetail>; saving: boolean }
  fit: FitState
  approval: Part<ApprovalView>
  /** Cells of the Shipments grid being saved, by `<shipment>/<field>`. */
  shipmentCells: Readonly<Record<string, CellState>>
  decide: DecideModel | null
  dialog: RecordDialog | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface SampleRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  /** "Move to…" a manual stage (the band's ⋯). */
  onMove?: (to: ManualStage) => void
  // Request
  onRequestDraft?: (patch: Partial<RequestDraft>) => void
  onRequestGrid?: (grid: Grid) => void
  onRequestDiscard?: () => void
  onRequestSave?: () => void
  // Sample
  onMakeWorkOrder?: () => void
  // Fit
  onFitCell?: (pointOfMeasureId: string, size: string, measured: string | null) => void
  onFitRefused?: (size: string, text: string) => void
  onFitRetry?: () => void
  onComment?: (patch: Partial<FitState['comment']>) => void
  onCommentAdd?: () => void
  onCommentResolve?: (commentId: string, resolved: boolean) => void
  onCommentRemove?: (commentId: string) => void
  // Approval
  onApprovalRetry?: () => void
  onDecide?: () => void
  onSwatchSend?: (swatch: SwatchView) => void
  onSwatchDecide?: (swatch: SwatchView) => void
  decide?: DecideActions
  // Shipments
  onShipmentCell?: (shipmentId: string, field: 'carrierName' | 'trackingNumber' | 'trackingUrl' | 'note', value: string | null) => void
  onShipmentMark?: (shipmentId: string, field: 'sentAt' | 'receivedAt') => void
  onShipmentRemove?: (shipmentId: string) => void
  // Dialogs (cancel, next round, raise a change, test result, add shipment, make work order)
  onDialog?: (dialog: RecordDialog | null) => void
  onDialogPatch?: (patch: Partial<RecordDialog>) => void
  onDialogSubmit?: () => void
  onCopy?: () => void
}
