import type { PriceListKind, PriceListRow } from '../api'
import type { ListFilters, NewListDraft, Phrase, PriceListAbilities, Tone } from '../model'

/** The New price list dialog (design pop:pricelists.new). */
export interface NewListModel {
  draft: NewListDraft
  /** The companies the person works in (the choice shows only when there are several, with "Every company"). */
  companies: ReadonlyArray<{ id: string; name: string }>
  /** The lists it may fall back to (active ones the person can read). */
  lists: readonly PriceListRow[]
  busy: boolean
  /** A refusal of the API in words (a code in use, a second base list…). */
  problem: Phrase | null
}

export interface PriceListsViewModel {
  /** `/w/<company>` */
  prefix: string
  can: PriceListAbilities
  filters: ListFilters
  rows: { items: PriceListRow[] | null; problem: string | null }
  tiles: { inForce: number; startingIn30Days: number; endingIn30Days: number } | null
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  updates: number
  notice: { tone: Tone; words: Phrase } | null
  selected: readonly string[]
  newList: NewListModel | null
  dialog: 'archive' | 'help' | null
  busy: boolean
  /** Design cases: the row that has the focus. */
  focusRow?: number
}

export interface PriceListsActions {
  onFilters?: (filters: ListFilters) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (id: string) => void
  onDialog?: (dialog: PriceListsViewModel['dialog']) => void
  onExport?: (ids: readonly string[]) => void
  onArchive?: (ids: readonly string[]) => void
  onNew?: (open: boolean) => void
  onNewDraft?: (draft: NewListDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

export type { PriceListKind }
