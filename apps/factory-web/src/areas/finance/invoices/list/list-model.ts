import type { InvoiceQuery, InvoiceRow, Queue } from '../../_shared/api'
import type { Deferred, DeferredGroup, ReturnCredit } from '../daily/api'
import type { ShippedView } from '../daily/model'
import type { LiveState } from '../../_shared/hooks'
import type { FinanceAbilities, Phrase, RowView } from '../../_shared/model'

/** SCR-080 — the invoices page's view model (InvoicesListView draws it and fetches nothing). */
export interface InvoicesListModel {
  /** `/w/<company>`. */
  prefix: string
  can: FinanceAbilities
  /** Today in the site's zone (YYYY-MM-DD): overdue words. */
  today: string
  /** The saved rows view, or `custom` when the address names a filter no view names. */
  rows: RowView | 'custom'
  query: InvoiceQuery
  list: { items: InvoiceRow[] | null; more: boolean; problem: string | null }
  /** The tiles' counts (each read with a limit of 200); null while unread or when the read failed ("—"). */
  tiles: { drafts: number | null; atSdi: number | null; rejected: number | null; notDelivered: number | null } | null
  /** Shipped, not invoiced: the DDTs per customer; null value while it loads. */
  queue: { value: Queue | null; problem: string | null }
  /** B-W2a-80: the deferred invoices due by the 15th (the tile, its saved filter, the month's deferred invoice); null: unread or failed. */
  deferred?: Deferred | null
  /** B-W2a-80: "Shipped, not invoiced" rows — every DDT, or those a deferred invoice takes (`?shipped=deferred`). */
  shippedView?: ShippedView
  /** B-W2a-80: a customer return's credit notes (`?return=<id>`, from the return's inspection): what it would credit now. */
  returnCredit?: { value: ReturnCredit | null; problem: string | null }
  /** The rejected invoices for the banner, with SDI's deadline to send them again (read per invoice). */
  rejected: Array<{ id: string; number: string | null; partyName: string; deadline: string | null; overdue: boolean }>
  /** When the rows were read (ISO). */
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show" (rows never move under the cursor). */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  /** "Invoice shipped goods" with the DDTs it starts from (none: the person picks); B-W2a-80: a month's deferred invoice, a return's credit notes. */
  dialog: { kind: 'fromDdts'; ddtIds: string[]; partyId: string | null } | { kind: 'deferred'; group: DeferredGroup } | { kind: 'returnCredit'; returnId: string } | null
  dialogProblem: Phrase | null
  busy: boolean
  /** Design cases: the starting selections, the focused row, the keys panel, what the dialog holds. */
  selected?: string[]
  shippedSelected?: string[]
  focusRow?: number
  helpOpen?: boolean
  draftType?: 'TD01' | 'TD24'
}

export interface InvoicesListActions {
  onRows?: (rows: RowView) => void
  onMore?: () => void
  onRetry?: () => void
  onRetryQueue?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onDialog?: (dialog: InvoicesListModel['dialog']) => void
  onCreateFromDdts?: (input: { ddtIds: string[]; docType: 'TD01' | 'TD24' }) => void
  /** B-W2a-80: the shipped list's saved filter, a month's deferred invoice, a return's credit notes. */
  onShippedView?: (view: ShippedView) => void
  onCreateDeferred?: (group: DeferredGroup) => void
  onRetryReturnCredit?: () => void
  onCreateReturnCredit?: (lineIds: string[] | null) => void
  onDismissNotice?: () => void
}
