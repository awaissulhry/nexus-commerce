import type { LiveState } from '../../../shell/live/use-live'
import type { Assignees, ContactOption, InquiryView, ScaleOption, StyleOption } from './api'
import type { DeclineDraft, InquiriesCan, LineDraft, Loaded, Notice, OrderDraft, RecordTab, RequestDraft, StyleDraftDraft } from './model'
// B-TH-234: make or match the customer, hand the customer a task.
import type { CustomerCheck } from './api'
import type { CustomerChoice, TaskDraft } from './model'
import type { StyleRead } from './view/LinesEditor'
// B-TH-252: "Start a project…" from the request (⋯ of the pane and the full page).
import type { StartProjectActions, StartProjectModel } from './start-project'

/**
 * The inquiry's record as its views draw it (design sales.inquiries rec:Inquiry — Request, Files & specs, Quote, Activity):
 * the same model for the DetailModal on the list (`?open=<id>&tab=`) and the full page in a new tab (`/sales/inquiries/<id>`).
 * The container (`use-inquiry.ts`) reads, keeps the Request draft and runs the verbs; the views draw this and report clicks.
 */

/** A dialog the record has open. */
export type RecordDialog =
  | { readonly kind: 'assign'; readonly people: Loaded<Assignees>; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'decline'; readonly draft: DeclineDraft; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'lost'; readonly note: string; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'quote'; readonly customerRef: string; readonly busy: boolean; readonly notice: Notice | null }
  // ---- B-TH-228: Make order, Make style draft
  | { readonly kind: 'order'; readonly draft: OrderDraft; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'styleDraft'; readonly draft: StyleDraftDraft; readonly scales: Loaded<readonly ScaleOption[]>; readonly busy: boolean; readonly notice: Notice | null }
  // ---- B-TH-234: make or match the customer from the prospect (the check first), "Ask <customer> for…" a task in its portal
  | { readonly kind: 'customer'; readonly check: Loaded<CustomerCheck>; readonly choice: CustomerChoice | null; readonly confirmed: boolean; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'task'; readonly draft: TaskDraft; readonly busy: boolean; readonly notice: Notice | null }

export type RecordVerb = 'quote' | 'assign' | 'decline' | 'lost' | 'askInfo' | 'resume' | 'unassign' | 'order' | 'styleDraft' | /* B-TH-234 */ 'customer' | 'task' | 'notAnOrder'

export interface InquiryRecordModel {
  readonly prefix: string
  readonly me: string
  readonly can: InquiriesCan
  readonly live: LiveState
  readonly loaded: Loaded<InquiryView>
  readonly tab: RecordTab
  /** The Request (and the tech pack) as typed; null = as read. */
  readonly draft: RequestDraft | null
  readonly saving: boolean
  /** A verb without a dialog running (ask for more information, resume, take off). */
  readonly busy: boolean
  /** The contacts of the inquiry's customer (or the one being matched). */
  readonly contacts: { readonly items: readonly ContactOption[] | null; readonly problem: string | null } | null
  readonly styles: { readonly items: readonly StyleOption[] | null; readonly problem: string | null } | null
  readonly details: Readonly<Record<string, StyleRead>>
  /** Someone changed the inquiry while a draft was open: when (the banner offers Reload). */
  readonly stale: string | null
  readonly notice: Notice | null
  readonly dialog: RecordDialog | null
  /** The mail's remote pictures were allowed (Show pictures). */
  readonly pictures: boolean
  // ---- B-TH-252: "Start a project…" — why the ⋯ line is held (a key of `sales-incoming-pane`, null: it may) and its dialog when open.
  readonly startProject?: { readonly held: string | null; readonly dialog: StartProjectModel | null }
}

export interface InquiryRecordActions {
  onTab?: (tab: RecordTab) => void
  onDraft?: (patch: Partial<RequestDraft>) => void
  onLines?: (lines: LineDraft[]) => void
  onStyle?: (styleId: string) => void
  onTechPack?: (fileId: string, on: boolean) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
  onReload?: () => void
  onPictures?: () => void
  onVerb?: (verb: RecordVerb) => void
  onOpenFile?: (fileId: string) => void
  onCopy?: () => void
  onDismissNotice?: () => void
  // ---- B-TH-252: "Start a project…" (open the dialog; its draft, Start, close).
  startProject?: StartProjectActions & { readonly onOpen?: () => void }
  dialog?: {
    onAssign?: (assigneeId: string | null) => void
    onRetryPeople?: () => void
    onDecline?: (patch: Partial<DeclineDraft>) => void
    onLostNote?: (note: string) => void
    onRef?: (customerRef: string) => void
    onSubmit?: () => void
    onClose?: () => void
    // B-TH-228
    onOrderDraft?: (patch: Partial<OrderDraft>) => void
    onStyleDraft?: (patch: Partial<StyleDraftDraft>) => void
    // B-TH-234
    onCustomer?: (patch: { choice?: CustomerChoice | null; confirmed?: boolean }) => void
    onTask?: (patch: Partial<TaskDraft>) => void
    onRetryCheck?: () => void
  }
}
