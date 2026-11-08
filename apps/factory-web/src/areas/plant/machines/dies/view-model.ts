import type { PlantSite, SupplierChoice } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import type { Die, DieChoices, DieSettableCondition, StyleChoice } from './api'
import type { DieCan, DieDraft, DiesAddress, DieWords } from './model'

/**
 * The ONE view model of the clicking-die register (B-W2b-136; design plant.machines "Clicking dies") and the actions it
 * reports. The container (DiesSection.tsx) loads and maps; the view fetches nothing.
 */

export interface DieRowsState {
  items: Die[] | null
  more: boolean
  /** A message key of `plant-dies` when the read failed. */
  problem: string | null
}

/** A cell saved inline (rack location, condition). */
export interface DieCellState {
  state: 'saving' | 'saved' | 'failed'
  words?: DieWords | null
}

export interface DieNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: DieWords
  readonly detail?: DieWords | null
}

export type DiesDialog =
  | {
      kind: 'new'
      draft: DieDraft
      /** The styles found for what was typed; null: nothing asked yet. */
      styles: StyleChoice[] | null
      /** The picked style's sizes and pattern pieces; null: still reading or no style. */
      choices: DieChoices | null
      suppliers: SupplierChoice[] | null
      busy: boolean
      problem: DieWords | null
      field: string | null
    }
  | { kind: 'retire'; dies: Die[]; reason: string; busy: boolean; problem: DieWords | null; refused: { code: string; words: DieWords }[] }

export interface DiesModel {
  prefix: string
  can: DieCan
  address: DiesAddress
  sites: PlantSite[]
  /** The page's site (null: every site the person reaches). */
  siteId: string | null
  rows: DieRowsState
  /** Still reading after about a second: the note says so. */
  slow?: boolean
  asOf: string | null
  live: LiveState
  updates: number
  cells: Readonly<Record<string, DieCellState>>
  dialog: DiesDialog | null
  notice: DieNotice | null
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface DiesActions {
  onSearch?: (q: string) => void
  onRows?: (rows: DiesAddress['rows']) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onRack?: (die: Die, typed: string) => void
  onCondition?: (die: Die, condition: DieSettableCondition) => void
  onNew?: () => void
  onRetire?: (dies: Die[]) => void
  onDialogClose?: () => void
  onDraft?: (patch: Partial<DieDraft>) => void
  onFindStyle?: (text: string) => void
  onPickStyle?: (style: StyleChoice | null) => void
  onFindSupplier?: (text: string) => void
  onRetireReason?: (reason: string) => void
  onSubmitDialog?: () => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
}
