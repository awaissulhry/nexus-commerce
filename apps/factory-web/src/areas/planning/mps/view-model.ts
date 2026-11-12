import type { ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { StrategyBulk, StrategyItem } from './api'
import type { CellMark, MpsCan, MpsControls } from './model'

/**
 * The ONE view model of Planning › Long range › Master schedule & S&OP (SCR-202; its W2b part, the production strategy per
 * item) and what it may ask for. The view fetches nothing: the page container (MpsPage.tsx) reads the API and fills this; the
 * design cases fill it with made-up data.
 */

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export interface StrategyPage {
  readonly items: readonly StrategyItem[]
  readonly nextCursor: string | null
  readonly more: 'idle' | 'loading' | 'failed'
  readonly asOf: string
}

/** The bulk change (ReviewChangesModal): the items re-read, the strategy and reason chosen, the save and its answer. */
export interface BulkState {
  readonly ids: readonly string[]
  readonly next: ProductionStrategy
  readonly reason: string
  readonly phase: 'reading' | 'ready' | 'saving' | 'done' | 'failed'
  /** The items as just read again (the review's "now"). */
  readonly items: readonly StrategyItem[]
  readonly answer: StrategyBulk | null
  /** A failed read or save in our words (a key). */
  readonly problem: string | null
  readonly undoing: boolean
  readonly undone: boolean
}

export interface MpsNotice {
  readonly tone: 'success' | 'danger' | 'info'
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface MpsModel {
  readonly prefix: string
  readonly can: MpsCan
  readonly sites: Loaded<PlanningSite[]>
  readonly siteId: string | null
  readonly controls: MpsControls
  readonly list: Loaded<StrategyPage>
  /** A cell's mark by item id (saving, saved, refused with its words). */
  readonly marks: Readonly<Record<string, CellMark>>
  readonly bulk: BulkState | null
  readonly notice: MpsNotice | null
  readonly live: LiveState
  /** Another person's change waits behind "N updates · Show". */
  readonly updates: number
  readonly dialog: { readonly kind: 'keys' } | null
  readonly timeZone: string
  /** Design cases only. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface MpsActions {
  onSite?: (siteId: string) => void
  onFilter?: (next: Partial<Omit<MpsControls, 'site'>>) => void
  onClearFilters?: () => void
  /** A cell's Listbox: the item's every-colour strategy, saved by itself. */
  onCell?: (itemId: string, strategy: ProductionStrategy) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  /** Change strategy for N: the review opens and reads the items again. */
  onBulk?: (itemIds: readonly string[]) => void
  onBulkNext?: (strategy: ProductionStrategy) => void
  onBulkReason?: (reason: string) => void
  onBulkSave?: () => void
  onBulkRetry?: () => void
  onBulkUndo?: () => void
  onBulkClose?: () => void
  onKeys?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
