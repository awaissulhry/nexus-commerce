import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { CountsAnswer, GapRow, GapsAnswer, IssuedAnswer, IssuesAnswer, ItemRecord, ItemsAnswer, KitsAnswer, PpeItem, Supplier } from './api'
import type { IssueDraft, ItemDraft, PpeAddress, PpeCan, Problem } from './model'

/** One read of one section: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A line the page says after a write (and what was refused, in words). */
export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** Issue PPE (design pop:issue): the people to choose from (with their kit), the company's active items, the draft. */
export interface IssueState {
  readonly people: Read<readonly GapRow[]>
  readonly items: Read<readonly PpeItem[]>
  readonly draft: IssueDraft
  readonly busy: boolean
  readonly problem: Problem | null
  /** The paper receipt was recorded; its scan was refused or not chosen: said, with how to add it from Issues. */
  readonly recorded: { readonly answer: IssuedAnswer; readonly scanProblem: string | null } | null
}

/** PPE item (design pop:item): a new item or an existing one (with the role kits naming it), the supplier list. */
export interface ItemState {
  readonly id: string | null
  readonly read: Read<ItemRecord> | null
  readonly draft: ItemDraft
  readonly suppliers: Read<readonly Supplier[]> | null
  readonly busy: boolean
  readonly problem: Problem | null
  readonly saved: { readonly key: string } | null
}

/** Void an issue (design pop:void): the line, the reason; the receipt stays with a void mark. */
export interface VoidState {
  readonly issueId: string
  readonly reason: string
  readonly busy: boolean
  readonly problem: Problem | null
}

/** The signed scan of a paper receipt, added from Issues (files.upload). */
export interface ScanState {
  readonly receiptId: string
  readonly file: { readonly name: string; readonly type: string; readonly size: number } | null
  readonly busy: boolean
  readonly problem: Problem | null
}

/** Archive N items of the catalogue (one call each; an item a role kit names is refused, said in words). */
export interface ArchiveManyState {
  readonly ids: readonly string[]
  readonly busy: boolean
}

/** A role sheet changed (live): the kit of a role, how many of its people now miss items (the gaps read again). */
export interface RoleBanner {
  readonly role: string
  readonly people: number
}

export interface PpePageModel {
  readonly prefix: string
  readonly can: PpeCan
  readonly scope: OfficeScope
  readonly companyId: string | null
  readonly address: PpeAddress
  /** The floor tablet's Receive PPE screen is built (model.ts TABLET_RECEIPT_READY). */
  readonly tabletReady: boolean
  /** The role sheets' page is built (Plant › Risk assessment): Kits per role links to it. */
  readonly riskPage: boolean
  readonly counts: Read<CountsAnswer>
  readonly gaps: Read<GapsAnswer>
  readonly issues: Read<IssuesAnswer>
  readonly kits: Read<KitsAnswer>
  readonly items: Read<ItemsAnswer>
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly roleBanner: RoleBanner | null
  readonly selected?: readonly string[]
  readonly issue: IssueState | null
  readonly item: ItemState | null
  readonly voiding: VoidState | null
  readonly scan: ScanState | null
  readonly archiveMany: ArchiveManyState | null
  /** "Start from common items" running. */
  readonly commonBusy: boolean
  readonly keysOpen?: boolean
  /** The instant "now" for the date checks (the design cases fix it). */
  readonly now: string
}

export interface PpePageActions {
  onAddress?: (change: Partial<PpeAddress>) => void
  onRetry?: (section: 'counts' | 'gaps' | 'issues' | 'kits' | 'catalogue') => void
  onDismissNotice?: () => void
  onDismissRoleBanner?: () => void
  onSelected?: (ids: string[]) => void
  onIssueDraft?: (draft: IssueDraft, scan?: File | null) => void
  onIssuePerson?: (employeeId: string | null) => void
  onIssue?: () => void
  onRetryIssue?: () => void
  onItemDraft?: (draft: ItemDraft) => void
  onSaveItem?: () => void
  onItemStatus?: (to: 'archive' | 'restore') => void
  onRetryItem?: () => void
  onVoidReason?: (reason: string) => void
  onVoid?: () => void
  onScanFile?: (file: File | null) => void
  onUploadScan?: () => void
  onArchiveMany?: (ids: readonly string[] | null) => void
  onApplyArchiveMany?: () => void
  onCommon?: () => void
  onPrintReceipts?: (receiptIds: readonly string[]) => void
  onPrintCards?: (employeeIds: readonly string[]) => void
}
