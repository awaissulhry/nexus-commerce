import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { CountsAnswer, IncidentAction, IncidentPerson, IncidentRecord, IncidentRow, InailFiling, InailRule, PickedMachine, PickedPerson, PlantPlaces } from './api'
import type { ActionDraft, EditDraft, FilingDraft, IncidentsAddress, IncidentsCan, PersonDraft, Problem, ReportDraft, TileId } from './model'

/**
 * The view models of SCR-210 (the list page, its Report dialog), SCR-210-record (the record's tabs and dialogs) and
 * SCR-210-print. One model per view, nothing fetched in a view; the people and the filings' types are here only as a
 * protected read handed them (the page's state, never the address).
 */

export type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Record<string, string | number>
  /** A bulk action's refused rows: the row's label and the reason's key. */
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
  /** The record this notice names (the report sent: "Open INC-…"). */
  readonly open?: { readonly id: string; readonly number: string } | null
}

// ---- the list page ---------------------------------------------------------------------------------------------------------

export interface ListState {
  readonly rows: readonly IncidentRow[]
  readonly nextCursor: string | null
  readonly canReport: boolean
  /** The server's clock of the first read (the countdowns count from each dueAt). */
  readonly now: string
}

/** "Show people" (design sec:list: "behind a 'Show people' toggle that is recorded"). In the page's state only. */
export type ShowPeople =
  | { readonly state: 'hidden' }
  | { readonly state: 'confirm' }
  | { readonly state: 'reading' }
  | { readonly state: 'shown'; readonly byIncident: Readonly<Record<string, readonly IncidentPerson[]>>; readonly at: string; readonly count: number }
  | { readonly state: 'error'; readonly problem: string }

export interface ReportDialogState {
  readonly draft: ReportDraft
  readonly places: Read<PlantPlaces> | null
  readonly machines: Read<readonly PickedMachine[]> | null
  readonly people: Read<{ people: readonly PickedPerson[]; complete: boolean }> | null
  readonly peopleQuery: string
  readonly photos: readonly CapturedPhoto[]
  readonly capturing: boolean
  readonly busy: boolean
  readonly problem: Problem | null
  /** The site the report is for (the top bar's, or chosen in the dialog with "All sites"). */
  readonly siteId: string | null
}

export interface IncidentsPageModel {
  readonly prefix: string
  readonly can: IncidentsCan
  readonly scope: OfficeScope
  readonly companyId: string | null
  readonly address: IncidentsAddress
  readonly today: string
  readonly counts: Read<CountsAnswer>
  readonly list: Read<ListState>
  readonly listMore: boolean
  readonly readAt: string | null
  readonly people: ShowPeople
  readonly report: ReportDialogState | null
  readonly notice: PageNotice | null
  readonly selected?: readonly string[]
  readonly bulkBusy: boolean
  readonly keysOpen?: boolean
  readonly reportHeld?: string | null
}

export interface IncidentsPageActions {
  onAddress?: (change: Partial<IncidentsAddress>) => void
  onTile?: (tile: TileId) => void
  onRetryCounts?: () => void
  onRetryList?: () => void
  onMore?: () => void
  onOpen?: (row: IncidentRow) => void
  onAskPeople?: () => void
  onShowPeople?: () => void
  onHidePeople?: () => void
  onDismissNotice?: () => void
  onBulkSeen?: (rows: readonly IncidentRow[]) => Promise<void> | void
  onSelected?: (ids: string[]) => void
  // the Report dialog
  onReportDraft?: (draft: ReportDraft) => void
  onReportSite?: (siteId: string) => void
  onReportPeopleQuery?: (q: string) => void
  onReportPerson?: (person: PersonDraft | null, key?: string) => void
  onReportCapture?: (open: boolean) => void
  onReportPhoto?: (photo: CapturedPhoto) => void
  onReportRemovePhoto?: (index: number) => void
  onReportSend?: () => void
  onReportClose?: () => void
}

// ---- the record --------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['report', 'actions', 'authority'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** A protected read on the record (people or filings): asked, reading, open (with when it was recorded), failed. */
export type Protected<T> = { readonly state: 'closed' } | { readonly state: 'reading' } | { readonly state: 'open'; readonly value: T; readonly at: string } | { readonly state: 'error'; readonly problem: string }

export type RecordDialog =
  | { readonly kind: 'close' | 'reopen'; readonly busy: boolean; readonly problem: Problem | null }
  | { readonly kind: 'cancel'; readonly reason: string; readonly busy: boolean; readonly problem: Problem | null }
  | { readonly kind: 'action'; readonly actionId: string | 'new'; readonly mode: 'view' | 'make' | 'done' | 'cancel' | 'edit'; readonly draft: ActionDraft; readonly machines: Read<readonly PickedMachine[]> | null; readonly busy: boolean; readonly problem: Problem | null }
  | { readonly kind: 'filing'; readonly draft: FilingDraft; readonly busy: boolean; readonly problem: Problem | null; readonly done: readonly string[] }
  | { readonly kind: 'photo'; readonly busy: boolean; readonly problem: Problem | null }
  | { readonly kind: 'peopleNote'; readonly then: 'people' | 'filings' }

export interface FilingsOpen {
  readonly filings: readonly InailFiling[]
  readonly rule: InailRule
  readonly now: string
}

export interface IncidentRecordModel {
  readonly prefix: string
  readonly can: IncidentsCan
  readonly tab: RecordTab
  readonly loaded: { status: 'loading' } | { status: 'ready'; value: { now: string; incident: IncidentRecord } } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }
  readonly live: 'connecting' | 'live' | 'offline'
  readonly asOf: string | null
  readonly people: Protected<readonly IncidentPerson[]>
  readonly filings: Protected<FilingsOpen>
  readonly edit: { readonly draft: EditDraft; readonly busy: boolean; readonly problem: Problem | null } | null
  readonly dialog: RecordDialog | null
  readonly notice: PageNotice | null
  /** The photos' addresses as read (a presigned GET lives 60 s: read when shown). */
  readonly photoUrls: Readonly<Record<string, string>>
  readonly selected?: readonly string[]
  readonly bulkBusy: boolean
  readonly keysOpen?: boolean
  readonly locale?: 'it' | 'en'
  /** The person's own id (an action's owner "me"). */
  readonly userId: string
}

export interface IncidentRecordActions {
  onRetry?: () => void
  onDismissNotice?: () => void
  onOpenPeople?: () => void
  onHidePeople?: () => void
  onOpenFilings?: () => void
  onHideFilings?: () => void
  onConfirmNote?: () => void
  onEdit?: (draft: EditDraft | null) => void
  onSaveEdit?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onClose?: () => void
  onReopen?: () => void
  onCancel?: () => void
  onCancelReason?: (reason: string) => void
  onActionDraft?: (draft: ActionDraft) => void
  onActionMode?: (mode: 'view' | 'make' | 'done' | 'cancel' | 'edit', into?: ActionDraft['into']) => void
  onActionSave?: () => void
  onBulkDone?: (actions: readonly IncidentAction[]) => Promise<void> | void
  onSelected?: (ids: string[]) => void
  onFilingDraft?: (draft: FilingDraft) => void
  onFilingSave?: () => void
  onFilingNeeded?: (filing: InailFiling, needed: boolean) => void
  onOpenReceipt?: (filing: InailFiling) => void
  onPhoto?: (photo: CapturedPhoto) => void
  onPhotoOpen?: (fileId: string) => void
}
