import type { ReactNode } from 'react' // B-W2b-340
import type { StyleDetail, StyleRow, VersionsAnswer } from '../../quotes/api'
import type { AmendmentsAnswer, AmendPreview, CancelCheck, CancelReason, CloseLinesAnswer, CopyAnswer, DepositLinkAnswer, DepositReceived, Order, OrderWorkOrder, Schedule, SdiStatus, Settlement } from '../api'
import type { DraftLine } from '../daily-model'
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
import type { OrderFilesModel } from '../../../../lib/record-thread/files-view/model' // F-SA-237
import type { FilesViewActions } from '../../../../lib/record-thread/files-view/view/FilesView' // F-SA-237

/** SCR-039 — the order studio's view model (OrderRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** One part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export const PART_LOADING = { value: null, problem: null } as const

export type RecordDialog =
  | { kind: 'promise' }
  | { kind: 'ready' }
  | { kind: 'close' }
  | { kind: 'depositLink'; requestId: string }
  | { kind: 'depositPayment'; requestId: string }
  | { kind: 'sdiSend'; invoiceId: string }
  // B-W2a-50 (the order every day)
  | { kind: 'amendReview' }
  | { kind: 'closeLines' }
  | { kind: 'reopenLines' }
  | { kind: 'cancel' }
  | { kind: 'copyQuote' }
  | { kind: 'compare'; amendmentId: string }

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

/** "Amend order" (design order.lines.cards: the lines become an amendment draft until Review → Apply). */
export interface AmendState {
  /** The number the amendment will get ("Amendment 2 — not applied"). */
  revision: number
  lines: DraftLine[]
  customerRef: string
  requestedDate: string
  /** Each style of the draft as read (sizes, colourways, offered sizes): undefined while read, null when it failed. */
  styles: Record<string, StyleDetail | null | undefined>
  composer: ComposerState
  /** The review dialog's read of the API's preview. */
  review: { phase: 'reading' | 'ready' | 'failed'; preview: AmendPreview | null; problem: Phrase | null } | null
}

export interface OrderRecordModel {
  /** B-W2b-180: ⋯ "See it in the customer's portal" (held: why); null/absent: not offered. */
  portal?: { held: Phrase | null; opening: boolean } | null
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
  changed: { at: string } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
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
  /** F-SA-236: the order's customer requests, every state (Changes: waiting on us, history); null: not read here. */
  requests?: Part<BrandRequest[]> | null
  /** F-SA-236: the approvals we asked the customer on this order (partners.approvals.view); null: not read (no right, or not here). */
  askedOfCustomer?: Part<OfficeRequest[]> | null
  /** F-SA-235: the order's health on Production (the work order record's HealthCard; workorders.view); absent: not read. */
  health?: HealthModel | null
  /** F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line); null: closed. */
  overviewLine?: string | null
  /** F-SA-232: the page's live stream (the freshness line says "Live · as of 10:42" only when pushed). */
  liveState?: LiveState
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
  /** B-W2b-180 (design sales.orders conn "Portal › Orders & tracking"): open the order in the customer's portal, read-only. */
  onPortal?: () => void
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
  onAmendHeader?: (field: 'customerRef' | 'requestedDate', value: string) => void
  onAmendReview?: () => void
  onAmendApply?: (reason: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
  onCloseLines?: (lineIds: string[], reason: string, reasonCode: string) => void
  onReopenLines?: (lineIds: string[], reason: string) => void
  onCancelOrder?: (reason: string, typed: string) => void
  onCopyAsQuote?: () => void
  /** B-W2a-72: read the Margin tab again. */
  onRetryMargin?: () => void
  /** B-W2b-323: the depth's actions, and "Send as a priced change" from Review amendment (the draft's lines go with it). */
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
  /** F-SA-230: ⋯ People — open the assign dialog or the note to the supervisor; the dialogs' own actions. */
  people?: { readonly onAssign?: () => void; readonly onAsk?: () => void; readonly assign?: AssignSupervisorActions; readonly note?: NoteDialogActions }
}

/** The lines editor's own actions (the amendment and the typed New order share it). */
export interface EditorActions {
  onCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onPrice?: (key: string, text: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
}
