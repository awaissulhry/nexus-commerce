import type { LiveState } from '../../quality/_shared/model'
import type { Coverage, CoverageRow, DocKind, ListAnswer, PackView, Preview, Unrecorded } from './api'
import type { ContentDraft, DeclarationsAddress, DeclarationsCan, Problem, RecordAddress, RecordDoc } from './model'

/** One read of one part: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export const loadingRead = { status: 'loading' } as const
export const readyRead = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failedRead = <T>(problem: string): Read<T> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

/** A line the page says after a write, and what a bulk write could not do. */
export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** New declaration (design pop:dc-new): style, kind, languages (the original first), market, packs, the live preview. */
export interface NewState {
  readonly styleId: string | null
  readonly kind: DocKind
  readonly languages: readonly string[]
  readonly marketCode: string | null
  /** User information: the markets whose language packs start with it. */
  readonly packs: readonly string[]
  /** A style of every company: the company whose document it is (the page's by default). */
  readonly companyId: string | null
  readonly preview: Read<Preview> | null
  readonly busy: boolean
  readonly problem: Problem | null
}

/** Translate (design pop:dc-translate) from the grid or a coverage cell: the original, the languages to add. */
export interface TranslateState {
  readonly originalId: string
  readonly kind: DocKind
  readonly label: string
  readonly options: readonly string[]
  readonly languages: readonly string[]
  readonly busy: boolean
  readonly problem: Problem | null
}

/** Language check (design pop:dc-langcheck): "Translate the gaps" running. */
export interface LanguageCheckState {
  readonly busy: boolean
}

/** The batches that left without a recorded version (the fifth tile): the list, the shipment being recorded. */
export interface UnrecordedState {
  readonly read: Read<readonly Unrecorded[]>
  readonly busy: string | null
  readonly problem: Problem | null
}

export interface DeclarationsPageModel {
  readonly prefix: string
  readonly can: DeclarationsCan
  /** The company the page works in (a style of every company is made for it by default). */
  readonly companyId: string | null
  readonly companies: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  readonly address: DeclarationsAddress
  readonly coverage: Read<Coverage>
  readonly list: Read<ListAnswer>
  readonly readAt: string | null
  readonly live: LiveState
  readonly updates: number
  readonly notice: PageNotice | null
  readonly selected: readonly string[]
  readonly selectedCoverage: readonly string[]
  readonly add: NewState | null
  readonly translate: TranslateState | null
  readonly check: LanguageCheckState | null
  readonly unrecorded: UnrecordedState | null
  readonly online: boolean
  /** Design cases: the keys panel open. */
  readonly keysOpen?: boolean
}

export interface DeclarationsPageActions {
  onAddress?: (change: Partial<DeclarationsAddress>) => void
  onRetry?: (part: 'coverage' | 'list') => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onSelected?: (ids: string[]) => void
  onSelectedCoverage?: (keys: string[]) => void
  onNew?: (change: Partial<NewState>) => void
  onCreate?: () => void
  onCell?: (row: CoverageRow, language: string) => void
  onTranslateRow?: (originalId: string) => void
  onTranslate?: (change: Partial<TranslateState> | null) => void
  onStartTranslate?: () => void
  onOpen?: (documentId: string) => void
  onTranslateGaps?: (keys: readonly string[]) => void
  onRecordShipment?: (shipmentId: string) => void
  onRetryUnrecorded?: () => void
  onCopy?: (text: string, what: string) => void
  onExport?: (ids: readonly string[]) => void
}

/** The record's PDF beside the fields: the document whose PDF it is, and its bytes (a draft) or its address (a signed file). */
export interface PreviewState {
  readonly documentId: string
  readonly pdf: Read<Uint8Array | string> | null
}

export interface RecordModel {
  readonly prefix: string
  readonly can: DeclarationsCan
  readonly userId: string
  readonly address: RecordAddress
  readonly read: Read<RecordDoc>
  readonly readAt: string | null
  readonly live: LiveState
  /** A live change of this document arrived while a draft was open: "Read again". */
  readonly changedAt: string | null
  readonly notice: PageNotice | null
  readonly preview: PreviewState | null
  /** Content in edit mode: what is typed. */
  readonly draft: ContentDraft | null
  readonly busy: boolean
  readonly problem: Problem | null
  readonly reason: string
  readonly typed: string
  readonly translateLanguages: readonly string[]
  readonly translatePacks: readonly string[]
  /** The languages the markets need (Translate's choices). */
  readonly marketLanguages: readonly string[]
  readonly online: boolean
}

export interface RecordActions {
  onAddress?: (change: Partial<RecordAddress>) => void
  onRetry?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onPreview?: (documentId: string) => void
  onRetryPreview?: () => void
  onDraft?: (draft: ContentDraft) => void
  onEdit?: (on: boolean) => void
  onSave?: () => void
  onRefresh?: () => void
  onReason?: (reason: string) => void
  onTyped?: (typed: string) => void
  onWithdraw?: () => void
  onTranslateChoice?: (languages: readonly string[], packs: readonly string[]) => void
  onTranslate?: () => void
  onCheck?: () => void
  onBackToTranslator?: (documentId: string, version: number) => void
  onCopy?: (text: string, what: string) => void
  onOpenPdf?: () => void
}

export interface PdfWindowModel {
  readonly prefix: string
  readonly read: Read<RecordDoc>
  readonly shownId: string | null
  readonly pdf: Read<Uint8Array | string> | null
}

export interface PdfWindowActions {
  onShow?: (documentId: string) => void
  onRetry?: () => void
}

export interface PackWindowModel {
  readonly prefix: string
  readonly can: DeclarationsCan
  readonly shipmentId: string | null
  readonly pack: Read<PackView> | null
  readonly versionId: string | null
  readonly pdf: Read<Uint8Array> | null
  readonly busy: 'make' | 'share' | 'zip' | null
  readonly notice: PageNotice | null
  readonly problem: Problem | null
  readonly online: boolean
}

export interface PackWindowActions {
  onVersion?: (versionId: string) => void
  onMake?: (share: boolean) => void
  onZip?: () => void
  onRetry?: () => void
  onDismiss?: () => void
}
