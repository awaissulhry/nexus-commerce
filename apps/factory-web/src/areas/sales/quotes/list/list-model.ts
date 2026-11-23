import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow, QuoteListRow } from '../api'
import type { DuplicateActions, DuplicateDone, DuplicateModel } from '../duplicate/model'
import type { Grains, ListFilters, QuoteAbilities, QuoteTile, StartFrom, TileCount, Tone } from '../model'
// B-W2b-316: New quote › Start from Template / Inquiry, and the page's ⋯ links.
import type { NewFromKind, NewFromModel } from '../new-from/model'
import type { Words } from '../record/lines-depth/model'
import type { NewFromActions } from '../new-from/view/NewFrom'
import type { QuotesPageLinksModel } from '../new-from/view/PageLinks'
// B-TH-257: the New messages column.
import type { UnreadMap } from '../../../../lib/last-message-cell/model'
// F-SA-212: the Picture column is the ONE picture part (its batch read).
import type { ReadPictures } from '../../../../lib/record-picture/cache'
import type { SwitcherState } from '../../_shared/customer-switcher/model' // F-SA-224
// ---- F-CQ-201 / 202 / 204: the bar's rights, the many-acts window, Add task to N, the quote's own windows on a row
import type { QuoteBarRights, QuoteActKind } from './bar'
import type { QuoteRowAct } from './use-quotes-list'
import type { ManyActActions, ManyActModel } from '../../_shared/many-acts/use-many-act'
import type { TaskBatchModel } from '../../_shared/many-acts/use-task-batch'
import type { QuoteDialogOpen } from '../record/use-quote-dialog'
import type { QuoteDialogsActions } from '../record/view/Dialogs'
import type { BatchAnswer, BatchAssignee, TaskDraft } from '../../../../record-panels/tasks/model'

/** The quotes list's view model (SCR-034; design sales.quotes): the container (QuotesPage.tsx) fills it. */

export interface NewQuoteModel {
  /** The selling companies the person may quote for (asked only when there are several). */
  companies: readonly CompanyRef[]
  companyId: string
  /** null: not searched yet. */
  results: PartyRow[] | null
  searchProblem: string | null
  /** The customer picked, read in full (contacts, addresses, warnings). */
  party: PartyDetail | null
  partyProblem: string | null
  contactId: string
  customerRef: string
  /** The number it will get: undefined while it is read, null when the company has no single active series. */
  number: string | null | undefined
  busy: boolean
  problem: string | null
  /** B-W2a-49 "Start from" (design pop:quotes.new): Blank, or a past quote copied for this customer. */
  startFrom?: StartFrom
  past?: PastQuotePick
  /** B-W2b-316: Start from a template or an inquiry (`active` wins over `startFrom`), and why its Create waits. */
  newFrom?: NewFromModel
  newFromHeld?: Words | null
}

/** Start from a past quote: the chosen customer's quotes first, or any quote found by its number. */
export interface PastQuotePick {
  query: string
  /** null: not read yet. */
  results: QuoteListRow[] | null
  problem: string | null
  chosenId: string
  /** The copy's answer, said before the new quote opens (what was left out). */
  done: DuplicateDone | null
}

export interface QuotesListViewModel {
  /** `/w/<company>` */
  prefix: string
  me: string
  grains: Grains
  can: QuoteAbilities
  filters: ListFilters
  rows: { items: QuoteListRow[] | null; more: boolean; problem: string | null }
  tiles: Readonly<Record<QuoteTile, TileCount>>
  /** When the rows were read. */
  asOf: string | null
  today: string
  /** Changes the live stream announced since the rows were read ("3 updates · Show"); rows never move by themselves. */
  updates: number
  newQuote: NewQuoteModel | null
  notice: { key: string; tone: Tone; params?: Record<string, string | number> } | null
  /** B-W2a-49: Duplicate a quote (row ⋯); null: closed. */
  duplicate?: DuplicateModel | null
  /** B-W2b-316: the page's ⋯ (Quote templates, Planning › Promise dates). */
  pageLinks?: QuotesPageLinksModel
  /** Design cases: the rows ticked, the row that has the focus. */
  selected?: readonly string[]
  focusRow?: number
  // ---- B-TH-257 (X-SAL-QUO-LIST.grid-F03, F07, F08)
  /** The reader's own new messages per quote (threads.read); null: no right, no column. */
  unread?: UnreadMap | null
  /** sales.inquiries.view: "from INQ-…" opens the request; else the number alone. */
  readsRequests?: boolean
  /** orders.view: an accepted row's "SO-…" opens its order. */
  readsOrders?: boolean
  // ---- end B-TH-257
  // ---- TH-6 part B (B-TH-257 follow-up; grid-F01): design cases give each row's small preview here (no request is made).
  demoPictures?: Readonly<Record<string, string>>
  /** F-SA-224: the one customer filter — the customers found (names only: Quotes has no count read per customer), the search typed, the chosen one's name. */
  switcher?: { readonly state: SwitcherState; readonly query: string; readonly searching: boolean; readonly partyName: string | null | undefined } | null
  /** F-SA-277: embedded in a host page (the customer's Quotes & incoming): no own head (intro, as of, New quote) and no tiles. */
  embedded?: boolean
  /** F-SA-279: the quote the host's dock shows (its row marked; null: none); absent: the list drives no dock. */
  active?: { readonly id: string | null } | null
  // ---- F-CQ-102 / F-CQ-104 (customer page › Quotes & incoming, 13-backend §11 rows 3–4): the host's face
  /** 'host': the host's columns (no Customer column; the set by `room`); absent: Sales › Quotes' own. */
  columns?: 'host'
  /** The list's own room in px (the host measured it); the column set and the folded date follow it, never the window. */
  room?: number | null
  /** The customer's one name on this host (the chips say it); absent: each row's own. */
  customerName?: string | null
  /** The words of a door group in State ▾ (the host's band words: one word for one thing). */
  groupLabel?: string | null
  /** The phone card's door to the row's thread (its words; with `active`); absent: none. */
  cardDoor?: string | null
  // ---- F-CQ-201 / 202 / 204
  /** What the bar reads of the reader (each act its OWN right); absent: no bar acts but the frame's Export N (a design case). */
  barRights?: QuoteBarRights
  /** The many-acts window open now (Cancel N, Ask for approval on N, Make the orders for N, Send a new link to N), or null. */
  many?: ManyActModel | null
  /** "Add task to N…" open now (the ONE batch task window), or null. */
  tasks?: TaskBatchModel | null
  /** One of the quote's own windows open on a row (the quote read once), or null. */
  quoteDialog?: QuoteDialogOpen | null
  // ---- end F-CQ-201 / 202 / 204
  // ---- end F-CQ-102 / F-CQ-104
}

export interface QuotesListActions extends DuplicateActions, NewFromActions {
  /** F-SA-277: a row's click (the host's: the customer page docks the quote's thread); ⌘ / Ctrl: a new tab. Absent: the quote opens. */
  onOpenRow?: (id: string, newTab: boolean) => void
  /** F-SA-279: the keys moved the focus to a row (the host's dock follows after its rest). */
  onFocusRow?: (row: QuoteListRow) => void
  /** B-W2b-316: New quote › Start from Template / Inquiry. */
  onNewFrom?: (kind: NewFromKind) => void
  /** Row ⋯ Duplicate: opens the dialog for that quote. */
  onDuplicateStart?: (row: QuoteListRow) => void
  /** New quote › Start from. */
  onStartFrom?: (startFrom: StartFrom) => void
  onPastSearch?: (query: string) => void
  onPastPick?: (quoteId: string) => void
  onPastOpen?: (quoteId: string) => void
  onFilters?: (filters: ListFilters) => void
  /** F-SA-224: the switcher's search (the customers that match). */
  onCustomerSearch?: (query: string) => void
  onTile?: (tile: QuoteTile) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onNewQuote?: (open: boolean) => void
  onNewCompany?: (companyId: string) => void
  onNewSearch?: (query: string) => void
  onNewPick?: (partyId: string | null) => void
  onNewField?: (field: 'contactId' | 'customerRef', value: string) => void
  onCreate?: () => void
  onDismissNotice?: () => void
  /** Enter on a row: open its record. */
  onOpen?: (id: string) => void
  // ---- F-CQ-201 / 202 / 204: the bar's act over the ticked quotes, a row's act, the windows' own actions
  onBarAct?: (kind: QuoteActKind, picked: readonly QuoteListRow[]) => void
  onRowAct?: (row: QuoteListRow, act: QuoteRowAct) => void
  many?: ManyActActions
  tasks?: { readonly onSend: (draft: TaskDraft, assignee: BatchAssignee) => Promise<BatchAnswer | null>; readonly onRetryPeople: () => void; readonly onClose: () => void }
  quoteDialog?: QuoteDialogsActions
  // ---- end F-CQ-201 / 202 / 204
  /** F-SA-212: the page's pictures in ONE batch read (POST /sales/quotes/pictures through lib/record-picture). */
  readPictures?: ReadPictures
}
