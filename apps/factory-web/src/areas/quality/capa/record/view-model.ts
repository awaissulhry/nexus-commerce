import type { LiveState } from '../../_shared/model'
import type { CapaPerson, CapaRecord, CapaStatus, CustomerChoice, EvidenceFile, ReportLanguage } from '../api'
import type { ActionDraft, CapaCan, ProblemDraft, RecordTab } from '../model'
import type { CapaNotice, CellState } from '../parts'
import type { CloseDialogActions, CloseDialogModel } from '../view/CloseCapaDialog'

export type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly record: CapaRecord }
  | { readonly status: 'notFound' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error'; readonly problem: string }

interface DialogBase {
  readonly busy: boolean
  readonly notice: CapaNotice | null
}

/** The record's dialogs: Add action (`a`), Done with its evidence, Cancel an action, Cancel the CAPA, Move to a stage, Remove a source. */
export type RecordDialog =
  | (DialogBase & { readonly kind: 'addAction'; readonly draft: ActionDraft })
  | (DialogBase & { readonly kind: 'done'; readonly actionId: string; readonly evidence: string })
  | (DialogBase & { readonly kind: 'cancelAction'; readonly actionId: string; readonly reason: string })
  | (DialogBase & { readonly kind: 'cancelCapa'; readonly reason: string })
  | (DialogBase & { readonly kind: 'stage'; readonly to: CapaStatus | '' })
  | (DialogBase & { readonly kind: 'removeSource'; readonly sourceId: string })

/** The docked action drawer (design pop:capa-action): which action, its evidence files. */
export interface DrawerModel {
  readonly actionId: string
  readonly files: { readonly items: readonly EvidenceFile[] | null; readonly problem: string | null }
  readonly uploading: boolean
}

/** The Report tab and the 8D window: the preview in the chosen language, a version being kept, a share running. */
export interface ReportModel {
  readonly language: ReportLanguage
  readonly pdf: Uint8Array | null
  readonly problem: string | null
  readonly keeping: boolean
  /** The complaint whose share runs. */
  readonly sharing: string | null
}

export interface CapaRecordModel {
  readonly prefix: string
  readonly me: string
  readonly today: string
  readonly can: CapaCan
  readonly tab: RecordTab
  readonly loaded: Loaded
  readonly live: LiveState
  readonly asOf: string | null
  /** Who may own the CAPA or be given an action (GET /quality/capa/people); null while reading or when it failed. */
  readonly people: readonly CapaPerson[] | null
  readonly draft: ProblemDraft | null
  readonly saving: boolean
  readonly cells: Readonly<Record<string, CellState>>
  readonly customers: { readonly items: readonly CustomerChoice[] | null; readonly problem: string | null }
  readonly dialog: RecordDialog | null
  readonly close: CloseDialogModel | null
  readonly notice: CapaNotice | null
  /** The record changed elsewhere while a dialog or a draft held work (the time it was seen). */
  readonly stale: string | null
  readonly busy: boolean
  readonly keysOpen: boolean
  readonly copied: boolean
  readonly drawer: DrawerModel | null
  readonly report: ReportModel
}

export interface CapaRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDraft?: (patch: Partial<ProblemDraft>) => void
  onDiscard?: () => void
  onSave?: () => void
  onFindCustomers?: (q: string) => void
  onMove?: (to: CapaStatus) => void
  onClose?: () => void
  close?: CloseDialogActions
  onDialog?: (dialog: RecordDialog | null) => void
  onDialogChange?: (patch: Partial<Record<string, unknown>>) => void
  onSubmitDialog?: () => void
  onActionCell?: (actionId: string, field: 'description' | 'kind' | 'ownerId' | 'dueOn' | 'escalateToId', value: string) => void
  onOpenAction?: (actionId: string | null) => void
  onStepAction?: (by: 1 | -1) => void
  onRemind?: (actionId: string) => void
  onUpload?: (file: File) => void
  onOpenFile?: (fileId: string) => void
  onLanguage?: (language: ReportLanguage) => void
  onKeep?: () => void
  onShare?: (complaintId: string) => void
  onCopy?: () => void
  onKeys?: (open: boolean) => void
  onDismissNotice?: () => void
}
