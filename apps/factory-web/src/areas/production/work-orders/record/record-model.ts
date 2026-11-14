import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { BundleScan, CutLog, FinalState, PickList, ReleaseCheck, TicketPrinters, WorkOrder, WorkOrderBundles, WorkOrderWip } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import type { Phrase, ProductionCan, RecordTab, SizeLayer, StepKind } from '../../_shared/model'
import type { DailyActions, DailyModel } from '../daily/model'
import type { LabourModel } from '../labour/model'
import type { SplitActions, SplitModel } from '../every-shift/use-split'
import type { ExtraActions, ExtraModel } from '../extra/use-extra'
// B-W2b-130: the Leather panel (one shade lot rule) and the cut entry's hide photo.
import type { WorkOrderLeather } from './leather/api'
// B-W2b-320: Materials › Substitute….
import type { WorkOrderSubstituteActions, WorkOrderSubstituteModel } from '../materials/substitute/WorkOrderSubstitute'
// B-W2b-245: the frozen spec against the master (Spec differences) and Change request.
import type { SpecActions, SpecModel } from '../spec/model'
// B-W2b-424: Close work order (planned against actual, a reason, Undo; Reopen) and the variance at close.
import type { CloseActions, CloseModel } from '../close/use-close'
import type { VarianceModel } from '../labour/variance/model'

/** SCR-070 … SCR-072 — the work order studio's view model (WorkOrderRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** One part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export const PART_LOADING = { value: null, problem: null } as const

export type RecordDialog =
  | { kind: 'release' }
  | { kind: 'move'; move: Exclude<StepKind, 'release' | 'close'> }
  | { kind: 'cancel' }
  | { kind: 'correct'; entryId: string }
  | { kind: 'reprint'; bundleIds: string[] }

export interface ReprintRun {
  running: boolean
  done: boolean
  results: Record<string, { state: 'done'; code: string } | { state: 'failed'; words: Phrase }>
}

export interface WorkOrderRecordModel {
  prefix: string
  can: ProductionCan
  tab: RecordTab
  workOrder: Loaded<WorkOrder>
  /** The release check (a draft). */
  check: Part<ReleaseCheck>
  /** Operations and WIP (from the release on). */
  wip: Part<WorkOrderWip>
  cutLog: Part<CutLog>
  bundles: Part<WorkOrderBundles>
  /** The pick list (inventory.issue); null without the right. */
  pick: Part<PickList> | null
  /** Inspections and releases (quality.inspections.view); null without the right. */
  quality: Part<FinalState> | null
  /** The site's label printers for a reprint (production.bundles). */
  printers: Part<TicketPrinters> | null
  live: LiveState
  dockOpen: boolean
  /** Someone changed the work order while this page holds unsaved work: "Changed at 10:42 · Reload". */
  changed: { at: string } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  busy: boolean
  dialog: RecordDialog | null
  /** A refused write while its dialog is open: said inside the dialog (the typed reason stays). */
  dialogProblem: Phrase | null
  reprint: ReprintRun | null
  sizeLayer: SizeLayer
  /** Bundles: only those waiting at this operation (seq), from Floor now's operation cells. */
  waitingAt: number | null
  /** A bundle's detail (its scans per operation). */
  bundleOpen: { bundleId: string; scans: Part<BundleScan[]> } | null
  /** A cut entry's detail. */
  cutOpen: string | null
  /** B-W2a-46: the work order every day — holds, finished to stock, yield, scrap and rework, readiness, reserve, split. */
  daily?: DailyModel
  /** B-W2a-72: the Labour & cost tab (the work order's cost from the ledger; cost grain only). */
  labour?: LabourModel
  /** B-W2b-59: Split work order (a DRAFT), while its dialog is open. */
  split?: SplitModel | null
  /** B-W2b-82: the unplanned operations of the work order, and the Add pop-up. */
  extra?: ExtraModel
  /** B-W2b-130: Materials › Leather (the shade lots of each leather and the one shade lot rule); absent: not drawn. */
  leather?: Part<WorkOrderLeather>
  /** B-W2b-130: the open cut entry's hide photo (an address for an image while it lives), read when the entry opens. */
  cutPhoto?: { entryId: string; url: string | null; problem: string | null } | null
  /** B-W2b-245: the spec against the master and the work order's change requests (absent: not drawn). */
  spec?: SpecModel
  /** B-W2b-320: Materials › Substitute… (absent: not drawn). */
  substitute?: WorkOrderSubstituteModel
  /** B-W2b-424: Close work order, its Undo, a closed work order's close and Reopen (absent: the W1 words only). */
  close?: CloseModel
  /** B-W2b-424: the variance at close on the Labour & cost tab (absent: not drawn). */
  variance?: VarianceModel | null
  /** Design cases: what the panels show (the page mounts the live panels instead). */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: a dialog's typed reason, the overview's fields in edit, a draft's grid being edited. */
  draft?: { reason?: string; override?: boolean; dueDate?: string; priority?: string; editing?: boolean; grid?: Record<string, Record<string, number>>; opsBySize?: boolean }
}

export interface WorkOrderRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'check' | 'wip' | 'cutLog' | 'bundles' | 'pick' | 'quality' | 'leather') => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onRelease?: (overrideReason: string | null) => void
  onMove?: (move: Exclude<StepKind, 'release' | 'close'>) => void
  onCancel?: (reason: string) => void
  onSaveDetails?: (details: { dueDate: string | null; priority: number; rush: boolean }) => void
  onSaveSizes?: (grid: Record<string, Record<string, number>>) => void
  onDirty?: (part: 'details' | 'sizes', dirty: boolean) => void
  onSizeLayer?: (layer: SizeLayer) => void
  onCorrect?: (entryId: string, reason: string) => void
  onReprint?: (bundleIds: string[], reason: string, printerId: string) => void
  onCloseReprint?: () => void
  onOpenBundle?: (bundleId: string | null) => void
  onOpenCut?: (entryId: string | null) => void
  onWaitingAt?: (seq: number | null) => void
  /** B-W2a-46: the W2a parts' actions. */
  daily?: DailyActions
  /** B-W2a-72: read the Labour & cost tab again. */
  onRetryLabour?: () => void
  /** B-W2b-59: Split work order. */
  onOpenSplit?: () => void
  split?: SplitActions
  /** B-W2b-82: add an unplanned operation. */
  extra?: ExtraActions
  /** B-W2b-245: Spec differences and Change request. */
  spec?: SpecActions
  /** B-W2b-320: Materials › Substitute…. */
  substitute?: WorkOrderSubstituteActions
  /** B-W2b-424: Close work order, Undo, Reopen. */
  close?: CloseActions
  /** B-W2b-424: read the variance at close again. */
  onRetryVariance?: () => void
}
