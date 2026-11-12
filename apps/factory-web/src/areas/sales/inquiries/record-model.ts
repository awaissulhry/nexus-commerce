import type { LiveState } from '../../../shell/live/use-live'
import type { Assignees, ContactOption, InquiryView, PartyOption, StyleOption } from './api'
import type { DeclineDraft, InquiriesCan, LineDraft, Loaded, Notice, RecordTab, RequestDraft } from './model'
import type { StyleRead } from './view/LinesEditor'

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

export type RecordVerb = 'quote' | 'assign' | 'decline' | 'lost' | 'askInfo' | 'resume' | 'unassign'

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
  /** The customers a prospect may be matched to (parties.view); null without the right. */
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null } | null
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
}

export interface InquiryRecordActions {
  onTab?: (tab: RecordTab) => void
  onDraft?: (patch: Partial<RequestDraft>) => void
  onLines?: (lines: LineDraft[]) => void
  onStyle?: (styleId: string) => void
  /** A prospect matched to a customer (its contacts are read), or the match undone. */
  onMatch?: (partyId: string | null) => void
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
  dialog?: {
    onAssign?: (assigneeId: string | null) => void
    onRetryPeople?: () => void
    onDecline?: (patch: Partial<DeclineDraft>) => void
    onLostNote?: (note: string) => void
    onRef?: (customerRef: string) => void
    onSubmit?: () => void
    onClose?: () => void
  }
}
