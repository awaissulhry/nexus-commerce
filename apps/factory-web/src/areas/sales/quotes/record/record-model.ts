import type { PdfInput } from '@nexus/ui/components/PdfViewer/index'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import type { ApprovalRow, PartyDetail, QuoteDetail, QuoteVersionRow, StyleDetail, StyleRow } from '../api'
import type { Grains, QuoteAbilities, QuoteTab, Tone } from '../model'

/**
 * The quote record's view model (SCR-035; design sales.quotes "Record: Quote"): everything the record view draws, from
 * the container (QuoteRecord.tsx). Loaded parts say whether they are there, still coming or failed; nothing is fetched by
 * the view.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

export type QuoteDialog = 'ask' | 'withdraw' | 'reject' | 'approve' | 'cancel' | 'revise' | 'newLink' | 'reopen'

export interface QuoteNotice {
  key: string
  tone: Tone
  params?: Record<string, string | number>
}

export interface SaveState {
  state: 'idle' | 'saving' | 'saved' | 'failed'
  /** The last time the server confirmed a change. */
  at: string | null
}

export interface ComposerState {
  query: string
  /** null: not searched yet. */
  results: StyleRow[] | null
  problem: string | null
  /** The style picked, with its colourways. */
  chosen: StyleDetail | null
  /** The colourways ticked for the new block (all by default). */
  picked: readonly string[]
}

export interface QuoteRecordViewModel {
  /** `/w/<company>` */
  prefix: string
  /** The signed-in person (never decides their own request). */
  me: string
  tab: QuoteTab
  grains: Grains
  can: QuoteAbilities
  quote: Loaded<QuoteDetail>
  /** Each style of the lines (its sizes, colourways and what each colourway is made in); null: could not be read. */
  styles: Readonly<Record<string, StyleDetail | null>>
  /** A block's grid as typed and not yet confirmed by the server: style → colourway → size → pieces. */
  drafts: Readonly<Record<string, Record<string, Record<string, number>>>>
  /** Colourways chosen for a block that hold no piece yet (no line until they do). */
  pendingColourways: Readonly<Record<string, readonly string[]>>
  /** A price typed for a colour line not saved yet: `${styleId}:${colourwayId}` → text. */
  prices: Readonly<Record<string, string>>
  save: SaveState
  composer: ComposerState
  versions: { items: QuoteVersionRow[] | null; people: Readonly<Record<string, string>>; problem: string | null }
  approvals: { items: ApprovalRow[] | null; problem: string | null }
  party: { value: PartyDetail | null; problem: string | null }
  /** The Documents tab's preview language (a draft's PDF is made by the server in either). */
  previewLanguage: 'it' | 'en'
  /** The PDF the Documents tab shows: the live preview (draft) or the frozen one (sent); null while it is found. */
  document: { src: PdfInput | null; openHref: string | null; problem: string | null; frozen: boolean }
  /** The send dialog (null: closed). */
  send: DocumentSendModel | null
  dialog: QuoteDialog | null
  busy: boolean
  notice: QuoteNotice | null
  /** Someone else changed the quote while the person had unsaved work. */
  changed: { at: string } | null
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  /** The thread beside the tab on a wide screen (Owner O1). */
  dockOpen: boolean
  /** The design index's stand-in for the record panels (the live page mounts the real ones). */
  panelsPreview?: RecordPanelsViewModel
}

export interface QuoteRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onCells?: (styleId: string, value: Record<string, Record<string, number>>) => void
  onPrice?: (styleId: string, colourwayId: string, text: string) => void
  onRemoveBlock?: (styleId: string) => void
  onAddColourway?: (styleId: string, colourwayId: string) => void
  onRetrySave?: () => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
  onComposerClear?: () => void
  onTermsSave?: (patch: Record<string, unknown>) => Promise<boolean>
  onDialog?: (dialog: QuoteDialog | null) => void
  onAsk?: (note: string) => Promise<boolean>
  onWithdraw?: (reason: string) => Promise<boolean>
  onApprove?: (note: string) => Promise<boolean>
  onReject?: (reason: string) => Promise<boolean>
  onCancelQuote?: (reason: string) => Promise<boolean>
  onRevise?: (changeNote: string) => Promise<boolean>
  onNewLink?: () => Promise<boolean>
  onOpenSend?: () => void
  onPreviewLanguage?: (language: 'it' | 'en') => void
  onDownload?: (fileId: string) => void
  onDismissNotice?: () => void
  onDock?: () => void
}
