import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { Checks, CreditAsk, CreditReason, Invoice, Related, Sdi } from '../../_shared/api'
import type { LiveState, StepUpState } from '../../_shared/hooks'
import type { FinanceAbilities, LineDraft, Phrase } from '../../_shared/model'

/** SCR-081 — the invoice record's view model (InvoiceRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** One part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export const PART_LOADING = { value: null, problem: null } as const

export const RECORD_TABS = ['lines', 'money', 'sdi', 'documents', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lines')

export type RecordDialog =
  /** Check and issue (P1: a confirm dialog after the checks pass), then send to SDI. */
  | { kind: 'issue' }
  /** Send an issued (or failed) invoice to SDI. */
  | { kind: 'send' }
  /** Fix and resend a rejected invoice: same number and date. */
  | { kind: 'fix' }
  | { kind: 'credit' }
  /** A draft's lines. */
  | { kind: 'lines' }
  /** A draft's text: the causale and the due date. */
  | { kind: 'details' }
  | { kind: 'delete' }

export interface InvoiceRecordModel {
  prefix: string
  can: FinanceAbilities
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  tab: RecordTab
  invoice: Loaded<Invoice>
  /** The checks before issue (a draft only); null for an issued invoice. */
  checks: Part<Checks> | null
  /** Its DDTs, deductions, credit notes, payments, orders and their deposits. */
  related: Part<Related>
  /** Where it is at SDI (an issued invoice); null for a draft. */
  sdi: Part<Sdi> | null
  /** The courtesy PDF in the viewer (Documents), read once from the store. */
  pdf: { status: 'idle' | 'loading' | 'ready' | 'error'; src: Uint8Array | null }
  live: LiveState
  dockOpen: boolean
  /** Someone changed the invoice while a dialog holds typed work: "Changed at 10:42 · Reload". */
  changed: { at: string } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  busy: boolean
  dialog: RecordDialog | null
  /** A refused write while its dialog is open: said inside the dialog (what was typed stays). */
  dialogProblem: Phrase | null
  /** The checks of a resend after a correction (they did not pass: said in the dialog). */
  resendProblems: Array<{ code: string; path: string }> | null
  stepUp: StepUpState
  /** Design cases: what the panels show (the page mounts the live panels instead). */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: what a dialog holds typed. */
  draft?: { mode?: 'full' | 'lines' | 'amount'; reason?: CreditReason; text?: string; amount?: string; lines?: LineDraft[]; causale?: string; dueDate?: string }
}

export interface InvoiceRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'checks' | 'related' | 'sdi') => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onIssue?: (input: { send: boolean }) => void
  onSend?: () => void
  onFixAndResend?: (input: { lines: LineDraft[] | null; causale: string | null }) => void
  onCreditNote?: (input: { reason: CreditReason; reasonText: string | null } & CreditAsk) => void
  onSaveLines?: (lines: LineDraft[]) => void
  onSaveDetails?: (input: { causale: string | null; dueDate: string | null }) => void
  onDelete?: () => void
  onRemoveDeduction?: (lineId: string) => void
  onMakeFiles?: () => void
  onDownload?: (fileId: string) => void
  onViewPdf?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
