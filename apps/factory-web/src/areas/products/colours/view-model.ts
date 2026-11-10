import type { Notice } from '../library/model'
import type { BrandChoice, BrandingSetRow, BrandingSetView, ColourCountsView, ColourDraft, ColourFilters, ColourLibraryRow, ColoursCan, NewSetDraft, SetDraft } from './model'

/**
 * The view model of Products › Colours & artwork (SCR-118): everything the view draws, as plain data. The container
 * (ColoursPage) reads and writes; the view fetches nothing. Design cases build these with made-up data (fixtures.ts).
 */

export interface ColourFormModel {
  mode: 'new' | 'edit'
  /** The colour being changed (edit). */
  row: ColourLibraryRow | null
  draft: ColourDraft
  /** The companies a new colour may belong to (and "every company" when `everyCompany`). */
  companies: Array<{ id: string; name: string }>
  everyCompany: boolean
  busy: boolean
  /** A refused write: a `library` problem key, the refused fields (`code`, `names/en`), the API's sentences as data. */
  problem: string | null
  refused: string[]
  messages: string[]
  /** The photo being sent (edit), or what refused it. */
  photo: { busy: boolean; problem: string | null }
}

export interface SetModalModel {
  id: string
  set: BrandingSetView | null
  /** A failed read (a `library` problem key). */
  problem: string | null
  draft: SetDraft | null
  /** The pickers' choices (null while read; the materials only with product.materials.view). */
  colours: ColourLibraryRow[] | null
  materials: Array<{ id: string; code: string; name: string; kind: string }> | null
  busy: boolean
  saveProblem: string | null
  refused: string[]
  messages: string[]
  /** A file being sent (its name), or what refused it. */
  uploading: string | null
  uploadProblem: string | null
  /** Archive… / Restore… asked. */
  confirm: 'archive' | 'restore' | null
}

export interface NewSetModel {
  draft: NewSetDraft
  /** The brand search: what was typed, what came back (null while it runs). */
  search: { q: string; results: BrandChoice[] | null }
  busy: boolean
  problem: string | null
  refused: string[]
  messages: string[]
}

export interface ColoursViewModel {
  prefix: string
  /** The company of the address (a new set is for it). */
  companyId: string | null
  can: ColoursCan
  filters: ColourFilters
  rows: { items: ColourLibraryRow[] | null; more: boolean; count: number | null; problem: string | null; ignored: string[]; families: string[] }
  /** The tiles and the facts (null while unknown: a tile says "—", never 0); `countsFailed` when the read failed. */
  counts: ColourCountsView | null
  countsFailed: boolean
  sets: { items: BrandingSetRow[] | null; problem: string | null }
  asOf: string | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  /** The notices dismissed on this device (by kind and value). */
  dismissed: string[]
  /** What the last action did (one Banner, dismissable). */
  notice: Notice | null
  busy: boolean
  colourForm: ColourFormModel | null
  setModal: SetModalModel | null
  newSet: NewSetModel | null
  /** Design cases: rows selected, a dialog open, the notices listed, the focused row. */
  selected?: string[]
  selectedSets?: string[]
  dialog?: 'archive' | 'restore' | 'archiveSets' | 'help' | null
  noticesOpen?: boolean
  focusRow?: number
}

export interface ColoursActions {
  onFilters?: (filters: ColourFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpenColour?: (row: ColourLibraryRow) => void
  onSaved?: (rowId: string, after: Readonly<Record<string, string | number | null>>, version: number) => void
  onDismissNotice?: () => void
  onDismiss?: (key: string) => void
  onArchiveColours?: (ids: string[], to: 'archive' | 'restore', reason: string) => Promise<boolean>
  // the colour form
  onColourForm?: (mode: 'new' | 'edit' | null, row?: ColourLibraryRow) => void
  onColourDraft?: (draft: ColourDraft) => void
  onSaveColour?: () => void
  onPhoto?: (file: File) => void
  // branding sets
  onOpenSet?: (id: string | null) => void
  onSetDraft?: (draft: SetDraft) => void
  onSaveSet?: () => void
  onDiscardSet?: () => void
  onSetFile?: (file: File, role: 'LOGO' | 'ARTWORK') => void
  onOpenDocument?: (fileId: string) => void
  onSetConfirm?: (confirm: 'archive' | 'restore' | null) => void
  onSetStatus?: (to: 'archive' | 'restore', reason: string) => void
  onArchiveSets?: (ids: string[], reason: string) => Promise<boolean>
  onRetrySets?: () => void
  onNewSet?: (open: boolean) => void
  onNewSetDraft?: (draft: NewSetDraft) => void
  onBrandSearch?: (q: string) => void
  onCreateSet?: () => void
}
