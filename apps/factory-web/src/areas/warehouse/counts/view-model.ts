import type { CountItemKind, CountKind, CountLine, CountReason, CountRecord, CountRow, CountTiles, LineFilter, MaterialChoice } from './api'
import type { CountsCan, ListView, Phrase, RecordTab } from './model'

/**
 * The view models of Warehouse › Counts (SCR-132): what the list, the count record and their dialogs draw. The views take
 * ONE model each and fetch nothing (the containers read and write); the design cases fill them with made-up data.
 */

export type LiveState = 'connecting' | 'live' | 'offline'
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'not_found' } | { status: 'forbidden' } | { status: 'error'; problem: string }
export interface Notice {
  tone: 'success' | 'info' | 'warning' | 'danger'
  words: Phrase
}

export interface SiteChoice {
  id: string
  code: string
  name: string
}
export interface PlaceChoice {
  id: string
  code: string
  name: string
  depth: number
}

// ---- New count (design cn-new) -------------------------------------------------------------------------------------------------

export interface NewCountDraft {
  siteId: string | null
  kind: CountKind
  /** The year-end inventory's year (31 December of it). */
  year: number
  locationId: string | null
  item: MaterialChoice | null
  lotId: string | null
  itemKind: CountItemKind | null
  team: string
  note: string
  /** Start counting at once (the expected quantities frozen in the same step). */
  start: boolean
}

export interface NewCountModel {
  draft: NewCountDraft
  /** The places of the chosen site, in tree order. */
  places: PlaceChoice[] | null
  /** Materials found by the search (null: nothing searched). */
  found: MaterialChoice[] | null
  searching: boolean
  lots: Array<{ id: string; code: string; onHand: string }> | null
  years: number[]
  /** Now, for "starts on 31 Dec or after" (ISO). */
  now: string
  busy: boolean
  problem: Phrase | null
}

export interface NewCountActions {
  onClose?: () => void
  onDraft?: (patch: Partial<NewCountDraft>) => void
  onFind?: (q: string) => void
  onCreate?: () => void
}

// ---- the list ----------------------------------------------------------------------------------------------------------------

export interface CountsListModel {
  prefix: string
  can: CountsCan
  view: ListView
  q: string
  sites: SiteChoice[]
  siteId: string | null
  rows: { items: CountRow[] | null; more: boolean; problem: string | null }
  tiles: CountTiles | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  newCount: NewCountModel | null
  notice?: Notice | null
  /** Design cases: rows ticked, the keys list open. */
  selected?: string[]
  helpOpen?: boolean
}

export interface CountsListActions extends NewCountActions {
  onView?: (view: ListView) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onNew?: () => void
  onExport?: (ids: readonly string[]) => void
  onSheets?: (id: string, expected: boolean) => void
  onDismissNotice?: () => void
}

// ---- the count record ------------------------------------------------------------------------------------------------------------

export interface LinesPart {
  filter: LineFilter
  q: string
  locationId: string | null
  items: CountLine[] | null
  more: boolean
  problem: string | null
}

export interface FoundDraft {
  locationId: string | null
  item: MaterialChoice | null
  colourId: string | null
  lotId: string | null
  hideId: string | null
  counted: string
  reasonCode: string | null
  reasonNote: string
}

export interface FoundModel {
  draft: FoundDraft
  places: PlaceChoice[] | null
  found: MaterialChoice[] | null
  searching: boolean
  colours: Array<{ id: string; code: string; name: string }> | null
  lots: Array<{ id: string; code: string; onHand: string }> | null
  hides: Array<{ id: string; code: string; baseArea: string; state: string }> | null
}

export type RecordDialog =
  | { kind: 'edit'; team: string; note: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'approve'; note: string }
  | { kind: 'sendBack'; reason: string; recount: boolean }
  | { kind: 'apply' }
  | { kind: 'signOff'; phrase: string; language: 'it' | 'en' }
  | { kind: 'reason'; lineIds: string[]; reasonCode: string | null; reasonNote: string }
  | { kind: 'found'; found: FoundModel }

/** A typed cell's save: saving, saved, or refused with its words. */
export type CellSave = { state: 'saving' } | { state: 'saved' } | { state: 'failed'; words: Phrase }

export interface CountRecordModel {
  prefix: string
  can: CountsCan
  tab: RecordTab
  timeZone: string
  record: Loaded<CountRecord>
  lines: LinesPart
  /** The Differences tab (and the Apply dialog): the lines that differ. */
  diffs: { items: CountLine[] | null; more: boolean; problem: string | null }
  reasons: CountReason[] | null
  cells: Readonly<Record<string, CellSave>>
  /** The last typed count ⌘Z takes back (its line's seq). */
  undo: { lineId: string; seq: number } | null
  live: LiveState
  asOf: string | null
  /** Someone else changed the count while it was open. */
  changed: { at: string } | null
  dialog: RecordDialog | null
  busy: boolean
  /** The open dialog's refusal. */
  problem: Phrase | null
  notice: Notice | null
  /** Now (ISO): a year-end inventory starts on its date or after. */
  now: string
  /** Design cases: Differences rows ticked, the keys list open. */
  selected?: string[]
  helpOpen?: boolean
}

export interface CountRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onStart?: () => void
  onSubmit?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onConfirm?: () => void
  onSheets?: (expected: boolean) => void
  onValuedPreview?: (format: 'pdf' | 'xlsx') => void
  onValuedFile?: (fileId: string) => void
  onLines?: (patch: Partial<Pick<LinesPart, 'filter' | 'q' | 'locationId'>>) => void
  onMoreLines?: () => void
  onMoreDiffs?: () => void
  onRetryLines?: () => void
  onRetryDiffs?: () => void
  /** A typed count (or recount) of one line: '' takes a count back. */
  onType?: (line: CountLine, text: string) => void
  onUndo?: () => void
  onReason?: (line: CountLine, code: string | null) => void
  onRecounts?: (lineIds: readonly string[]) => void
  onRemoveLine?: (line: CountLine) => void
  onOpenFound?: () => void
  onFind?: (q: string) => void
  onFound?: (patch: Partial<FoundDraft>) => void
  onDismissNotice?: () => void
}
