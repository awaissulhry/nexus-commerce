import type { LiveState } from '../../../../shell/live/use-live'
import type { ApproverOptionsView, OrderView, RequestRow, RequestView, StyleDetail } from '../api'
import type { ApproverLine, ChangesCan, Notice, OrderDraft, Phrase, RecordKind, RecordTab, RequestDraft, WipDisposition, WipLine } from '../model'
import type { DecideActions, DecideModel } from '../view/DecideDialog'
import type { DriftPart } from '../view/Impact'
import type { RedlineModel } from '../view/Redline'

/** A part of the record read on its own (each tab fails alone; the rest of the record stays usable). */
export interface Part<T> {
  value: T | null
  /** The read failed (a message key). */
  problem: string | null
}

export type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; request: RequestView; order?: never }
  | { status: 'ready'; order: OrderView; request?: never }
  | { status: 'notFound' }
  | { status: 'forbidden' }
  | { status: 'error'; problem: string }

/** The record's dialogs (one at a time). */
export type RecordDialog =
  | { kind: 'cancel'; reason: string; busy: boolean; notice: Notice | null }
  | { kind: 'release'; changeNote: string; busy: boolean; notice: Notice | null }
  | { kind: 'startDraft'; changeNote: string; busy: boolean; notice: Notice | null }

export interface ChangeRecordModel {
  /** `/w/<company>`. */
  prefix: string
  me: string
  can: ChangesCan
  kind: RecordKind
  tab: RecordTab
  loaded: Loaded
  asOf: string | null
  live: LiveState
  /** Someone changed the record while this page holds unsaved work (Read it again). */
  stale: string | null
  notice: Notice | null
  /** The places a refusal named. */
  lines: readonly Phrase[]
  /** A band action is running. */
  busy: boolean
  /** A request: the draft of the Change tab (null: as saved), the style's revisions for its revision, photos being sent. */
  request: { draft: RequestDraft | null; style: Part<StyleDetail>; saving: boolean; photos: { busy: boolean; failed: number } }
  /** A change order: the Change tab's draft, the redline, the open quotes and orders on older revisions. */
  order: { draft: OrderDraft | null; saving: boolean; redline: RedlineModel | null; drift: DriftPart | null }
  /** The work in progress as drafted (null: as saved). */
  wip: { lines: readonly WipLine[] | null; saving: boolean }
  /** The approvers as drafted (null: as saved), the people who may be named, the one picked to add. */
  approvers: { lines: readonly ApproverLine[] | null; options: Part<ApproverOptionsView> | null; pick: string; saving: boolean }
  /** The requests carried as drafted (null: as saved) and the style's requests it may carry. */
  carried: { ids: readonly string[] | null; options: Part<RequestRow[]> | null; saving: boolean }
  dialog: RecordDialog | null
  decide: DecideModel | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface ChangeRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onCopy?: () => void
  // a request
  onRequestDraft?: (patch: Partial<RequestDraft>) => void
  onRequestDiscard?: () => void
  onRequestSave?: () => void
  onPhotos?: (files: File[]) => void
  /** Approve change for this record (a request: the triage). */
  onDecide?: () => void
  decide?: DecideActions
  // a change order
  onOrderDraft?: (patch: Partial<OrderDraft>) => void
  onOrderDiscard?: () => void
  onOrderSave?: () => void
  onUseAsNote?: (note: string) => void
  onRedlineRetry?: () => void
  onDriftRetry?: () => void
  onSubmit?: () => void
  onDisposition?: (workOrderId: string, disposition: WipDisposition | '') => void
  onWipDiscard?: () => void
  onWipSave?: () => void
  onApproversEdit?: () => void
  onApproverPick?: (userId: string) => void
  onApproverAdd?: () => void
  onApproverRequired?: (userId: string, required: boolean) => void
  onApproverRemove?: (userId: string) => void
  onApproversDiscard?: () => void
  onApproversSave?: () => void
  onCarriedEdit?: () => void
  onCarriedToggle?: (requestId: string, on: boolean) => void
  onCarriedDiscard?: () => void
  onCarriedSave?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onDialogPatch?: (patch: Partial<RecordDialog>) => void
  onDialogSubmit?: () => void
}
