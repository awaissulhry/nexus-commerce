import type { ReactNode } from 'react' // B-W2b-340
import type { StyleDetail, StyleRow, VersionsAnswer } from '../../quotes/api'
import type { AmendmentsAnswer, CancelCheck, CancelReason, CloseLinesAnswer, CopyAnswer, DepositLinkAnswer, DepositReceived, Order, OrderWorkOrder, Schedule, SdiStatus, Settlement } from '../api'
import type { AmendReview, DraftLine } from '../daily-model' // F-OP-106: the strip's preview
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules' // F-OP-107 (B2)
import type { ClosePreview } from '../api' // F-OP-107
import type { MarginTabModel } from './margin/model'
import type { StepUpState } from '../hooks'
import type { OrderAbilities, Phrase, RecordTab } from '../model'
import type { ScheduleStepsActions, ScheduleStepsModel } from './schedule/view/StepVerbs'
import type { OrderDepthActions, OrderDepthModel } from '../depth/use-order-depth' // B-W2b-323
import type { LinksActions, LinksModel } from './links/model' // B-TH-256
// F-SA-230: the ⋯ menu's People (the production lane's dialogs, reused in place).
import type { AssignSupervisorActions, AssignSupervisorModel } from '../../../_shared/production-supervisor/model'
import type { NoteDialogActions, NoteDialogModel } from '../../../production/_shared/notes/model'
// F-SA-232: Overview's production read (the order's own pieces) and the live stream's state.
import type { ProductionState } from './overview/model'
import type { LiveState } from '../hooks'
import type { ReadinessRow } from '../../../production/work-orders/daily/api' // F-SA-234
import type { HealthActions, HealthModel } from '../../../../lib/production/health/model' // F-SA-235: the one HealthCard
import type { BrandRequest } from '../../../home/approvals/requests/api' // F-SA-236
import type { OfficeRequest } from '../../../../record-panels/approvals/api' // F-SA-236
import type { RequestDoorParts } from '../../../home/approvals/requests/view/RequestReview' // F-SA-243
import type { OrderFilesModel } from '../../../../lib/record-thread/files-view/model' // F-SA-237
import type { FilesViewActions } from '../../../../lib/record-thread/files-view/view/FilesView' // F-SA-237
import type { ToldChanges } from './told' // F-SA-244
import type { ApiClient } from '../../../../lib/api/client' // F-OP-134: the tab acts hooks' base (RecordActsBase)
import type { ShipToAddress } from '../api' // F-OP-111
import type { SplitPartDraft, SplitRefusal } from '../model' // F-OP-111
// F-OP-112: Make work orders… in place — the Production page's New work order dialog (its model, its actions, the lane's rights).
import type { NewWorkOrderModel, WorkOrdersListActions } from '../../../production/work-orders/list-model'
import type { ProductionCan } from '../../../production/_shared/model'
import type { JoinableRow } from './shipments/model' // F-OP-122
// F-OP-113: the work-order rows' acts in place (lib/production/work-order-acts, mounted by use-production-acts).
import type { WorkOrderActsActions, WorkOrderActsModel } from '../../../../lib/production/work-order-acts/use-work-order-acts'
import type { RejectReason } from '../../../home/approvals/api' // F-OP-101
import type { WorkOrderChange } from '../../../home/approvals/work-order-changes/api' // F-OP-116
import type { ChangeReviewActions, ChangeReviewModel } from '../../../home/approvals/work-order-changes/model' // F-OP-116
// F-CP-142: Money's "Price check" card and the ONE customer's-price window it opens (so/price-check, F-CP-114).
import type { PriceCheckCardActions, PriceCheckCardModel } from './price-check-card'
import type { PriceCheckDialogActions, PriceCheckDialogModel } from '../price-check/use-price-check'
import { amendBodyOf, amendHeld, draftOf } from '../daily-model' // F-OO-144: Requested's small dialog (the amend builder, its rule)
import type { MilestonesActions, MilestonesModel } from '../../../planning/milestones/view-model' // F-OO-145: Planning's gate dialogs in place
import type { CreditState } from './overview/where' // F-OO-106: the order's own credit hold

/** SCR-039 — the order studio's view model (OrderRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** One part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export const PART_LOADING = { value: null, problem: null } as const

// ---- F-OP-134 (N-5): the dialogs split by the tab acts hook that owns them (record/use-*-acts.ts). The page still opens ONE dialog
// at a time: RecordDialog is the container's one slot, and each hook's `opened` clears what its own dialog showed last.
/** use-band-acts: the band's primary and its ⋯ (Change promise date, Mark ready, Close order; B-W2a-50: Copy as a new quote). */
// F-OP-101: Refuse… of an open yes (its task; the words are typed in the dialog).
// F-OO-143 (replaces F-OP-105): `followUp` — Next dates' Decide… on a new date the customer refused: the ONE promise dialog with the
// refused request named (its follow-up task has the request's id); a new date closes it in the same command (B-OP-025). Absent:
// Change… (the band, Next dates' Promised row, Production › Dates).
export type BandDialog = { kind: 'promise'; followUp?: { readonly requestId: string } } | { kind: 'ready' } | { kind: 'close' } | { kind: 'copyQuote' } | { kind: 'refuseYes'; taskId: string }
/** use-lines-acts: the lines (close and reopen lines, the cancel; F-OP-111: the split; F-OP-106: the amendment has no dialog — its strip). */
// F-OO-124: Close short / Reopen ONE line (Overview › Progress by line ⋯): `lineIds` — the lines the dialog opens ticked (absent: every
// line it offers, as the band's ⋯ and the Lines tab open it).
// F-OO-144: `requested` — Next dates' "Requested by customer" Change…: a small dialog, ONE amendment (every line as it is + the new date).
export type LinesDialog = { kind: 'closeLines'; lineIds?: readonly string[] } | { kind: 'reopenLines'; lineIds?: readonly string[] } | { kind: 'cancel' } | { kind: 'split' } | { kind: 'requested' }
/** use-money-acts: the deposits and payments (the bank-details page, the payment, the TD02's send to SDI). */
export type MoneyDialog = { kind: 'depositLink'; requestId: string } | { kind: 'depositPayment'; requestId: string } | { kind: 'sdiSend'; invoiceId: string }
/** The container's own: Changes' Before → after (the amendments' snapshots are the Changes tab's read, kept in the container). */
export type ChangesDialog = { kind: 'compare'; amendmentId: string }
/**
 * F-OO-210: use-overview-acts — Order facts' office note (the sheet's own write). `refused`: its refusal in this page's words, said in
 * the dialog (what was typed stays; a new opening starts without it).
 */
// F-OO-106: "Where it is now"'s credit strip — Check credit again (a confirm) and Ask for a yes… on the hold's check (its id: the
// lock); `refused`: the API's refusal in this page's words, said in the dialog (nobody to ask, checked meanwhile …).
export type OverviewDialog = { kind: 'note'; refused?: Phrase } | { kind: 'creditCheck'; refused?: Phrase } | { kind: 'creditAsk'; checkId: string; refused?: Phrase }
export type RecordDialog = BandDialog | LinesDialog | MoneyDialog | ChangesDialog | OverviewDialog /* F-OO-210 */

// ---- F-OO-124: the lines Close remaining lines / Reopen lines opens with ticked ----
/**
 * The dialog's own lines when it names them (a line's row ⋯ — only those it still offers: a line closed or reopened meanwhile is not
 * ticked), else what a design case typed, else every line it offers (the band's ⋯, the Lines tab).
 */
export function dialogLinesOf(dialog: RecordDialog | null, kind: 'closeLines' | 'reopenLines', offered: readonly string[], typed?: readonly string[]): string[] {
  const asked = dialog?.kind === kind && 'lineIds' in dialog ? dialog.lineIds : undefined
  if (asked) return offered.filter((id) => asked.includes(id))
  return [...(typed ?? offered)]
}
// ---- end F-OO-124

/** F-OO-125: a style group's card in the Lines edit mode (Overview › Progress by line ⋯ "Change quantity or sizes…" focuses it). */
export const amendStyleAnchorOf = (styleId: string): string => `amend-style-${styleId}`

/** F-OO-209: the customer PO field of the Lines edit mode (Overview › Order facts' Customer PO "Change…" focuses it: one edit path). */
export const CUSTOMER_REF_FIELD_ID = 'amend-customer-ref'

// ---- F-OO-144 (order overview 10-design §4.2; review F7): "Requested by customer" — a small dialog, no page hop, no API change ----
/**
 * The ONE amendment the dialog sends, built by the amend builder the Lines edit mode uses (daily-model amendBodyOf): every line as it
 * is (its whole size grid, no price, no text: so no line can be removed or closed short by mistake), the new requested date, the
 * order's version as read and the reason. The customer PO and the delivery address stay as they are (not sent).
 */
export function requestedBodyOf(order: Order, date: string, reason: string) {
  const body = amendBodyOf({ lines: draftOf(order), customerRef: order.customerRef ?? '', requestedDate: date }, order)
  return { version: order.version, reason: reason.trim(), ...body }
}

/** The dialog's own problem with what is typed, or null: a date from today on, not the requested date already; a reason. */
export function requestedProblem(input: { readonly date: string; readonly reason: string; readonly today: string; readonly current: string | null }): Phrase | null {
  if (input.date === '') return { key: 'promise.problem.date' }
  if (input.date < input.today) return { key: 'facts.requested.problem.past' }
  if (input.date === input.current) return { key: 'facts.requested.problem.same' }
  if (input.reason.trim() === '') return { key: 'promise.problem.reason' }
  return null
}

/** Why the dialog's Change the date waits: the amendment's own rule (amendHeld), else a draft open on Lines (review or discard it first). */
export function requestedHeld(order: Order, model: Pick<OrderRecordModel, 'can' | 'amend'>): Phrase | null {
  return amendHeld(order, model.can) ?? (model.amend ? { key: 'held.amending' } : null)
}
// ---- end F-OO-144

// ---- F-OO-110 (order overview §1.4; N3, B-OO-003): cancel a waiting order ----
/**
 * A waiting order's cancel also takes back the yes asked on it (the API withdraws its open SALES_ORDER and CREDIT_OVERRIDE requests
 * in the same command, cancelOrderInCommand): the Cancel dialog says so — only while it waits and a yes is asked on it (one this
 * reader sees, or one counted but not shown). Nobody asked yet: nothing is taken back, nothing said.
 */
export function cancelTakesBackYes(order: Pick<Order, 'status' | 'openApprovals' | 'openApprovalsHidden'>): boolean {
  if (order.status !== 'PENDING_APPROVAL') return false
  return (order.openApprovals ?? []).some((task) => task.kind === 'SALES_ORDER' || task.kind === 'CREDIT_OVERRIDE') || (order.openApprovalsHidden ?? 0) > 0
}
// ---- end F-OO-110

/** One write of the page (the container's): the order it answers replaces the page's; a refusal is said in the dialog or the notice. */
export type RecordWrite = (run: () => Promise<Order | null>, success: string | null, keepDialog?: boolean) => Promise<void>

/** What the container hands every tab acts hook: the API, the order as last read (a write sends its version), the one write. */
export interface RecordActsBase {
  readonly api: ApiClient
  readonly orderId: string
  /** The order as last read (a ref: an act reads it when it runs, never a value of an older render). */
  readonly current: { readonly current: Order | null }
  readonly write: RecordWrite
  /** The version a write sends (the order as last read). */
  readonly version: () => number
  readonly setNotice: (notice: OrderRecordModel['notice']) => void
  /** Read the order again (and its parts). */
  readonly load: () => Promise<void>
  /** Read the order's parts again (work orders, money, versions, schedule). */
  readonly loadParts: (order: Order) => void
}
// ---- end F-OP-134

/** "Add a style" in the lines editor: type a style, pick its colours, Add (their rows open in its grid). */
export interface ComposerState {
  query: string
  /** null: not searched yet (or a search is on its way when `searching`). */
  results: StyleRow[] | null
  searching: boolean
  problem: string | null
  chosen: StyleDetail | null
  picked: string[]
}

export const COMPOSER_EMPTY: ComposerState = Object.freeze({ query: '', results: null, searching: false, problem: null, chosen: null, picked: [] }) as ComposerState

/** "Amend order" (design order.lines.cards: the lines become an amendment draft; F-OP-106: its strip says what changes, ONE Apply). */
export interface AmendState {
  /** The number the amendment will get ("Amendment 2 — not applied"). */
  revision: number
  lines: DraftLine[]
  customerRef: string
  requestedDate: string
  /** Each style of the draft as read (sizes, colourways, offered sizes): undefined while read, null when it failed. */
  styles: Record<string, StyleDetail | null | undefined>
  composer: ComposerState
  /** F-OP-106: the strip's read of the API's preview (asked 500 ms after the last edit and on blur, for the key of the draft then). */
  review: AmendReview | null
  // ---- F-OP-106: the strip's Why (required) and the words for the customer with their tick (null: not touched) ----
  reason: string
  tell: { readonly words: string; readonly chosen: boolean | null }
  /** F-OP-107 (B2): what happens to pieces already cut beyond the new figures (null: not picked yet). */
  extraOutcome: ExtraOutcome | null
  /** F-OP-108: the optional fee of a priced change (price grain), as typed; empty: none. */
  fee: string
  // ---- F-OP-110: Ship to in the header — the address picked ('' keeps the order's), the customer's delivery addresses (null: no
  // right to read them, parties.view) ----
  shipToAddressId?: string
  addresses?: Part<ShipToAddress[]> | null
}

// ---- F-OP-111: Split into new orders… (use-lines-acts) ----
export interface SplitState {
  /** The customer's delivery addresses a part may ship to (active, ours or approved by us); null: no right to read them (parties.view). */
  readonly addresses: Part<ShipToAddress[]> | null
  /** The API's refusals, each at its place (a part; null: the split as a whole). */
  readonly refusals: readonly SplitRefusal[]
  /** The new orders the split made (the dialog's done state, each a link); null: not split yet. */
  readonly made: readonly { readonly id: string; readonly number: string }[] | null
}
// ---- end F-OP-111

// ---- F-OP-112: Make work orders… in place (use-production-acts: the Production page's own hook, the order fixed) ----
export interface MakeWorkOrdersModel {
  /** The New work order dialog while open (its own view, NewWorkOrderDialog); null: closed. */
  readonly dialog: NewWorkOrderModel | null
  /** After a draft was made: the next style with open pieces ("Make the next one: <style>"); null: none, or nothing made yet. */
  readonly next: { readonly styleId: string; readonly code: string } | null
  /** The production lane's rights the dialog reads (workorders.manage: Create). */
  readonly can: ProductionCan
}

export interface MakeWorkOrdersActions {
  /** Open the dialog with the order fixed (on the next style when one is offered). */
  readonly onOpen?: () => void
  /** F-OO-123: open it for one line (Overview › Progress by line ⋯): the line's style, only that line ticked (still open). */
  readonly onOpenLine?: (lineId: string) => void
  /** The dialog's own actions (Cancel, the style step, the lines and sizes, Create). */
  readonly dialog?: Pick<WorkOrdersListActions, 'onNew' | 'newOrder'>
}
// ---- end F-OP-112

// ---- F-OP-101: the approver's yes in place (use-band-acts) ----
export interface YesActions {
  /** Confirm the order (or Approve another yes of it): the task's version sent; a fresh step-up first when its rule asks one. */
  readonly onConfirm?: (taskId: string) => void
  /** Refuse…: the dialog opens and reads the reasons a no names. */
  readonly onRefuse?: (taskId: string) => void
  /** The dialog's Refuse: the reason picked and the words typed (required). */
  readonly onRefuseConfirm?: (taskId: string, reasonCode: string, words: string) => void
  /** Read the reasons again (Try again). */
  readonly onRefuseReasons?: () => void
}
// ---- end F-OP-101

// ---- F-OP-116: decide in place — the order's work-order changes and the ONE decide window (use-production-acts) ----
export interface OrderChangesModel {
  /** Every work-order change of the order, newest first (the API's wall); null: not read yet. */
  readonly list: Part<WorkOrderChange[]> | null
  /** The decide window while one is open (Approvals' own model); null: closed. */
  readonly review: ChangeReviewModel | null
  readonly busy: boolean
}
export type OrderChangesActions = ChangeReviewActions & {
  /** Open the decide window on a change (null closes it). */
  readonly onOpen?: (changeId: string | null) => void
}
// ---- end F-OP-116

export interface OrderRecordModel {
  /** F-OP-116: the order's work-order changes and the decide window; absent: not read here (a design case). */
  orderChanges?: OrderChangesModel | null
  /** F-OP-101: the reasons a no names (the tenant's APPROVAL_REJECT list) while Refuse… is open; null: not open or not read. */
  refuseReasons?: Part<RejectReason[]> | null
  /** F-OP-112: Make work orders… on Production (the dialog, the next style); absent: not here (a design case). */
  makeWorkOrders?: MakeWorkOrdersModel | null
  /** F-OP-111: Split into new orders… — the dialog's addresses, refusals and the orders made; absent: not open here (a design case). */
  split?: SplitState | null
  /** B-W2b-180: ⋯ "See it in the customer's portal" (held: why); null/absent: not offered. */
  portal?: { held: Phrase | null; opening: boolean } | null
  /** F-SA-242: the portal said nobody of the customer reads this order there (NO_PORTAL): the conversation tick is held. */
  portalGone?: boolean
  prefix: string
  can: OrderAbilities
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  tab: RecordTab
  order: Loaded<Order>
  /** The work orders of its lines with their floor progress (workorders.view); null without the right. */
  workOrders: Part<OrderWorkOrder[]> | null
  /** Where the money stands (invoices.view); null without the right. */
  settlement: Part<Settlement> | null
  /** Each issued invoice's SDI state (invoices.view), by invoice id; null without the right. */
  sdi: Record<string, Part<SdiStatus>> | null
  /** The quote's versions with the acceptance evidence (quotes.view); null without the right or without a quote. */
  versions: Part<VersionsAnswer> | null
  /** B-TH-214: the person (the docked thread's width is remembered per person and record type on this device). */
  personId?: string | null
  /** B-TH-228: the request the order was made from straight (no quote between), for the band's "Made from INQ-… — Open"; office people who read requests only. */
  madeFrom?: { readonly id: string; readonly number: string } | null
  /** B-TH-228: the source read still runs (the band says neither "Made from" nor "Typed by the office" yet). */
  madeFromReading?: boolean
  /** Someone changed the order while a dialog holds typed work: "Changed at 10:42 · Reload". */
  /** F-SA-239: the parts that changed under typed work (their last change names who: the order read's `lastChange`). */
  changed: { at: string; parts?: readonly string[]; by?: string | null } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase; /* F-OP-121: a door the notice offers (Pack and ship it in Warehouse ›) */ door?: { href: string; words: Phrase } } | null
  busy: boolean
  dialog: RecordDialog | null
  /** A refused write while its dialog is open: said inside the dialog (what was typed stays). */
  dialogProblem: Phrase | null
  /** The bank-details page just sent (the dialog shows to whom and until when). */
  sentLink: DepositLinkAnswer | null
  /** The payment just recorded (the dialog shows what followed: PAID, the TD02). */
  recorded: DepositReceived | null
  stepUp: StepUpState
  // ---- B-W2a-50 ----------------------------------------------------------------------------------------------------------
  /** The Lines tab as an amendment draft; null: read-only. */
  amend: AmendState | null
  /** The payment schedule (Invoices & payments): null until read. */
  schedule: Part<Schedule> | null
  /** The Changes tab's amendments: null until read. */
  amendments: Part<AmendmentsAnswer> | null
  /** Styles the Changes tab names that the order no longer holds (their codes). */
  changeStyles: Record<string, StyleDetail | null | undefined>
  /** The cancel dialog's impact check: null until read. */
  cancelCheck: Part<CancelCheck> | null
  /** Close remaining lines just ran: what it closed, what work orders still make. */
  closedLines: CloseLinesAnswer | null
  /** F-OP-107: Close remaining lines' preview of the lines chosen (each work order's plan, the extra pieces); absent: not read. */
  closePreview?: Part<ClosePreview> | null
  /** Copy as new quote just ran: the new quote and what it left out. */
  copied: CopyAnswer | null
  /** B-W2a-72: the Margin tab (the order's margin quoted → now → so far; margin grain only). */
  margin?: MarginTabModel
  /** B-W2a-80: the schedule card's verbs (open a before-shipping step for payment, invoice a paid step). */
  scheduleSteps?: ScheduleStepsModel
  /** B-W2b-16: the CANCEL reasons (the code a close of lines names; the words of a closed line's code); null: not read. */
  cancelReasons?: readonly CancelReason[] | null
  /** B-W2b-323: the orders in depth (priority, season, the yes it waits for, what is frozen, priced changes, the customer's
   *  materials, the confirmation, the tech pack, the finish forecast, the milestones); absent: not drawn. */
  depth?: OrderDepthModel
  /** B-W2b-340: a colour line's "Options" (the configurator of the order line, its own container); absent: not drawn. */
  lineOptions?: (line: Order['lines'][number]) => ReactNode
  /** B-W2b-380 (XF6:02): the line's "cost changed since priced" mark (the cost grain; nothing when it did not move). */
  lineCost?: (line: Order['lines'][number]) => ReactNode
  /** B-W2b-374 (XF3:02): an amendment's new line's Options (OrderRecord mounts NewLineOptions). */
  newLineOptions?: (line: DraftLine) => ReactNode
  /** B-W2b-368 (XF1:02): "Waits for the factory review" (./review-banner), drawn by the container; absent: nothing to say. */
  reviewBanner?: ReactNode
  /** B-TH-256: what points at the order (./links) — its complaints and returns, planning's open re-promises, the gates' refusals; absent: not read. */
  links?: LinksModel | null
  /** F-SA-230: ⋯ People — Assign supervisor… (production.brand.manage) and Ask the supervisor… (threads.post), with their open dialogs. */
  people?: { readonly mayAssign: boolean; readonly mayNote: boolean; readonly assign: AssignSupervisorModel | null; readonly note: NoteDialogModel | null }
  /** F-SA-232: the order's production read (OR1: stage, health, waiting, own pieces per line …); absent: not read here (a design case). */
  production?: ProductionState | null
  /** F-SA-234: the materials' readiness of the work orders on Production (the production lane's word per work order); null: not read. */
  readiness?: Part<ReadinessRow[]> | null
  /** F-SA-237: the order's files (the Files tab; the same read as the thread's Files window); absent: not read here. */
  files?: OrderFilesModel | null
  /** F-OP-119: the tracking dialog of the one shipment opened on Shipments (its container: use-shipments-acts); null: none open. */
  shipmentTracking?: ReactNode | null
  /** F-OP-121: Warehouse's New shipment, opened in place (its container). */
  newShipment?: ReactNode | null
  /** F-OP-122: the customer's DRAFT shipments (same site and address) this order may join; null: not read or not offered. */
  joinable?: JoinableRow[] | null
  /** F-OP-113: the work-order rows' acts on Production (saves, the floor's told time, the open dialog); absent: none here. */
  workOrderActs?: WorkOrderActsModel | null
  /**
   * F-OP-123 (order page N5): "Record a shipment made elsewhere…" — its door held with words (null: open) and its dialog while open
   * (its container: use-shipments-acts); absent: not offered here (a design case).
   */
  elsewhere?: { readonly held: Phrase | null; readonly dialog: ReactNode | null } | null
  /** F-SA-236: the order's customer requests, every state (Changes: waiting on us, history); null: not read here. */
  requests?: Part<BrandRequest[]> | null
  /**
   * F-SA-243: the ONE review window on this page (requests/use-request-review-door.ts): its state, its notice after an answer, and
   * the address that opens it on a request of this order (`?open=<id>`, the tab kept). Absent (a design case): Answer… opens nothing.
   */
  requestDoor?: { readonly parts: RequestDoorParts; readonly hrefOf: (id: string) => string; /* F-SA-244: open it with no reload */ readonly open?: (id: string) => void } | null
  /** F-SA-244: the told lines of the order's changes (History's Told line, Production's floor time, Overview's count); null: not read. */
  told?: Part<ToldChanges> | null
  /** F-SA-236: the approvals we asked the customer on this order (partners.approvals.view); null: not read (no right, or not here). */
  askedOfCustomer?: Part<OfficeRequest[]> | null
  /** F-SA-235: the order's health on Production (the work order record's HealthCard; workorders.view); absent: not read. */
  health?: HealthModel | null
  /** F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line); null: closed. */
  overviewLine?: string | null
  /**
   * F-OO-145: Next dates' steps before production — Planning's own model for THIS order (use-gate-acts: a one-order subset of the
   * page's read) with the gate dialog open; null/absent: not here (a design case without it).
   */
  gateActs?: MilestonesModel | null
  /**
   * F-OO-106: the order's credit while it waits on its own credit hold — read with sales.credit.view only (use-overview-acts);
   * absent: not here (a design case without it).
   */
  credit?: CreditState | null
  // F-OO-121: product.styles.manage — a line with no picture offers "Add on the style ›" (anyone else reads the words alone); absent: no.
  stylesManage?: boolean
  /** F-SA-232: the page's live stream (the freshness line says "Live · as of 10:42" only when pushed). */
  liveState?: LiveState
  // ---- F-CP-142 (customer page plan C3): Money's "Price check" card — a price holder's read (use-price-check-card.ts); without the
  // price grain the card is one line of words whatever this holds; absent: not read here (a design case). The window while open.
  priceCheck?: PriceCheckCardModel | null
  priceCheckDialog?: PriceCheckDialogModel | null
  // ---- end F-CP-142
  /** Design cases: what a dialog holds typed. */
  draft?: { date?: string; reason?: string; reasonCode?: string; lineIds?: string[]; scope?: 'order' | 'lines'; amount?: string; reference?: string; receivedOn?: string; issue?: boolean; message?: string; typed?: string }
}

export interface PaymentInput {
  amount: number
  receivedOn: string
  reference: string
  note: string
  issue: boolean
}

export interface OrderRecordActions {
  /** F-OP-116: open / decide a work-order change in place (Apply, Leave as is). */
  orderChanges?: OrderChangesActions
  /** F-OP-116: Done on one of the order's production tasks (Still to do; the task's own right, R-12). */
  onTaskDone?: (taskId: string, version: number) => void
  /** F-OP-101: the approver's yes in place (the band's "Waiting for a yes", an old change's waiting row). */
  yes?: YesActions
  /** F-OP-112: Make work orders… on Production (open it; the dialog's own actions). */
  makeWorkOrders?: MakeWorkOrdersActions
  /** F-OP-119: open the tracking number of a shipment of the order (Shipments: row ⋯, or Enter on its Tracking cell). */
  onShipmentTracking?: (shipmentId: string) => void
  /** F-OP-121: Create shipment… in place (this order and the customer's others beside it). */
  onCreateShipment?: () => void
  /** F-OP-122: Add this order's garments… to a DRAFT of the same customer (the same step 2). */
  onJoinShipment?: (shipmentId: string) => void
  /** F-OP-113: a work-order row's act in place (due, priority, rush) or from its ⋯ (the dialog's own acts). */
  workOrderActs?: WorkOrderActsActions
  /** F-OP-123: open "Record a shipment made elsewhere…" (⋯ Next steps, the Shipments card head). */
  onRecordElsewhere?: () => void
  /** F-OP-111: split the parts off into new orders (the dialog's parts as typed, the optional reason). */
  onSplit?: (input: { parts: readonly SplitPartDraft[]; reason: string }) => void
  /** B-W2b-180 (design sales.orders conn "Portal › Orders & tracking"): open the order in the customer's portal, read-only. */
  onPortal?: () => void
  /** F-SA-244: Who was told of one change (by its system line). */
  onWhoWasTold?: (messageId: string) => void
  /** B-W2a-80: the schedule card's verbs. */
  scheduleSteps?: ScheduleStepsActions
  onRetry?: () => void
  onRetryPart?: (part: 'workOrders' | 'settlement' | 'sdi' | 'versions' | 'schedule' | 'amendments' | 'cancelCheck' | 'requests') => void
  onReload?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onPromise?: (input: { date: string; reason: string; lineIds: string[] | null }) => void
  onReady?: (reason: string) => void
  onClose?: (reason: string | null) => void
  onSendLink?: (requestId: string, message: string) => void
  onRecordPayment?: (requestId: string, input: PaymentInput) => void
  onSendSdi?: (invoiceId: string) => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  // ---- B-W2a-50 ----------------------------------------------------------------------------------------------------------
  onAmendStart?: () => void
  onAmendDiscard?: () => void
  onAmendCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onAmendPrice?: (key: string, text: string) => void
  onAmendHeader?: (field: 'customerRef' | 'requestedDate' | 'shipToAddressId' /* F-OP-110 */, value: string) => void
  /** F-OP-110: ⋯ Change ship-to… — edit mode with Ship to focused (one edit path). */
  onChangeShipTo?: () => void
  // ---- F-OP-106: the strip — ask its preview now (blur, Try again), Why, the words for the customer and their tick, ONE Apply
  onAmendPreview?: () => void
  onAmendReason?: (text: string) => void
  onAmendTell?: (next: { readonly words?: string; readonly chosen?: boolean }) => void
  // F-OP-108: `asPriced` — a frozen field makes it "Apply as a priced change" (the strip's fee goes with it).
  onAmendApply?: (asPriced?: boolean) => void
  onAmendFee?: (text: string) => void
  /** F-OP-109: a line's Text… (its description or note for production), and Remove line (every size to 0). */
  onAmendText?: (key: string, field: 'description' | 'note', text: string) => void
  onAmendRemove?: (key: string) => void
  /** F-OP-107 (B2): the extra pieces' outcome (the strip's picker). */
  onAmendOutcome?: (outcome: ExtraOutcome) => void
  /** F-OP-107: read Close remaining lines' preview of the lines chosen. */
  onClosePreview?: (lineIds: readonly string[]) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
  // F-OP-107: with the extra pieces' outcome picked in the dialog (null: none — production decides).
  onCloseLines?: (lineIds: string[], reason: string, reasonCode: string, extraOutcome?: ExtraOutcome | null) => void
  onReopenLines?: (lineIds: string[], reason: string) => void
  onCancelOrder?: (reason: string, typed: string, extraOutcome?: ExtraOutcome | null) => void
  onCopyAsQuote?: () => void
  /** B-W2a-72: read the Margin tab again. */
  onRetryMargin?: () => void
  /** B-W2b-323: the depth's actions; F-OP-108: "Deposit and words…" opens the priced change's own dialog with the draft's lines. */
  depth?: OrderDepthActions
  onPricedOffer?: () => void
  /** B-TH-256: Accept / Decline a re-promise, the "Tell the customer" tick, read the links again. */
  links?: LinksActions
  /** F-SA-237: the Files tab's open, select and bulk actions. */
  files?: FilesViewActions
  /** F-SA-235: the HealthCard's Raise to At risk, Clear, Try again. */
  health?: HealthActions
  /** F-SA-232: read the production again (Try again); open a line's sizes (null closes the window). */
  onRetryProduction?: () => void
  onOpenLine?: (rowId: string | null) => void
  /** F-OP-104: Next dates' requested date "Change…"; F-OO-144: it opens the small dialog (`{ kind: 'requested' }`), no page hop. */
  onRequestedChange?: () => void
  /** F-OO-144: the dialog's Change the date — ONE amendment: every line as it is, the new date, the version, the reason. */
  onRequestedDate?: (input: { readonly date: string; readonly reason: string }) => void
  /** F-OO-125: a line's "Change quantity or sizes…" (Overview › Progress by line ⋯) — edit mode on Lines, its style group focused. */
  onLineChange?: (styleId: string) => void
  /** F-OO-209: Order facts' Customer PO "Change…" — edit mode on Lines, the customer PO focused (the one edit path). */
  onCustomerRefChange?: () => void
  /** F-OO-210: the office note dialog's Save note — the Orders sheet's own write (sales.orders.editCells) with the order's version. */
  onNoteSave?: (note: string) => void
  /** F-OO-145: a gate's Move the date… (onEdit), Mark done… (onPass), Start before the gate… (onStartBefore) and the dialogs' own acts. */
  gateActs?: MilestonesActions
  /** F-OO-106: the credit strip's own acts — the dialogs' Check again and Ask (the page's one write), read the credit again. */
  credit?: { readonly onCheck?: () => void; readonly onAsk?: (checkId: string, note: string) => void; readonly onRetry?: () => void }
  /** F-SA-230: ⋯ People — open the assign dialog or the note to the supervisor; the dialogs' own actions. */
  people?: { readonly onAssign?: () => void; readonly onAsk?: () => void; readonly assign?: AssignSupervisorActions; readonly note?: NoteDialogActions }
  /** F-CP-142: the Price check card (Customer's price…, Take them over, Try again) and the ONE window's own actions. */
  priceCheck?: PriceCheckCardActions
  priceCheckDialog?: PriceCheckDialogActions
}

/** The lines editor's own actions (the amendment and the typed New order share it). */
export interface EditorActions {
  onCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onPrice?: (key: string, text: string) => void
  /** F-OP-109 (amend mode): a line's description or note for production; Remove line. */
  onText?: (key: string, field: 'description' | 'note', text: string) => void
  onRemove?: (key: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
}
