import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { Candidates, SupplierInvoice } from '../api'
import type { PayablesCan, Phrase, RecordTab } from '../model'

export type LiveState = 'connecting' | 'live' | 'offline'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'not_found' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** A typed invoice's line as typed in its dialog. */
export interface LineDraft {
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly net: string
  readonly vatRate: string
  readonly vatNature: string
}

export type RecordDialog =
  | { readonly kind: 'approve'; readonly note: string }
  | { readonly kind: 'accept'; readonly matchId: string; readonly note: string }
  | { readonly kind: 'sendToBuyer'; readonly message: string }
  | { readonly kind: 'dispute'; readonly reason: string }
  | { readonly kind: 'withdraw'; readonly reason: string }
  | { readonly kind: 'reopen'; readonly reason: string }
  | { readonly kind: 'void'; readonly reason: string }
  | { readonly kind: 'pay'; readonly paidOn: string; readonly paymentRef: string }
  | { readonly kind: 'withoutOrder' }
  | { readonly kind: 'line'; readonly lineId: string | null; readonly draft: LineDraft }
  | { readonly kind: 'removeLine'; readonly lineId: string }

/** SCR-153 — the supplier invoice record's view model (the view draws it and fetches nothing). */
export interface SupplierInvoiceModel {
  readonly prefix: string
  readonly can: PayablesCan
  readonly today: string
  readonly tab: RecordTab
  readonly invoice: Loaded<SupplierInvoice>
  /** The PO lines and subcontract orders a line may bill (the Lines tab's Combobox); null: not asked (no mapping allowed). */
  readonly candidates: { readonly value: Candidates | null; readonly problem: string | null } | null
  /** The line whose mapping is being saved (autosave per cell), and a refused one with its words. */
  readonly savingLine: string | null
  readonly lineProblem: { readonly lineId: string; readonly phrases: readonly Phrase[] } | null
  readonly live: LiveState
  readonly dockOpen: boolean
  /** Changed by someone else while a dialog with typed words was open. */
  readonly changed: { readonly at: string } | null
  readonly notice: { readonly tone: 'success' | 'danger' | 'info' | 'warning'; readonly phrases: readonly Phrase[] } | null
  readonly busy: boolean
  readonly dialog: RecordDialog | null
  readonly dialogProblem: readonly Phrase[] | null
  /** Design cases: the panels as data (the page mounts the live RecordPanels instead). */
  readonly panelsPreview?: RecordPanelsViewModel
}

export interface SupplierInvoiceActions {
  onRetry?: () => void
  onRetryCandidates?: () => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  /** The Combobox picked a mapping for a line (saved at once). */
  onMap?: (lineId: string, value: string) => void
  onMatchAgain?: () => void
  onConfirm?: (dialog: RecordDialog) => void
  onDownload?: (fileId: string) => void
}
