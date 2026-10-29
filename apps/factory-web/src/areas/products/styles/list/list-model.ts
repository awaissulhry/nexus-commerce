import type { BrandRow, ScaleRow, StyleRow } from '../api'
import type { PpeValue, RangeValue } from '../forms'
import type { StyleAbilities, StyleListView } from '../model'

export interface StyleFilters {
  view: StyleListView
  q: string
  /** A product type (JACKET …) or '' for every type. */
  type: string
  /** A PPE category or '' for every one. */
  ppe: string
}

export const NO_FILTERS: StyleFilters = { view: 'open', q: '', type: '', ppe: '' }

/** The filters beyond the saved view (the chips in the toolbar). */
export const extraFilterCount = (filters: StyleFilters): number => (filters.q.trim() ? 1 : 0) + (filters.type ? 1 : 0) + (filters.ppe ? 1 : 0)

export interface NewStyleDraft {
  companyId: string | null
  code: string
  name: string
  productType: StyleRow['productType']
  season: string
  brandPartyId: string | null
  range: RangeValue
  ppe: PpeValue
  mtmAllowed: boolean
}

export interface NewStyleModel {
  draft: NewStyleDraft
  /** The companies the person works in (a choice only when there are several; '' = every company). */
  companies: Array<{ id: string; name: string }>
  scales: ScaleRow[] | null
  brands: BrandRow[] | null
  busy: boolean
  problem: string | null
  /** The fields the API refused (their paths). */
  refused: string[]
}

export interface StylesListViewModel {
  prefix: string
  can: StyleAbilities
  filters: StyleFilters
  rows: { items: StyleRow[] | null; more: boolean; count: number | null; problem: string | null }
  /** The tiles' counts: null while unknown (drawn "—", never 0). */
  tiles: Partial<Record<StyleListView, number | null>>
  asOf: string | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  newStyle: NewStyleModel | null
  busy: boolean
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** Design cases: the rows already selected, the focused row. */
  selected?: string[]
  focusRow?: number
}

export interface StylesListActions {
  onFilters?: (filters: StyleFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onArchiveMany?: (ids: string[], reason: string) => Promise<boolean>
  onNewStyle?: (open: boolean) => void
  onNewDraft?: (draft: NewStyleDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}
