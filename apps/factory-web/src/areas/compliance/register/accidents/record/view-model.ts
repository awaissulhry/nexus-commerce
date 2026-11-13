import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { SafetyPhotosModel } from '../../../../../lib/safety-reports/view/SafetyPhotos'
import type { LiveState } from '../../../../quality/_shared/model'
import type { Injury, Report, Revision } from '../api'
import type { InjuryDraft, RecordTab, ReviseDraft, SafetyCan } from '../model'

/** SCR-421-record — a product-safety report in the office (B-W2b-357): what the view draws. */

export interface FactsDraft {
  readonly serial: string
  readonly batchNumber: string
  readonly size: string
  readonly occurredOn: string
  readonly worn: 'yes' | 'no' | 'unsure'
}

export type RecordDialog =
  | { readonly kind: 'close'; readonly note: string }
  | { readonly kind: 'revise'; readonly draft: ReviseDraft; readonly first: boolean; readonly told: boolean }
  | { readonly kind: 'eraseReporter'; readonly reason: string }
  | { readonly kind: 'eraseInjury'; readonly reason: string }
  | { readonly kind: 'recordInjury'; readonly draft: InjuryDraft }
  | { readonly kind: 'facts'; readonly draft: FactsDraft }
  | { readonly kind: 'file' }

export interface DialogState {
  readonly dialog: RecordDialog
  /** Create / Save was pressed: the problems are shown. */
  readonly tried: boolean
  readonly busy: boolean
  /** The API refused (a key). */
  readonly problem: string | null
}

export type InjuryState = { readonly state: 'closed' } | { readonly state: 'reading' } | { readonly state: 'failed' } | { readonly state: 'open'; readonly value: Injury; readonly at: string }

export interface ReportRecordModel {
  readonly prefix: string
  readonly tab: RecordTab
  readonly can: SafetyCan
  readonly today: string
  readonly report: Report | null
  /** The record's read failed (a key), or it is missing / not allowed. */
  readonly problem: string | null
  readonly revisions: { readonly items: readonly Revision[] | null; readonly problem: string | null }
  readonly injury: InjuryState
  /** A photo is being opened (its id). */
  readonly opening: string | null
  /** Add a photo (the office's own, no window). */
  readonly photos: SafetyPhotosModel | null
  readonly dialog: DialogState | null
  /** A receipt or a refusal above the tabs (keys). */
  readonly notice: { readonly key: string; readonly tone: 'success' | 'info' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string | number>> } | null
  readonly live: LiveState
  /** Someone changed it while a dialog held work. */
  readonly changed: boolean
  readonly offline?: boolean
}

export interface ReportRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onSeen?: () => void
  onAssess?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onDialogChange?: (dialog: RecordDialog) => void
  onDialogSubmit?: () => void
  onOpenInjury?: () => void
  onHideInjury?: () => void
  onOpenPhoto?: (fileId: string) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  photos?: {
    onAdd?: () => void
    onCapture?: (photo: CapturedPhoto) => void | Promise<void>
    onCloseCapture?: () => void
    onRetry?: (key: string) => void
  }
}
