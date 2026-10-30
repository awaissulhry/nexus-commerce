import type { LiveState } from '../_shared/model'
import type { Complaint, ComplaintCounts, ComplaintPeople, ComplaintRow, ContactOption, DocOption, LogPreview, PartyOption, SafetyAlert, StyleOption } from './api'
import type { ComplaintsAddress, ComplaintsCan, LogDraft, TriageDraft, Words } from './model'

/**
 * The view models of Quality › Complaints (SCR-113 W2a part) and the actions they report. The containers
 * (ComplaintsPage.tsx, record/ComplaintRecord.tsx) read and write; the views fetch nothing.
 */

/** A loaded thing: still reading, ready, not found, not allowed, or a failed read (a message key). */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** A list a dialog picks from: null = not asked (no right, or not needed yet), else read / reading / failed. */
export interface Choices<T> {
  readonly items: readonly T[] | null
  readonly problem: string | null
}

export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: Words
  readonly detail?: Words | null
}

/** A photo of the complaint: its address once read (null while reading or when it could not be read). */
export interface PhotoView {
  readonly id: string
  readonly name: string
  readonly src: string | null
}

/** The triage DetailModal (design cmp-triage): the complaint, its draft, the queue it walks. */
export interface TriageModel {
  /** The new complaints it walks with J / K (one id: the record's own triage). */
  readonly queue: readonly string[]
  readonly id: string
  readonly loaded: Loaded<Complaint>
  readonly photos: readonly PhotoView[]
  readonly draft: TriageDraft
  /** Who may follow it up (the owner picker) and whom a safety alert tells; null while read. */
  readonly people: ComplaintPeople | null
  readonly peopleProblem: string | null
  /** The styles to name when the complaint has none (product.styles.view), else null. */
  readonly styles: readonly StyleOption[] | null
  readonly showProblems: boolean
  readonly busy: boolean
  /** A message key of the last refusal. */
  readonly problem: string | null
  /** The Safety confirm is open (design: ActionConfirm "This alerts the owner and quality now…"). */
  readonly confirmSafety: boolean
  readonly today: string
  readonly offline: boolean
}

export interface TriageActions {
  onTriageGo?: (id: string) => void
  onTriageClose?: () => void
  onTriageRetry?: () => void
  onTriageDraft?: (patch: Partial<TriageDraft>) => void
  /** Save (and walk on to the next of the queue). */
  onTriageSave?: () => void
  onTriageConfirmSafety?: () => void
  onTriageCancelSafety?: () => void
}

/** The Log complaint dialog (design cmp-log). */
export interface LogModel {
  readonly draft: LogDraft
  readonly customers: Choices<PartyOption>
  readonly contacts: readonly ContactOption[] | null
  readonly orders: readonly DocOption[] | null
  readonly shipments: readonly DocOption[] | null
  readonly returns: readonly DocOption[] | null
  readonly styles: readonly StyleOption[] | null
  /** What the serial / the customer found (style, size, batch, shipment, order; the customer's other open complaints). */
  readonly preview: LogPreview | null
  readonly previewing: boolean
  readonly showProblems: boolean
  readonly busy: boolean
  readonly problem: string | null
  readonly today: string
  /** The person may upload photos (files.upload). */
  readonly canPhotos: boolean
}

export interface LogActions {
  onLogDraft?: (patch: Partial<LogDraft>) => void
  /** Read what the serial (or the customer and order) finds. */
  onLogLookUp?: () => void
  onLogSubmit?: () => void
  onLogClose?: () => void
}

export interface ComplaintsRows {
  /** null while the first read runs. */
  readonly items: readonly ComplaintRow[] | null
  readonly people: readonly { id: string; name: string }[]
  readonly more: boolean
  readonly loadingMore: boolean
  /** A message key of a failed read. */
  readonly problem: string | null
}

export interface ComplaintsListModel {
  readonly prefix: string
  readonly can: ComplaintsCan
  readonly address: ComplaintsAddress
  readonly rows: ComplaintsRows
  /** null while counting; `tilesFailed` when the count could not be read (the tiles say so, never 0). */
  readonly counts: ComplaintCounts | null
  readonly countsFailed: boolean
  readonly asOf: string | null
  readonly live: LiveState
  /** The browser is offline: the last copy shows with its time, writes are held. */
  readonly offline: boolean
  /** Changes waiting behind "N updates · Show". */
  readonly updates: number
  readonly today: string
  readonly notice: Notice | null
  readonly triage: TriageModel | null
  readonly log: LogModel | null
  readonly acknowledge: { readonly alert: SafetyAlert; readonly busy: boolean; readonly problem: string | null } | null
  /** Design cases: rows selected, the keys panel open, the focused row. */
  readonly selected?: readonly string[]
  readonly helpOpen?: boolean
  readonly focusRow?: number
}

export interface ComplaintsListActions extends TriageActions, LogActions {
  onAddress?: (patch: Partial<ComplaintsAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  /** Open a row: a new one in triage, any other on its record page. */
  onOpen?: (row: ComplaintRow) => void
  /** Triage (n): the queue of new complaints from its first. */
  onStartTriage?: (ids?: readonly string[]) => void
  onLog?: () => void
  onAcknowledge?: (alert: SafetyAlert) => void
  onAcknowledgeConfirm?: (note: string | null) => void
  onAcknowledgeClose?: () => void
  onCopy?: (text: string) => void
  onExport?: (rows: readonly ComplaintRow[]) => void
  onDismissNotice?: () => void
}
