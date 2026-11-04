import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { LeatherNeed, LeatherProtectors, LeatherYield } from './api'
import type { FeasibilityFilter, LeatherCan, LeatherControls, ShadeOption, Tile } from './model'

/** One read's state: a failed read is never drawn as empty. */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export interface LeatherNotice {
  readonly tone: 'success' | 'danger' | 'info'
  readonly key: string
  readonly params?: Record<string, string | number>
}

export type LeatherDialog =
  | { readonly kind: 'accept'; readonly styleId: string; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'dismiss'; readonly styleId: string; readonly reason: string; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'keys' }

/** SCR-252's one view model: the container fills it, the view only reads it. */
export interface LeatherModel {
  readonly prefix: string
  readonly can: LeatherCan
  /** The person holds the cost grain (the value columns are drawn only then). */
  readonly seesCost: boolean
  readonly sites: Loaded<PlanningSite[]>
  readonly siteId: string | null
  readonly controls: LeatherControls
  readonly need: Loaded<LeatherNeed>
  readonly protectors: Loaded<LeatherProtectors>
  readonly yields: Loaded<LeatherYield>
  readonly live: LiveState
  readonly updates: number
  readonly running: boolean
  /** A drawer action under way (its option), or null. */
  readonly acting: ShadeOption | null
  readonly notice: LeatherNotice | null
  readonly dialog: LeatherDialog | null
  readonly timeZone: string
  /** Design cases only. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  /** The drawer's action answer (a refusal in words, or done). */
  readonly drawerNotice?: LeatherNotice | null
}

export interface LeatherActions {
  onSite?: (siteId: string) => void
  onTile?: (tile: Tile | null) => void
  onFeasibility?: (feas: FeasibilityFilter) => void
  onSearch?: (q: string) => void
  onRetry?: (section: 'need' | 'protectors' | 'yield') => void
  onShowUpdates?: () => void
  onRun?: () => void
  onOpen?: (rowId: string | null) => void
  onChoose?: (rowId: string, option: ShadeOption) => void
  onDraftPo?: (rowId: string) => void
  onAccept?: (styleId: string) => void
  onAcceptConfirm?: () => void
  onDismiss?: (styleId: string) => void
  onDismissReason?: (reason: string) => void
  onDismissConfirm?: () => void
  onPrint?: () => void
  onExport?: (rowIds: readonly string[]) => void
  onKeys?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
