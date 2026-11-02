import type { Loaded, Notice } from '../_shared/parts'
import type { Check, CodeRow, ColumnKey, ExportFile, ExportRecord, ExportRow, Layout, LayoutsAnswer, LayoutStarter, PayrollMonth, PayrollValues, SendAnswer, ShowAnswer } from './api'
import type { ColumnsDraft, ConfirmDraft, PayrollAddress, PayrollCan, SendDraft, Step, Words } from './model'

/**
 * SCR-159 — Payroll export's view models (the views draw them and fetch nothing; PayrollPage.tsx, record/PastExport.tsx and
 * record/ExportFile.tsx fill them from the API, the design cases from made-up data). The numbers per employee code and the
 * names behind a check live only here, in the page's memory: never in the address or the browser's storage.
 */

export type LiveState = 'connecting' | 'live' | 'offline'

export interface PreviewState {
  status: 'idle' | 'reading' | 'ready' | 'error'
  value: PayrollValues | null
  problem: Words | null
}

export const PREVIEW_IDLE: PreviewState = { status: 'idle', value: null, problem: null }

export interface MakingState {
  busy: boolean
  /** When the file was asked for (ms; JobProgress' elapsed time). */
  startedAt: number | null
  problem: Words | null
}

export const MAKING_IDLE: MakingState = { busy: false, startedAt: null, problem: null }

export interface CellMark {
  state: 'saving' | 'saved' | 'failed'
  words?: Words
}

export interface ShowDialog {
  check: Check
  /** The answer lives in this state alone; null while it is read. */
  answer: ShowAnswer | null
  problem: Words | null
}

/** What Send and the correction need of a file (a row of the list or the record). */
export type ExportTarget = Pick<ExportRow, 'id' | 'month' | 'revision' | 'number' | 'status' | 'correctedById' | 'version' | 'sentTo'> & { layout: Pick<ExportRow['layout'], 'id' | 'name' | 'provider' | 'confirmed'> }

export interface SendDialog {
  target: ExportTarget
  draft: SendDraft
  busy: boolean
  problem: Words | null
  /** The link made: its result; the dialog stays open to say it and to withdraw. */
  done: SendAnswer | null
  withdrawing: boolean
  withdrawn: boolean
}

export interface CorrectDialog {
  target: ExportTarget
  /** The month as it stands: counts only. */
  month: PayrollMonth | null
  readProblem: Words | null
  busy: boolean
  startedAt: number | null
  problem: Words | null
  /** "Show what changed": recorded, on the click; from → to per employee code. */
  changes: PreviewState
  /** The new file. */
  done: ExportRecord | null
}

export interface CancelDialog {
  target: Pick<ExportRow, 'id' | 'month' | 'version'>
  reason: string
  busy: boolean
  problem: Words | null
}

export interface ColumnsDialog {
  layout: Layout
  draft: ColumnsDraft
  busy: boolean
  problem: Words | null
}

export interface ConfirmDialog {
  layout: Layout
  draft: ConfirmDraft
  busy: boolean
  problem: Words | null
}

export interface ExportDialogs {
  send: SendDialog | null
  correct: CorrectDialog | null
  cancel: CancelDialog | null
}

export interface ExportDialogActions {
  onOpenSend?: (target: ExportTarget) => void
  onSendDraft?: (patch: Partial<SendDraft>) => void
  onSend?: () => void
  onWithdrawSent?: () => void
  onCloseSend?: () => void
  onOpenCorrect?: (target: ExportTarget) => void
  onReadChanges?: () => void
  onCorrect?: () => void
  onCloseCorrect?: () => void
  onOpenCancel?: (target: CancelDialog['target']) => void
  onCancelReason?: (text: string) => void
  onCancelDraft?: () => void
  onCloseCancel?: () => void
}

export interface WizardModel {
  step: Step
  /** The reason a held Continue was pressed with (⌘↵): said in the live region. */
  heldNote: Words | null
  codes: Loaded<CodesView>
  marks: Readonly<Record<string, CellMark>>
  preview: PreviewState
  onlyChanged: boolean
  note: string
  making: MakingState
  /** The month's file (the latest, or the one just made): its seal, files and links. */
  record: Loaded<ExportRecord> | null
}

export interface CodesView {
  rows: readonly CodeRow[]
  unmapped: number
}

export interface PayrollModel {
  prefix: string
  can: PayrollCan
  today: string
  address: PayrollAddress
  live: LiveState
  /** When the page last read (the band's "Updated"). */
  asOf: string | null
  /** The month in the band and the wizard. */
  month: Loaded<PayrollMonth>
  layouts: Loaded<LayoutsAnswer>
  /** The layout in use. */
  layout: Layout | null
  exports: { rows: readonly ExportRow[] | null; more: boolean; problem: string | null; slow: boolean; updates: number }
  wizard: WizardModel | null
  show: ShowDialog | null
  columns: ColumnsDialog | null
  confirm: ConfirmDialog | null
  dialogs: ExportDialogs
  notice: Notice | null
  /** Pages that exist in this build (a check's fix links only to those). */
  pages: ReadonlySet<string>
  /** Design cases: rows selected, the focused row, the keys panels open. */
  selected?: readonly string[]
  focusRow?: number
  keysOpen?: boolean
  help?: boolean
}

export interface PayrollActions extends ExportDialogActions {
  onDismissNotice?: () => void
  onRetryMonth?: () => void
  // the Exports
  onYear?: (year: number | null) => void
  onMore?: () => void
  onRetryExports?: () => void
  onShowUpdates?: () => void
  onExportCsv?: (rows: readonly ExportRow[]) => void
  onOpenExport?: (exportId: string) => void
  // the wizard
  onStart?: () => void
  onLeave?: () => void
  onMonth?: (month: string) => void
  onStep?: (step: Step) => void
  onContinue?: () => void
  onBack?: () => void
  onShow?: (check: Check) => void
  onCloseShow?: () => void
  onRetryCodes?: () => void
  onCode?: (row: CodeRow, typed: string) => void
  onReadPreview?: () => void
  onOnlyChanged?: (only: boolean) => void
  onLayout?: (layoutId: string) => void
  onAddLayout?: (starter: LayoutStarter) => void
  onArchiveLayout?: (layout: Layout) => void
  onRetryLayouts?: () => void
  onNote?: (text: string) => void
  onMake?: () => void
  onDownload?: (record: ExportRecord, file: ExportFile) => void
  onRetryRecord?: () => void
  // the pop-ups
  onOpenColumns?: (layout: Layout) => void
  onColumnsDraft?: (patch: Partial<ColumnsDraft>) => void
  onColumnAdd?: (key: ColumnKey) => void
  onSaveColumns?: () => void
  onCloseColumns?: () => void
  onOpenConfirm?: (layout: Layout) => void
  onConfirmDraft?: (patch: Partial<ConfirmDraft>) => void
  onSaveConfirm?: () => void
  onTakeBackConfirm?: () => void
  onCloseConfirm?: () => void
}
