import type { LiveState } from '../../_shared/model'
import type { Complaint, ComplaintSeverity, OfficeChannel, SiteOption, StatusMove, StyleOption } from '../api'
import type { ComplaintsCan } from '../model'
import type { Notice, PhotoView, TriageActions, TriageModel } from '../view-model'

/** The record's tabs (design rec:Complaint): Complaint · Linked records · Activity (Investigation and Answer are W2b). */
export const RECORD_TABS = ['complaint', 'linked', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The facts the Complaint tab edits (EditModeBar), as typed. */
export interface FactsDraft {
  readonly description: string
  readonly customerRef: string
  readonly channel: OfficeChannel | ''
  readonly styleId: string
  readonly size: string
  readonly serial: string
  readonly batchNumber: string
  readonly internalNote: string
}

export type RecordDialog =
  | { readonly kind: 'move'; readonly to: StatusMove; readonly note: string }
  | { readonly kind: 'close'; readonly reason: string }
  | { readonly kind: 'acknowledge' }
  | { readonly kind: 'register'; readonly risk: 'NO' | 'ASSESSING' | 'YES' }
  | { readonly kind: 'ncr'; readonly siteId: string; readonly severity: ComplaintSeverity | '' }
  | { readonly kind: 'repair'; readonly siteId: string; readonly received: boolean }

export interface ComplaintRecordModel {
  readonly prefix: string
  readonly can: ComplaintsCan
  readonly tab: RecordTab
  readonly complaint: Complaint
  readonly photos: readonly PhotoView[]
  readonly asOf: string | null
  readonly live: LiveState
  readonly offline: boolean
  readonly today: string
  readonly notice: Notice | null
  /** The complaint changed (live) while a dialog or an edit was open: Reload. */
  readonly changedAt: string | null
  /** The Complaint tab's facts in edit mode (null: shown as text). */
  readonly edit: { readonly draft: FactsDraft; readonly busy: boolean; readonly problem: string | null } | null
  readonly styles: readonly StyleOption[] | null
  readonly dialog: RecordDialog | null
  readonly dialogBusy: boolean
  readonly dialogProblem: string | null
  /** The company's sites (an NCR or a repair from the complaint), null while not read or without the right. */
  readonly sites: readonly SiteOption[] | null
  /** The record's own triage (Triage when new, or a re-triage). */
  readonly triage: TriageModel | null
  readonly dockOpen: boolean
  /** Where the records it names open (`<type>:<id>` → the company's address: their page once built, else their panels). */
  readonly hrefs: Readonly<Record<string, string>>
}

export interface ComplaintRecordActions extends TriageActions {
  onTriage?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  /** The open dialog's step (the acknowledgement passes its note). */
  onDialogSubmit?: (note?: string | null) => void
  onEdit?: (on: boolean) => void
  onEditDraft?: (patch: Partial<FactsDraft>) => void
  onEditSave?: () => void
  onReload?: () => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  onDock?: () => void
}
