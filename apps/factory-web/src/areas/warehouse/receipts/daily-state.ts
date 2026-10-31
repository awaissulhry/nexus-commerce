import type { SettleStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import type { WizardActions } from '../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../products/styles/import/sheet-import'
import type { PickerReason } from '../../_shared/reasons/api'
import type { Part } from '../../_shared/buying/model'
import type { Discrepancy, HideListSummary } from './daily-api'
import type { ClaimDraft, DdtFixDraft, DiscrepancyDraft, ReceiptDailyCan, ReportDraft, RequestDraft, Say } from './daily-model'

/**
 * The view models of the receipt's W2a parts (B-W2a-63): what the record's Documents check and Discrepancies tabs and
 * their dialogs draw, and the list's tannery hide list. The views fetch nothing; the containers (record/ReceiptRecord.tsx,
 * list/ReceiptsPage.tsx) read, write and fill these.
 */

export type DailyDialog =
  | { kind: 'discrepancy'; draft: DiscrepancyDraft }
  | { kind: 'settle'; id: string; to: SettleStatus; note: string }
  | { kind: 'remove'; id: string }
  | { kind: 'report'; draft: ReportDraft }
  | { kind: 'claim'; draft: ClaimDraft }
  | { kind: 'request'; draft: RequestDraft }
  /** B-W2b-14: the supplier's DDT number and date corrected on the posted receipt. */
  | { kind: 'ddtFix'; draft: DdtFixDraft }

export interface DailyNotice {
  tone: 'success' | 'danger' | 'info' | 'warning'
  words: Say
  /** A link to what the act made (the claim, the report's PDF). */
  link?: { words: Say; href: string; newTab?: boolean } | null
}

export interface ReceiptDailyModel {
  can: ReceiptDailyCan
  /** The receipt's discrepancies (GET …/discrepancies). */
  discrepancies: Part<Discrepancy[]>
  /** The DISCREPANCY and CLAIM reason lists (GET /reasons). */
  reasons: Part<PickerReason[]>
  dialog: DailyDialog | null
  busy: boolean
  /** The open dialog's refusal. */
  problem: Say | null
  notice: DailyNotice | null
  /** The discrepancy shown in its detail (`?open=<id>`). */
  open: string | null
  /** Photo addresses by file id (absent: loading; null: could not be read). */
  photos: Readonly<Record<string, string | null>>
  /** The DDT photo's camera step is open on the Documents tab. */
  ddtStep: boolean
  /** A photo is being uploaded (the DDT's or a discrepancy's). */
  uploading: boolean
  /** Design cases: the rows ticked on the Discrepancies tab. */
  selected?: readonly string[]
}

export interface ReceiptDailyActions {
  onDialog?: (dialog: DailyDialog | null) => void
  onSaveDiscrepancy?: () => void
  onSettle?: () => void
  onRemove?: () => void
  onSendReport?: () => void
  onClaim?: () => void
  onRequest?: () => void
  /** B-W2b-14: save the DDT correction. */
  onSaveDdtFix?: () => void
  onOpen?: (id: string | null) => void
  onDdtStep?: (open: boolean) => void
  onDdtPhoto?: (photo: Blob) => void | Promise<void>
  onAddPhoto?: (discrepancyId: string, photo: Blob) => void | Promise<void>
  onPhotos?: (fileIds: readonly string[]) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

export interface HideListModel {
  /** Why Import hide list is held, or null. */
  held: Say | null
  /** The import wizard while it is open (null: closed). */
  sheet: SheetImport | null
  /** The last list's totals against its order and the receipt it made (null: no list this visit). */
  summary: { importId: string; part: Part<HideListSummary> } | null
  /** Design cases: the wizard drawn in place. */
  inline?: boolean
}

export interface HideListActions {
  onOpen?: () => void
  wizard?: WizardActions
  onRetrySummary?: () => void
  onDismiss?: () => void
}
