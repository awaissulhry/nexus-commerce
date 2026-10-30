import type { LibraryCan, Notice } from '../library/model'
import type { MaterialRow, SupplierRow } from './api'
import type { MaterialFilters, MaterialTile, NewMaterialDraft } from './model'

export interface NewMaterialModel {
  draft: NewMaterialDraft
  /** The companies the person works in (a choice only when there are several; null = every company). */
  companies: Array<{ id: string; name: string }>
  /** The supplier search: what was typed and what came back (null while it runs). */
  suppliers: { q: string; results: SupplierRow[] | null } | null
  busy: boolean
  problem: string | null
  /** The fields the API refused and its sentences (kept as data). */
  refused: string[]
  messages: string[]
}

export interface MaterialsListViewModel {
  prefix: string
  can: LibraryCan
  filters: MaterialFilters
  rows: { items: MaterialRow[] | null; more: boolean; count: number | null; problem: string | null }
  /** The tiles' counts: null while unknown (drawn "—", never 0). */
  tiles: Partial<Record<MaterialTile, number | null>>
  asOf: string | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  newMaterial: NewMaterialModel | null
  busy: boolean
  notice: Notice | null
  /** Design cases: rows already selected, the focused row, a dialog open. */
  selected?: string[]
  focusRow?: number
  dialog?: 'archive' | 'cost' | 'help' | null
}

export interface MaterialsListActions {
  onFilters?: (filters: MaterialFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onArchiveMany?: (ids: string[], reason: string) => Promise<boolean>
  /** Each change: the material and its new standard cost (null removes it). */
  onSetCosts?: (changes: Array<{ id: string; cost: string | null }>, reason: string) => Promise<boolean>
  onNew?: (open: boolean) => void
  onDraft?: (draft: NewMaterialDraft) => void
  onSupplierSearch?: (q: string) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}
