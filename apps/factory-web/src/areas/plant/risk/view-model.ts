import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { StepUpState } from '../_shared/parts'
import type {
  AssessmentRecord,
  AssessmentsAnswer,
  Catalogue,
  CountsAnswer,
  DvrVersion,
  Measure,
  MeasuresAnswer,
  Owner,
  SheetAnswer,
  SheetApplied,
  SheetPreview,
  SheetRow,
  SheetsAnswer,
  SignedAnswer,
} from './api'
import type { MeasureDraft, MeasureStatus, PaperDraft, Problem, RecordAddress, RiskAddress, RiskCan, SheetDraft, SignerRole, VersionDraft } from './model'

/** One read of one section: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A line the page says after a write (and what was refused, in words). */
export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** An inline cell's save (owner, due, status of a measure): saving, saved, or refused with the words. */
export interface CellState {
  readonly state: 'saving' | 'saved' | 'refused'
  readonly key?: string
}

/** Add measure (design pop:measure) and a measure's own window (the same form, its evidence and moves). */
export interface MeasureDialogState {
  readonly mode: 'add' | 'edit'
  /** Edit: the measure read (its evidence files and whether the caller may upload more). */
  readonly id: string | null
  readonly read: Read<{ readonly measure: Measure; readonly canUpload: boolean }> | null
  readonly draft: MeasureDraft
  readonly owners: Read<readonly Owner[]> | null
  /** The roles of the chosen assessment's site. */
  readonly sheets: Read<readonly SheetRow[]> | null
  readonly busy: boolean
  readonly uploading: boolean
  readonly problem: Problem | null
}

/** A move that asks first: Done (what was done, evidence files) or Cancelled (why). */
export interface MoveState {
  readonly measure: Measure
  readonly to: MeasureStatus
  readonly evidenceNote: string
  readonly reason: string
  readonly files: readonly { readonly name: string; readonly size: number }[]
  readonly busy: boolean
  readonly problem: Problem | null
}

/** New DVR version (design pop:version): the assessment (or a new one), the consultant's PDF, the facts, the signers, the freeze. */
export interface VersionDialogState {
  readonly draft: VersionDraft
  /** The chosen assessment's record: who signs (`next`), what the caller may do, a version already waiting. */
  readonly record: Read<AssessmentRecord> | null
  readonly busy: boolean
  /** Where the freeze is: the PDF going to the store, then the freeze itself. */
  readonly step: 'fill' | 'uploading' | 'freezing'
  readonly addingAssessment: boolean
  readonly problem: Problem | null
  /** Frozen: the new version, its seal and who it waits for. */
  readonly frozen: DvrVersion | null
}

/** Sign version (design pop:sign): the holder's own office signature, or the paper recorded with its scan. */
export interface SignState {
  readonly versionId: string
  readonly role: SignerRole
  readonly method: 'office' | 'paper'
  readonly paper: PaperDraft
  readonly busy: boolean
  readonly problem: Problem | null
  readonly done: SignedAnswer | null
}

export interface WithdrawState {
  readonly versionId: string
  readonly reason: string
  readonly busy: boolean
  readonly problem: Problem | null
}

/** The assessment's own facts: its name, the next review (typed by a person: no interval is built in), the note. */
export interface EditAssessmentState {
  readonly name: string
  readonly nextReviewOn: string
  readonly note: string
  readonly busy: boolean
  readonly problem: Problem | null
}

/** "What this changes" before a role sheet is applied (design pop:impact, the ReviewChangesModal). */
export interface SheetReview {
  readonly read: Read<SheetPreview>
  readonly applying: boolean
  readonly applied: SheetApplied | null
  readonly problem: Problem | null
}

/** A role sheet open: the form card (the page's window, or the record's Role sheets tab). */
export interface SheetState {
  readonly id: string
  readonly read: Read<SheetAnswer>
  readonly mode: 'view' | 'edit'
  readonly draft: SheetDraft | null
  readonly catalogue: Read<Catalogue> | null
  readonly review: SheetReview | null
  readonly busy: boolean
  readonly problem: Problem | null
  readonly saved: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

/** Add role ("Add the first role"): its site, code, name, description. */
export interface NewSheetState {
  readonly siteId: string | null
  readonly code: string
  readonly name: string
  readonly description: string
  readonly busy: boolean
  readonly problem: Problem | null
}

/** What every SCR-209 view shares: who reads, where, today. */
export interface RiskFrame {
  readonly prefix: string
  readonly can: RiskCan
  readonly scope: OfficeScope
  readonly companyId: string | null
  readonly today: string
}

export interface RiskPageModel extends RiskFrame {
  readonly address: RiskAddress
  readonly counts: Read<CountsAnswer>
  readonly assessments: Read<AssessmentsAnswer>
  readonly measures: Read<MeasuresAnswer>
  readonly sheets: Read<SheetsAnswer>
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly selected?: { readonly assessments: readonly string[]; readonly measures: readonly string[]; readonly sheets: readonly string[] }
  readonly cells: Readonly<Record<string, CellState>>
  /** The people who may own a measure (safety.risk.manage), for the inline owner cell. */
  readonly owners: Read<readonly Owner[]> | null
  readonly measure: MeasureDialogState | null
  readonly move: MoveState | null
  readonly version: VersionDialogState | null
  readonly sheet: SheetState | null
  readonly newSheet: NewSheetState | null
  readonly stepUp?: StepUpState
  readonly keysOpen?: boolean
}

export interface ListSelection {
  assessments: string[]
  measures: string[]
  sheets: string[]
}

/** The actions a measure's cells, its dialog and its moves share (the page and the record's plan tab). */
export interface MeasureActions {
  onMeasureEdit?: (measure: Measure, change: { ownerId?: string | null; dueOn?: string | null }, cell: 'owner' | 'due') => void
  onMeasureMove?: (measure: Measure, to: MeasureStatus) => void
  onMoveDraft?: (change: { evidenceNote?: string; reason?: string }) => void
  onMoveFiles?: (files: File[]) => void
  onMoveApply?: () => void
  onMoveClose?: () => void
  onMeasureDraft?: (draft: MeasureDraft) => void
  onMeasureSave?: () => void
  onMeasureClose?: () => void
  onMeasureEvidence?: (files: File[]) => void
  onOpenFile?: (fileId: string) => void
  onRetryOwners?: () => void
}

/** The actions of a role sheet's form card ("What this changes" and Apply among them). */
export interface SheetActions {
  onSheetMode?: (mode: 'view' | 'edit') => void
  onSheetDraft?: (draft: SheetDraft) => void
  onSheetDiscard?: () => void
  onSheetReview?: () => void
  onSheetReviewClose?: () => void
  onSheetApply?: () => void
  onSheetRetry?: () => void
  onSheetStatus?: (to: 'ARCHIVED' | 'ACTIVE') => void
  onNewSheetDraft?: (draft: NewSheetState) => void
  onNewSheetSave?: () => void
  onNewSheetClose?: () => void
}

/** The actions of New DVR version. */
export interface VersionActions {
  onVersionDraft?: (draft: VersionDraft) => void
  onVersionFile?: (file: File | null) => void
  onVersionAddAssessment?: () => void
  onVersionFreeze?: () => void
  onVersionClose?: () => void
  onVersionRetry?: () => void
}

export interface StepUpActions {
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

export interface RiskPageActions extends MeasureActions, SheetActions, VersionActions, StepUpActions {
  onAddress?: (change: Partial<RiskAddress>) => void
  onRetryCounts?: () => void
  onRetryAssessments?: () => void
  onRetryMeasures?: () => void
  onRetrySheets?: () => void
  onDismissNotice?: () => void
  onSelected?: (change: Partial<ListSelection>) => void
  /** Go to another page of the Office (an assessment's record, its plan tab). */
  onGo?: (href: string) => void
}

/** The record (SCR-209-record): the assessment, its tabs and their dialogs. */
export interface RiskRecordModel extends RiskFrame {
  readonly id: string
  readonly address: RecordAddress
  readonly record: Read<AssessmentRecord>
  readonly measures: Read<MeasuresAnswer>
  readonly sheets: Read<SheetsAnswer>
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly selected?: readonly string[]
  readonly cells: Readonly<Record<string, CellState>>
  readonly owners: Read<readonly Owner[]> | null
  readonly measure: MeasureDialogState | null
  readonly move: MoveState | null
  readonly version: VersionDialogState | null
  readonly sheet: SheetState | null
  readonly newSheet: NewSheetState | null
  readonly sign: SignState | null
  readonly withdraw: WithdrawState | null
  readonly edit: EditAssessmentState | null
  /** A seal being kept (POST …/seal), by version id. */
  readonly keeping: string | null
  readonly stepUp?: StepUpState
  readonly keysOpen?: boolean
}

export interface RiskRecordActions extends MeasureActions, SheetActions, VersionActions, StepUpActions {
  onAddress?: (change: Partial<RecordAddress>) => void
  onRetry?: () => void
  onRetryMeasures?: () => void
  onRetrySheets?: () => void
  onDismissNotice?: () => void
  onSelected?: (ids: string[]) => void
  onSignDraft?: (paper: PaperDraft) => void
  onSignScan?: (file: File | null) => void
  onSignOffice?: (name: string) => void
  onSignPaper?: () => void
  onWithdrawReason?: (reason: string) => void
  onWithdraw?: () => void
  onEditDraft?: (draft: EditAssessmentState) => void
  onEditSave?: () => void
  onKeepSeal?: (versionId: string) => void
}
