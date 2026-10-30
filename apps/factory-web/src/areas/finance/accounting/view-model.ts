import type { StepUpState } from '../_shared/hooks'
import type { AccountingPackage, CheckCode, ExportFile, ExportRecord, ExportRow, ExportStatus, Intrastat, LockLevel, PeriodAnswer, PeriodLock, Periods } from './api'
import type { AccountingAddress, AccountingCan, Explanations, LockState, Phrase, WizardStep, WriteProblem } from './model'

/**
 * SCR-156 — Accounting export's view models (the views draw them and fetch nothing; AccountingPage.tsx and
 * files/ExportFiles.tsx fill them from the API, the design cases from made-up data).
 */

export type LiveState = 'connecting' | 'live' | 'offline'

export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}

/** The lock of one month: soft or hard (the typed phrase), and lifting it (in the dialog). */
export interface LockPanelModel {
  readonly month: string | null
  /** The month's lock now (null: never locked; undefined while it is read). */
  readonly current: PeriodLock | null | undefined
  readonly level: LockLevel
  readonly phrase: string
  readonly note: string
  readonly busy: boolean
  readonly problem: WriteProblem | null
  /** Locked: the lock and what a hard lock would still wait for (a soft lock's warnings, as codes). */
  readonly done: { readonly lock: PeriodLock; readonly warnings: readonly string[] } | null
  readonly liftReason: string
  readonly liftBusy: boolean
  readonly liftProblem: WriteProblem | null
  readonly lifted: PeriodLock | null
}

export interface LockDialogModel extends LockPanelModel {
  /** The months to choose from (the last twelve, with their lock). */
  readonly months: ReadonlyArray<{ readonly month: string; readonly state: LockState }>
  readonly readProblem: string | null
}

export interface ExportingState {
  readonly busy: boolean
  /** When the export was sent (ms; JobProgress' elapsed time). */
  readonly startedAt: number | null
  readonly problem: WriteProblem | null
  readonly done: ExportRecord | null
}

export interface WizardModel {
  readonly step: WizardStep
  readonly month: string | null
  /** The year step 1 shows. */
  readonly year: number
  readonly periods: Part<Periods>
  readonly period: Part<PeriodAnswer>
  /** A newer read of the month after a live change: the checks it fixed, or only that something changed. */
  readonly pending: { readonly fixed: readonly CheckCode[]; readonly changed: boolean } | null
  readonly chosen: readonly AccountingPackage[] | null
  readonly explanations: Explanations
  readonly intrastat: Part<Intrastat>
  readonly language: 'it' | 'en'
  readonly note: string
  readonly exporting: ExportingState
  readonly lock: LockPanelModel
  /** The reason a held Continue was pressed with (⌘↵): said in the live region. */
  readonly heldNote: Phrase | null
}

export interface CancelDialogModel {
  readonly row: ExportRow
  readonly reason: string
  readonly busy: boolean
  readonly problem: WriteProblem | null
}

export interface AccountingModel {
  readonly prefix: string
  readonly can: AccountingCan
  readonly today: string
  readonly address: AccountingAddress
  readonly live: LiveState
  readonly now: number
  /** The band's lock pills: this month and the two before. */
  readonly recent: ReadonlyArray<{ readonly month: string; readonly state: LockState; readonly exported: string | null }> | null
  readonly history: { readonly rows: readonly ExportRow[] | null; readonly more: boolean; readonly problem: string | null; readonly slow: boolean; readonly readAt: number | null }
  /** Live changes behind "N updates · Show". */
  readonly updates: number
  readonly wizard: WizardModel | null
  readonly lockDialog: LockDialogModel | null
  readonly cancelDialog: CancelDialogModel | null
  readonly stepUp: StepUpState
  /** What was just done, said on the history ("EXP-2026-0002 is made", "the draft is cancelled"). */
  readonly notice: Phrase | null
  /** Design cases: the selected rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface LockActions {
  onLockMonth?: (month: string) => void
  onLockLevel?: (level: LockLevel) => void
  onLockPhrase?: (text: string) => void
  onLockNote?: (text: string) => void
  onLock?: () => void
  onLiftReason?: (text: string) => void
  onLift?: () => void
}

export interface AccountingActions {
  /** `c` on the history: the wizard from step 1. */
  onNew?: () => void
  // the history
  onStatus?: (status: ExportStatus | null) => void
  onYear?: (year: number | null) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onCancelDraft?: (row: ExportRow) => void
  onCancelReason?: (text: string) => void
  onConfirmCancel?: () => void
  onCloseCancel?: () => void
  onDismissNotice?: () => void
  // the wizard
  onStep?: (step: WizardStep) => void
  onContinue?: () => void
  onBack?: () => void
  onShowMe?: () => void
  onMonth?: (month: string) => void
  onPeriodYear?: (year: number) => void
  onRetryPeriods?: () => void
  onRetryPeriod?: () => void
  onCheckAgain?: () => void
  onTogglePackage?: (pkg: AccountingPackage) => void
  onExplain?: (code: CheckCode, text: string) => void
  onRetryIntrastat?: () => void
  onLanguage?: (language: 'it' | 'en') => void
  onNote?: (text: string) => void
  onExport?: () => void
  onDownload?: (exportId: string, file: ExportFile) => void
  /** The step 5 lock (after the batch). */
  stepLock?: LockActions
  // the lock dialog (⋯ Lock a period, a band pill)
  onOpenLock?: (month: string | null) => void
  onCloseLock?: () => void
  dialogLock?: LockActions
  // step-up (lifting a hard lock)
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
