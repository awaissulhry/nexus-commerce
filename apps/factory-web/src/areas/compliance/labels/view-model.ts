import type { LiveState, Notice, Read } from '../../quality/_shared/model'
import type { LabelDetail, LabelTemplate, Preview, PreviewAsk, PrintJob, Printer, Rendered, StyleRow } from './api'
import type { LabelDraft, LabelsCan, LabelView, NewLabelDraft } from './model'

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

export type RecordTab = 'content' | 'versions' | 'prints'

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
}
