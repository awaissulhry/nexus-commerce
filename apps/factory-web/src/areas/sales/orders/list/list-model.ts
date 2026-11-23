import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow } from '../../quotes/api'
import type { OrderBoard, OrderRow, OrderSort } from '../api'
import type { NewShipmentActions } from '../../../warehouse/shipments/new/use-new-shipment' // F-CW-301
import type { ShipTogetherModel } from './sheet/ship' // F-CW-301
import type { UrgencyAct } from '../../../_shared/customer-urgency/model' // F-CW-302
import type { SheetUrgencyActions, SheetUrgencyModel } from './sheet/urgency' // F-CW-302
import type { PriceMatch } from '../api' // F-CP-140
import type { OrderPhase } from '../api' // F-CW-101
import type { OrderCustomer } from '../api' // F-SA-224: the switcher's customers carry Orders' counts
import type { LiveState } from '../hooks'
import type { Lane, Layout, OrderAbilities, Phrase, RowView } from '../model'
// ---- B-W2b-323 (orders in depth on screen) ----
import type { ListDepthActions, ListDepthModel } from '../list-depth/use-list-depth'
import type { OrdersImportModel } from '../import/view/OrdersImportView'
import type { OrdersImportActions } from '../import/use-orders-import' // B-TH-293
import type { WeekModel } from '../week/use-promise-week'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
import type { ReadPictures } from '../../../../lib/record-picture/cache' // F-SA-212: the one picture part's batch read
import type { ReadStyles } from '../../../../lib/record-picture/styles' // F-CP-110: the viewer's styles strip
import type { SwitcherState } from '../../_shared/customer-switcher/model' // F-SA-224: the one customer filter
// ---- B-TH-244 (TH-4: the overall view) ----
import type { OrderSummary } from '../api'
import type { ExtraTerms } from '../model'
import type { GroupRows } from './sheet/overall'
import type { InvoiceDraftsState } from './sheet/overall-parts'
import type { WaitingMarks } from './sheet/model' // F-SA-275
import type { AssignSupervisorActions, AssignSupervisorModel } from '../../../_shared/production-supervisor/model' // F-SA-280
import type { NoteDialogActions, NoteDialogModel } from '../../../production/_shared/notes/model' // F-SA-280
import type { Assignable, BatchAnswer, BatchAssignee, BatchRecord, TaskDraft } from '../../../../record-panels/tasks/model' // F-SA-281
import type { PanelRead } from '../../../../record-panels/model' // F-SA-281
import type { ReplyManyActions, ReplyManyModel } from './reply-many' // F-SA-282
import type { PriceCheckDialogActions, PriceCheckDialogModel } from '../price-check/use-price-check' // F-CP-114
import type { OrderCommandActions, OrderCommandModel, WindowCommand, Words } from './commands/model' // F-CP-108
import type { ManyCommand, OrderCommandManyActions, OrderCommandManyModel } from './commands/model' // F-CP-109

/** SCR-038 — the orders list's view model (OrdersListView draws it and fetches nothing). */

/** The New order dialog (design pop:orders.new, B-W2a-50): customer, contact, customer PO, the number it will get. */
export interface NewOrderDialogModel {
  /** The selling companies the person may take orders for (asked only when there are several). */
  companies: readonly CompanyRef[]
  companyId: string
  /** null: not searched yet. */
  results: PartyRow[] | null
  searchProblem: string | null
  /** The customer picked, read in full (contacts, tax identity, warnings). */
  party: PartyDetail | null
  partyProblem: string | null
  contactId: string
  customerRef: string
  /** The number it will get: undefined while read, null when the company has no single active series. */
  number: string | null | undefined
  /** B-TH-221: the one pointer — a written request goes to Incoming's New request (null: the person makes no request). */
  incomingHref?: string | null
  /** F-CP-146 (money wall D1-c): false — the person sees no price: the window says the lines take the customer's price list. */
  price?: boolean
  /** F-CP-104: the host holds the customer (the customer page): it is picked on open and the window offers no Change. */
  partyLocked?: boolean
}
// B-TH-230
import type { UnreadMap } from '../../../../lib/last-message-cell/model'
import type { ReadUnread } from '../../../../lib/last-message-cell/use-unread' // F-SA-213

export interface OrdersListModel {
  /** `/w/<company>`. */
  prefix: string
  can: OrderAbilities
  /** Today in the site's zone (YYYY-MM-DD): late and overdue words. */
  today: string
  layout: Layout
  rows: RowView
  q: string
  list: { items: OrderRow[] | null; more: boolean; problem: string | null }
  /** The board's lanes (read only for the board layout). */
  lanes: Lane[]
  /** The counts by state and the tiles; null while unread or when the read failed (the tiles say "—"). */
  board: OrderBoard | null
  /** When the rows were read (ISO). */
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show" (rows never move under the cursor). */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  /** B-W2a-50: the New order dialog, open; null: closed. */
  newOrder?: NewOrderDialogModel | null
  /** B-W2a-72: each order's margin % as estimated now (undefined: still reading; null: not known); null: the column is not drawn. */
  margins?: ReadonlyMap<string, string | null> | null
  /** B-TH-230: the reader's own new messages per order (one read per page); null/absent: no threads.read, the column is not drawn. */
  unread?: UnreadMap | null
  /** F-SA-213: the board's lanes read their own new-message counts (≤ 50 rows each), again on `refresh`; null: no threads.read. */
  boardUnread?: { readonly read: ReadUnread; readonly refresh: number } | null
  // ---- B-W2b-323 (orders in depth on screen) ----
  /** The Priority and Season columns, the inline priority, Set priority on a selection; null/absent: not drawn. */
  depth?: ListDepthModel | null
  /** By promise week (`?view=week`); null/absent: not read. */
  week?: WeekModel | null
  /** Import orders (band ⋯): why it is held, and the wizard while open. */
  importer?: (OrdersImportModel & { held: string | null }) | null
  /**
   * B-TH-201: the customer the address narrows the list to (`?party=`): its name once known (undefined while it is looked
   * up; null when the person may not open that customer: the chip names no one); null/absent: every customer.
   */
  customer?: { id: string; name: string | null | undefined } | null
  // ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
  /** The label on the garment the address narrows the sheet to (`?brand=<party>|own`), and its name once known. */
  brand?: { value: string; name: string | null } | null
  /** The company the address narrows the sheet to (`?company=`): its id and name. */
  company?: { id: string; name: string } | null
  // ---- B-TH-057 (TH-4: the server sort and the custom field filter) ----
  /** The server sort of the address (null: newest first): the header of the column it sorts by shows it. */
  sort?: OrderSort | null
  /** The custom field filter of the address (`?cf=`), shown as a chip (never a hidden filter); null: none. */
  cf?: string | null
  /** The companies the reader sees: the Company column and its funnel only from two on. */
  companies?: ReadonlyArray<{ id: string; name: string }>
  /** The Customer switcher: the reader's customers, their counts, a limited reader (null: not drawn). */
  switcher?: (SwitcherState<OrderCustomer> & { query: string; searching: boolean }) | null
  /** Design cases: each row's picture as an address (the page reads the small previews through `actions.readPictures`). */
  demoPictures?: Readonly<Record<string, string>>
  /**
   * F-CW-301 (10-design §6 W1): Warehouse's ONE New shipment window mounted on the sheet (Ship N together…, a row's Create
   * shipment…), the shipping rights, and the one notice after Create. Absent: the host gives no shipping act.
   */
  ship?: ShipTogetherModel | null
  /**
   * F-CW-302 (S7, S14): the shared urgency window mounted on the sheet (Set to regular… · Lock… · Unlock… from a row's ⋯ and More ▾)
   * and its outcome. Absent without production.brand.override: no urgency act is drawn.
   */
  urgency?: SheetUrgencyModel | null
  /**
   * F-CW-302 (S35) — host-only, the customer's Work tab: the customer's urgency switch is OFF (its own read, workorders.view). The
   * urgency acts are then held with words and "Most urgent first" has no middle part. The other hosts never set it.
   */
  urgencyOff?: boolean
  /**
   * F-CW-202 (lead settle S36; review A1-B4): false — this host draws no List ⇄ Board switch (the customer's Work tab), so the key
   * `v` does nothing there and leaves its keys list. Absent: the switch is drawn (the sheet's own band, or the host's).
   */
  layoutSwitch?: boolean
  /** Design cases: the viewer open on a row, the switcher open, the widths that show the wide columns. */
  viewerOpen?: string | null
  switcherOpen?: boolean
  wide?: boolean
  /** Design cases: the starting selection, the focused row, the keys panel. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
  // ---- B-TH-244 (threads plan TH-4, picture 26: the overall view) ----
  /** `?group=party`: All customers grouped by customer (never on one customer's sheet). */
  group?: 'party' | null
  /** The door terms beside the rows view (a total opened exactly its rows): each a chip with ✕. */
  extra?: ExtraTerms | null
  /**
   * F-CP-141 (money wall): the address names the price check term and the reader sees no price (a shared saved view, a link): no read
   * carries it, no rows are read — the sheet says so in ONE line ("Amounts are shown to people who see prices") with Show all orders.
   */
  priceHeld?: boolean
  /**
   * F-CW-101: quiet words the host puts beside the phase chip (`extra.phase`) — the customer page's band says why its "Not sent to the
   * factory" orders wait ("1 waits for a yes · 1 waits for the deposit"); absent: the chip alone (or the sheet's own line for a phase).
   */
  phaseNote?: string | null
  /** The view's figures from the server (null while read or not asked; the problem in words when it failed). */
  summary?: { value: OrderSummary | null; problem: string | null } | null
  /** The grouped view: each customer's rows read so far (by customer id), and the groups folded shut. */
  groupRows?: Readonly<Record<string, GroupRows>>
  collapsed?: readonly string[]
  /** "Invoice shipped goods for N" (finance only): the drafts it would open in Finance; null: closed. */
  invoiceDrafts?: InvoiceDraftsState | null
  /** F-SA-221: made-to-measure orders only (`?kind=mtm`): its chip (fixed when the host locks it), the Riders column shown. */
  kind?: 'mtm' | null
  /** F-SA-222: a rider's orders (`?profile=`): the rider's name once read (undefined while read, null when not found). */
  profile?: { id: string; name: string | null | undefined } | null
  /** F-SA-222: what an empty view says on this host (the Made-to-measure page says why: GATE-MTM), when nothing narrows it. */
  // F-CP-102: `view` — the rows view these words are for (the customer page keys them per view): they show on that view when nothing
  // else narrows it; absent: the host's default view only (as before).
  // F-CP-104: `newOrder` — New order beside the words (held with why without orders.manage; the customer page's All orders).
  // F-CW-102 (lead settle S20): `always` — the words are for exactly what is on screen now, whatever narrows it (a door of the
  // customer page's band, its views): the host gives them only then. `note`: one more quiet line under them (the customer's drafts).
  empty?: { title: string; body?: string | null; link?: { href: string; label: string } | null; view?: RowView | null; newOrder?: boolean; always?: boolean } | null
  // ---- F-SA-220 (the ONE Orders sheet, use-orders-sheet.ts): the host's ----
  /** The list frame's key: 'sales.orders' on every host (one export source, one set of saved views). */
  listKey?: string
  /** No own band and no tiles: the host draws them (OrdersLayoutSwitch, OrdersTiles). */
  embedded?: boolean
  /** The terms the host holds (in every read and in the address): no switcher or chip ✕ for them, Clear all keeps them. */
  locked?: { readonly party: boolean; readonly kind: boolean }
  // ---- F-SA-275 (the production columns): the host's ----
  /** What the host knows of each order beside its row (the customer page: its requests and replies that wait on us), by order id. */
  marks?: WaitingMarks | null
  /** The review window's address on the host's page for a request (the customer page's door); absent: the order's Changes tab. */
  doorHref?: ((requestId: string) => string) | null
  // ---- end F-SA-275
  // ---- F-SA-276 (the customer's Work tab) ----
  /** `?waiting=us`: the orders waiting on us (a chip with ✕; the customer page's built-in view "Waiting on us"). */
  waiting?: 'us' | null
  /** The host's built-in views, in its order (ids of builtInViewsOf; absent: every one of the sheet's). */
  views?: readonly string[] | null
  /** The host's default rows view, written into the address on entry: not a narrowing (no chip, no "Viewing …" line). */
  // F-CP-102: the sheet sets it from the host's `clearTo` (absent: Open orders); Clear all and a view chip's ✕ go back to it.
  defaultRows?: RowView | null
  /**
   * F-CP-102: the host's own views in Views ▾ (not rows views of the sheet: the customer page's Drafts of <customer> and Not equal),
   * placed where `views` names their ids; `active` ticks the one the address shows (it wins over the rows view); picked through
   * `actions.onHostView`.
   */
  hostViews?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly active?: boolean }> | null
  /** F-CP-103 (review A4): the count beside each Views ▾ item, by view id, from the host's one count read (absent id: no number). */
  viewCounts?: Readonly<Record<string, number>> | null
  // ---- F-CW-104 (10-design §3.1): the host's own toolbar words ----
  /** Every order of the host's scope (the customer's): the count says "2 of 14 orders" while the sheet shows fewer (a door, a view, a search). */
  countOf?: number | null
  /** The host's own search words (placeholder and name): the sheet's longer ones are cut in a narrow toolbar. */
  searchLabel?: string | null
  // ---- end F-CW-104
  /** The columns the host shows at first, and from 1800 px (a person's Customise wins); absent: the sheet's own. */
  preset?: {
    readonly shown: readonly string[]
    readonly wide?: readonly string[]
    // ---- F-CP-107 (cp-fx16): the number and the status whole beside the dock (oo-walk 15 b) ----
    /** The host's own minimum widths by column id (the honest room of its longest words), over the sheet's. */
    readonly min?: Readonly<Record<string, number>>
    // ---- end F-CP-107 (cp-fx16)
    // ---- F-CW-102 (10-design §1): the host's set at its own widths ----
    /** The host's own MAXIMUM widths by column id: with the same minimum the column is fixed, and the room left goes to the flexible one (Where it is). */
    readonly max?: Readonly<Record<string, number>>
    /** The sheet sits in a narrow room (beside the dock): the chips cell keeps each chip's head (a tail and a mark go to its tooltip). */
    readonly dense?: boolean
    /** The host's own order of its set, left to right (the sheet's other columns follow in their own order; ⋯ stays last). */
    readonly order?: readonly string[]
    // ---- end F-CW-102
    // ---- F-CW-103 (lead settle S12; 10-design §3.9): Customise tells the truth for the host's set ----
    /**
     * The columns of the host's set that are not on screen in THIS room and show in a wider one (by column id: from a `wider` sheet,
     * or only from the `widest`). Customise lists them ticked and named so ("Waiting on · from a wider sheet"); a column is never
     * cut to fit. Every other column the preset does not show is offered unticked (it shows when the person ticks it).
     */
    readonly later?: Readonly<Record<string, 'wider' | 'widest'>>
    // ---- end F-CW-103
  } | null
  /**
   * F-CP-105: "Columns: Work · Money" at the toolbar's start — the columns shown now (the host's view preset, or the money columns);
   * the host gives it only with the price grain (absent: no toggle at all). Picked through `actions.onColumnSet`.
   */
  columnSet?: { readonly value: 'work' | 'money' } | null
  // ---- end F-SA-276
  // ---- F-SA-280 (bulk on the sheet's own bar): production's assign and note dialogs while open, and the rights they need ----
  assign?: AssignSupervisorModel | null
  note?: NoteDialogModel | null
  bulkCan?: { readonly supervisor: boolean; readonly note: boolean; /** F-SA-281: why a task is held (a `records` key), or null. */ readonly task?: string | null; /** F-SA-282: threads.post (Reply to N). */ readonly reply?: boolean; /** F-CW-203: partners.tasks.manage (Ask <customer>: a to-do in their list). */ readonly todo?: boolean }
  // ---- end F-SA-280
  // ---- F-SA-281: the New task window while open — on one order, or on N (one batch) — and who the person is ("Me") ----
  task?: { readonly mode: 'one' | 'many'; readonly records: readonly BatchRecord[]; readonly people: PanelRead<readonly Assignable[]>; readonly busy: boolean } | null
  me?: string | null
  // ---- end F-SA-281
  // ---- F-SA-282: Reply to <customer> on N… while open (one customer, ≤ 50, one batchId; each order's own conversation)
  replyMany?: ReplyManyModel | null
  // F-CP-114: the ONE customer's-price window while open (row ⋯ "Set customer's price…", the Customer's price cell; price holders only).
  priceCheck?: PriceCheckDialogModel | null
  // ---- F-CP-108: the order page's own commands on the sheet — the ONE window a row's ⋯ "Next steps" opens (null: none open), the rows a
  // command moved out of the view on screen (they stay, greyed, until "N updates · Show"), and the last command's toast.
  commands?: {
    readonly window: OrderCommandModel | null
    readonly moved: readonly string[]
    readonly receipt: { readonly words: Words; readonly at: number } | null
    /** F-CP-109: the bulk window over the ticked orders (Mark N ready… · Close N… · Confirm N…) while open; null: closed. */
    readonly many?: OrderCommandManyModel | null
    /** F-CP-109: the reader decides yeses (approvals.decide): Confirm N… is on the bar. */
    readonly decide?: boolean
  } | null
  // ---- end F-CP-108
  // ---- F-SA-279 (the customer page: a row drives the dock) ----
  /** The order the page's dock shows (marked; null: none), and the words of a phone card's door to its conversation; absent: not a dock list. */
  active?: { readonly id: string | null; readonly cardDoor?: string | null } | null
  // ---- end F-SA-279
}

export interface OrdersListActions {
  onRows?: (rows: RowView) => void
  onLayout?: (layout: Layout) => void
  onSearch?: (q: string) => void
  /** B-TH-201: the customer chip's ✕ (every customer again). B-TH-226: the switcher's pick (null: every customer). */
  onClearCustomer?: () => void
  onCustomer?: (party: string | null) => void
  /** B-TH-225: Clear all / Clear filters — the search, the view, the customer, the label and the company at once. */
  onClearAll?: () => void
  onCustomerSearch?: (query: string) => void
  onCustomerRetry?: () => void
  /** B-TH-225: the funnels (Brand, Status, Company) and their chips' ✕; null clears. */
  onBrand?: (brand: string | null) => void
  onCompany?: (company: string | null) => void
  /** B-TH-057: a header click or the Sort menu (null: newest first again); the custom field chip's ✕. */
  onSort?: (sort: OrderSort | null) => void
  onClearCf?: () => void
  /** F-SA-212: the pictures of the rows the sheet, the phone cards and the board draw (ONE batch read per page: lib/record-picture). */
  readPictures?: ReadPictures
  /** F-CP-110: an order's lines for the picture viewer's styles strip (the order read, once per viewer); absent: the lines door only. */
  readStyles?: ReadStyles
  /** B-TH-225: the rest of a row opens the order (⌘ / Ctrl: a new tab). */
  onOpenRow?: (id: string, newTab: boolean) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onDismissNotice?: () => void
  // B-W2a-50: New order (the dialog makes a draft on the screen; the order is made by "Confirm order").
  onNewOrder?: (open: boolean) => void
  onNewCompany?: (companyId: string) => void
  onNewSearch?: (query: string) => void
  onNewPick?: (partyId: string | null) => void
  onNewField?: (field: 'contactId' | 'customerRef', value: string) => void
  onNewCreate?: () => void
  // ---- B-W2b-323 (orders in depth on screen) ----
  depth?: ListDepthActions
  onImport?: () => void
  importActions?: OrdersImportActions // B-TH-293: + Use them (a customer's remembered columns)
  onWeekSite?: (siteId: string) => void
  onWeekRetry?: () => void
  // ---- B-TH-244 (threads plan TH-4: the overall view) ----
  onGroup?: (group: 'party' | null) => void
  onToggleGroup?: (partyId: string) => void
  onGroupMore?: (partyId: string) => void
  onGroupRetry?: (partyId: string) => void
  onSummaryRetry?: () => void
  /** A door term's chip ✕ (or all of them: null). */
  onClearExtra?: (key: keyof ExtraTerms | null) => void
  /** A door term set from a cell (At risk narrows the sheet). */
  onExtra?: (extra: ExtraTerms) => void
  // F-CP-140: the Price check cell's funnel — narrows the sheet to the orders whose check reads so (the host gives it with the
  // `priceMatch` term, F-CP-141; without it the cell's words stand alone).
  // F-CP-141: the term in ONE write — no `view`: the funnel (narrows the view shown); with `view`: that view and the term alone (the
  // Not equal view: rows=all); null drops it (leaving the Not equal view for `view`). A price holder's only (absent otherwise).
  onPriceMatch?: (match: PriceMatch | null, view?: { readonly rows: RowView; readonly waiting?: 'us' | null }) => void
  /**
   * F-CW-101 (lead settle S16): a door of a phase — that phase alone beside `rows=all` (every order: a phase is defined over all of
   * them), the search and the waiting term dropped, in ONE write: the rows are exactly the group's count. null drops the term (all
   * orders again); null with `view`: leaving the door for that view, in the same write (each view stands alone).
   */
  onPhase?: (phase: OrderPhase | null, view?: { readonly rows: RowView; readonly waiting?: 'us' | null }) => void
  /** The columns on screen changed (the Progress column reads the floor only while shown). */
  onShownColumns?: (ids: readonly string[]) => void
  onInvoiceShipped?: (ids: readonly string[]) => void
  onInvoiceShippedRetry?: () => void
  onCloseInvoiceDrafts?: () => void
  // ---- B-TH-245 (threads plan TH-4: the sheet's cells edit) ----
  /** A cell (or Edit N) saved: the row's new note and version (custom values stay in the list frame). */
  onCellSaved?: (id: string, after: Readonly<Record<string, string | number | null>>, version: number) => void
  /** F-SA-221: made-to-measure orders only, or every kind (null); `rows` with it (the built-in view Made-to-measure: the open ones). */
  onKind?: (kind: 'mtm' | null, rows?: RowView) => void
  /** F-SA-222: the rider chip's ✕ (every rider again). */
  onProfile?: (profile: null) => void
  /** F-SA-214: a board card has the focus or its picture is open large (true): live re-reads wait behind "N updates · Show". */
  onBoardHold?: (held: boolean) => void
  /** F-SA-275 / F-SA-281: Add task… on these orders (a row's ⋯: one order; the selection's Add task to N…: one batch); absent: no such door. */
  onAddTask?: (ids: readonly string[], from?: 'row' | 'selection') => void
  /** F-SA-281: the New task window's own actions. */
  task?: { readonly onCreate: (draft: TaskDraft) => Promise<boolean>; readonly onSend: (draft: TaskDraft, assignee: BatchAssignee) => Promise<BatchAnswer | null>; readonly onRetryPeople: () => void; readonly onClose: () => void }
  /** F-SA-276: the waiting term (null clears it); `rows` with it (the built-in view "Waiting on us": the open ones). */
  onWaiting?: (waiting: 'us' | null, rows?: RowView) => void
  /** F-CP-102: one of the host's own views picked in Views ▾ (model.hostViews). */
  onHostView?: (id: string) => void
  /** F-CP-105: "Columns: Work · Money" picked (the host writes its page term `cols`). */
  onColumnSet?: (set: 'work' | 'money') => void
  /** F-CP-105: a host's own kept page term set (null: dropped) in one write through the sheet (every other term kept). */
  onPageTerm?: (name: string, value: string | null) => void
  // ---- F-SA-280 ----
  onAssignSupervisor?: (ids: readonly string[]) => void
  supervisor?: AssignSupervisorActions
  onNote?: (ids: readonly string[]) => void
  /**
   * F-CW-202 (10-design §4, §6 W2): Ask ▾ › "Ask production about N…" — production's ONE Note window opened as an ask ("Each record's
   * supervisor" and "Needs an answer" ticked); the caller gives its title and its Send word, said in the page's language.
   */
  onAskProduction?: (ids: readonly string[], words: { readonly title: string; readonly send: string; /** F-CW-303: what the rows then say. */ readonly hint?: string }) => void
  // ---- F-CW-301: Ship N together… (the ticked orders) and a row's Create shipment… — Warehouse's own window and its own actions ----
  onShipTogether?: (ids: readonly string[]) => void
  onCreateShipment?: (id: string) => void
  ship?: NewShipmentActions
  onDismissShip?: () => void
  // ---- end F-CW-301
  // ---- F-CW-302: an urgency act over these orders (a row's ⋯: one; More ▾: the ticked ones it runs on) — the shared window opens ----
  onUrgency?: (act: UrgencyAct, ids: readonly string[]) => void
  urgency?: SheetUrgencyActions
  // ---- end F-CW-302
  note?: NoteDialogActions
  // ---- end F-SA-280
  // ---- F-SA-282: Reply to <customer> on N… on the ticked orders, and the window's own actions
  // F-CW-203: `todo` — "Ask <customer> about N…": the same window with the to-do tick ON.
  onReplyMany?: (ids: readonly string[], options?: { readonly todo?: boolean }) => void
  replyMany?: ReplyManyActions
  // F-CP-114: open the customer's-price window of one order (given only to a price holder: no door, no call for anyone else).
  onPriceCheck?: (orderId: string) => void
  priceCheck?: PriceCheckDialogActions
  // ---- F-CP-108: a row's ⋯ "Next steps" opens the order page's command in place (the ONE window), and the window's own actions.
  onCommand?: (orderId: string, command: WindowCommand) => void
  command?: OrderCommandActions
  // ---- end F-CP-108
  // ---- F-CP-109: the bar's Mark N ready… · Close N… · Confirm N… on the ticked orders (≤ 50), and the bulk window's own actions.
  onCommandMany?: (ids: readonly string[], command: ManyCommand) => void
  commandMany?: OrderCommandManyActions
  // ---- end F-CP-109
  // ---- F-SA-279: the keys moved the focus to a row (the page's dock follows after its rest); a phone card's conversation door ----
  onFocusRow?: (row: OrderRow) => void
  onCardThread?: (row: OrderRow) => void
  // ---- end F-SA-279
}
