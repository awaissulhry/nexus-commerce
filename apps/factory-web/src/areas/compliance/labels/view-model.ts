import type { LiveState, Notice, Read } from '../../quality/_shared/model'
import type { Artwork, LabelChecks, Phrases, TextileChecks } from './depth/api'
import type { DepthCan, MarkingDraft } from './depth/model'
import type { LabelDetail, LabelTemplate, Preview, PreviewAsk, PrintJob, Printer, Rendered, StyleRow } from './api'
import type { LabelDraft, LabelsCan, LabelView, NewLabelDraft } from './model'
import type { ListDepth } from './depth/model'

/** The models the Labels & marking views draw (SCR-053): one per screen, built by the containers or the design fixtures. */

/** A style the search found (what the dialog shows of it). */
export type StyleHit = Pick<StyleRow, 'id' | 'code' | 'name' | 'ppeStandard' | 'ppeClass'>

export interface NewLabelModel {
  draft: NewLabelDraft
  /** The style search's answer (null value while it runs); none before a search. */
  styles: Read<StyleHit[]> | null
  styleQuery: string
  /** Labels the new one may start from (the loaded list). */
  sources: readonly LabelTemplate[]
  busy: boolean
  /** A message key of the refusal. */
  problem: string | null
}

export interface LabelsListModel {
  prefix: string
  can: LabelsCan
  view: LabelView
  query: string
  /** Every label the person may see (the API answers at most 500; the view filters on the page). */
  rows: Read<LabelTemplate[]>
  asOf: string | null
  live: LiveState
  updates: number
  selected: readonly string[]
  notice: Notice | null
  newLabel: NewLabelModel | null
  shortcuts?: boolean
  focusRow?: number
  /** B-W2b-270: the proofs waiting approval and the markets a label cannot print for (absent: not read, as W1). */
  depth?: ListDepth
}

export interface LabelsListActions {
  onQuery?: (query: string) => void
  onView?: (view: LabelView) => void
  onClearAll?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (row: LabelTemplate) => void
  onExport?: (rows: readonly LabelTemplate[]) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  onNewLabel?: (open: boolean) => void
  onNewDraft?: (draft: NewLabelDraft) => void
  onStyleQuery?: (query: string) => void
  onCreate?: () => void
  onShortcuts?: (open: boolean) => void
}

// B-W2b-270: Languages and Artwork & approval (design rec:Label tabs `languages`, `artwork`).
export type RecordTab = 'content' | 'languages' | 'artwork' | 'versions' | 'prints'

/** The colourways and sizes of the label's style (the preview's choices). */
export interface CellChoices {
  colourways: readonly { id: string; code: string; name: string }[]
  sizes: readonly string[]
}

export type RecordDialog =
  | { kind: 'activate' }
  | { kind: 'retire'; reason: string }
  | { kind: 'revise' }
  | { kind: 'test'; printerId: string | null; copies: number }
  | { kind: 'discard' }
  | { kind: 'shortcuts' }
  // B-W2b-270: a proof added, approved by a second person (pop:lb-approve) or retired; a phrase translated.
  | { kind: 'addProof'; note: string }
  | { kind: 'approveProof'; versionId: string; reason: string }
  | { kind: 'retireProof'; versionId: string; reason: string }
  | { kind: 'translate'; key: string; texts: Record<string, string> }

export interface TestPrintState {
  job: PrintJob | null
  label: Rendered | null
  printer: Printer | null
}

export interface LabelRecordModel {
  prefix: string
  can: LabelsCan
  tab: RecordTab
  detail: Read<LabelDetail>
  /** The business day the checks are made on (Europe/Rome; the API's "today"). */
  today: string
  /** The builder's form while a draft is edited (null: the saved content, read only or not yet opened). */
  draft: LabelDraft | null
  /** The server's render of the saved content for the asked cell, with the values it used. */
  preview: Read<Preview>
  ask: PreviewAsk
  /** The cells the preview may be drawn for: the style's colourways and sizes; null when not read (no product.styles.view). */
  style: CellChoices | null
  save: { state: 'idle' | 'saving' | 'failed'; at: string | null }
  live: LiveState
  /** Someone else changed the label meanwhile (live): the time. */
  changed: { at: string } | null
  notice: Notice | null
  dialog: RecordDialog | null
  /** The label printers (the test print's choice); null value while read; problem when not readable. */
  printers: Read<Printer[]>
  /** The label's test prints (Prints tab). */
  prints: Read<PrintJob[]>
  test: TestPrintState
  busy: boolean
  /** A dialog's refusal (message key) and the API's sentences under it. */
  problem: { key: string; lines?: readonly string[] } | null
  /** B-W2b-270: the label's W2b parts (absent: not read, as W1). */
  depth?: RecordDepth
}

/** A proof file picked to upload (its bytes read in the browser). */
export interface PickedProof {
  name: string
  contentType: string
  size: number
  bytes: ArrayBuffer
}

/** B-W2b-270: what the label record reads and edits beyond W1. */
export interface RecordDepth {
  can: DepthCan
  /** The person reading (a translation they proposed is approved by someone else). */
  me: string
  /** The marking checks per switched-on market and what the label must print (B-W2b-253). */
  checks: Read<LabelChecks>
  /** The market whose checks show (null: the first that blocks). */
  market: string | null
  /** The textile, leather and origin checks of the label's style (B-W2b-208); null: the label names no style. */
  textile: Read<TextileChecks> | null
  /** The draft's kind, GPSR contact and QR target while edited (null: the saved ones). */
  marking: MarkingDraft | null
  /** The artwork proofs and who may approve them (B-W2b-259). */
  artwork: Read<Artwork>
  /** The proof shown in the approve dialog: its bytes (a PDF) or its address (a picture). */
  proof: { versionId: string; src: Read<Uint8Array | string> } | null
  /** The proof picked in the add dialog. */
  picked: PickedProof | null
  /** The phrase library's cells for the label's phrases (B-W2b-249), read with the Languages tab. */
  phrases: Read<Phrases>
  /** The phrases selected in the Languages grid (their keys). */
  selectedPhrases: readonly string[]
  /** The cell being written (`key|language`). */
  writing: string | null
  /** The last refused cell write: where, and the message key. */
  cellProblem: { at: string; key: string; lines?: readonly string[] } | null
}

export interface LabelRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDraft?: (draft: LabelDraft) => void
  onSave?: () => void
  onDiscard?: () => void
  onAsk?: (ask: PreviewAsk) => void
  onRetryPreview?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onActivate?: () => void
  onRetire?: (reason: string) => void
  onRevise?: () => void
  onTestPrint?: (printerId: string, copies: number) => void
  onRetryJob?: (jobId: string) => void
  onPrintSheet?: () => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  onRetryPrints?: () => void
  // ---- B-W2b-270 ----
  onMarket?: (code: string) => void
  onMarking?: (marking: MarkingDraft) => void
  onRetryChecks?: () => void
  onRetryTextile?: () => void
  onRetryArtwork?: () => void
  onRetryPhrases?: () => void
  /** The approved library words become the label's own care and animal-origin texts (a draft). */
  onFillFromLibrary?: () => void
  /** A proposal for a language (autosaved when the field is left); `draftVersion` replaces the waiting one. */
  onPropose?: (key: string, language: string, text: string, draftVersion?: number) => void
  /** Approves waiting translations one after another (one, or the selected phrases' ones). */
  onApproveTranslations?: (entries: readonly { key: string; draft: { id: string; version: number } }[]) => void
  onSelectPhrases?: (keys: readonly string[]) => void
  onPickProof?: (file: File | null) => void
  onAddProof?: (note: string) => void
  onApproveProof?: (versionId: string, reason: string) => void
  onRetireProof?: (versionId: string, reason: string) => void
  onRemoveProof?: (versionId: string) => void
  /** The proof in a new tab: a version's file, or (null) the label's proof — the approved one, else the sample label PDF. */
  onOpenProof?: (versionId: string | null) => void
  onRetryProof?: () => void
}
