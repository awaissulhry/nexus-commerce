import type { LiveState } from '../../../quality/_shared/model'
import type { CaseRecord, ContactOption, LinkCandidate, LinkRecordType, PartyOption, Person, ReasonOption } from '../api'
import type { CaseDraft, CoverDraft, MoveAction, MoveDraft, Notice, RecordTab, RepairDraft, ReturnDraft, ServiceCan } from '../model'

export type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly record: CaseRecord }
  | { readonly status: 'notFound' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error'; readonly problem: string }

interface DialogBase {
  readonly busy: boolean
  readonly notice: Notice | null
}

/** The case's dialogs: a move with its words (and the status mail), the cover decided, a link, an unlink, a repair, a return. */
export type RecordDialog =
  | (DialogBase & { readonly kind: 'move'; readonly draft: MoveDraft })
  | (DialogBase & { readonly kind: 'decide'; readonly draft: CoverDraft })
  | (DialogBase & {
      readonly kind: 'link'
      readonly recordType: LinkRecordType
      readonly q: string
      readonly found: { readonly items: readonly LinkCandidate[] | null; readonly reading: boolean; readonly problem: string | null }
      readonly picked: LinkCandidate | null
      readonly note: string
    })
  | (DialogBase & { readonly kind: 'unlink'; readonly linkId: string })
  | (DialogBase & { readonly kind: 'repair'; readonly draft: RepairDraft })
  | (DialogBase & { readonly kind: 'return'; readonly draft: ReturnDraft; readonly reasons: { readonly items: readonly ReasonOption[] | null; readonly problem: string | null } })

export interface ServiceRecordModel {
  readonly prefix: string
  readonly me: string
  readonly today: string
  readonly can: ServiceCan
  readonly tab: RecordTab
  readonly loaded: Loaded
  readonly live: LiveState
  readonly asOf: string | null
  /** Who may own the case (GET …/people); null while reading or when the read failed. */
  readonly owners: readonly Person[] | null
  /** The Case form's customer and contact pickers. */
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null }
  readonly contacts: { readonly items: readonly ContactOption[] | null; readonly problem: string | null }
  /** The Case form's draft (null: as read). */
  readonly draft: CaseDraft | null
  readonly saving: boolean
  readonly dialog: RecordDialog | null
  readonly notice: Notice | null
  /** The case changed elsewhere while a dialog or the draft held work (the time it was seen). */
  readonly stale: string | null
  /** A move that asks for nothing is running. */
  readonly busy: boolean
  readonly copied: boolean
}

export interface ServiceRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDraft?: (patch: Partial<CaseDraft>) => void
  onDiscard?: () => void
  onSave?: () => void
  /** A move: at once when it asks for nothing, else its dialog. */
  onMove?: (action: MoveAction) => void
  onDialog?: (dialog: RecordDialog | null) => void
  onDialogChange?: (patch: Record<string, unknown>) => void
  onSubmitDialog?: () => void
  onFindLinkable?: (recordType: LinkRecordType, q: string) => void
  onCopy?: () => void
  onDismissNotice?: () => void
}
