import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { ExceptionList, PlanningException } from './api'
import type { ExceptionKind } from './api'
import type { ExceptionsCan, ExceptionsControls, ExceptionsView } from './model'

/**
 * The ONE view model of Planning › Exceptions (SCR-125) and what it may ask for. The view fetches nothing: the page
 * container (ExceptionsPage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** A notice after a write (a key of the catalogue and its values). */
export interface ExceptionsNotice {
  tone: 'success' | 'danger' | 'info'
  key: string
  params?: Record<string, string | number>
}

export type ExceptionsDialog =
  | { kind: 'snooze'; id: string }
  | { kind: 'resolve'; id: string; note: string; busy: boolean; problem: string | null }
  | { kind: 'keys' }

export interface ExceptionsModel {
  prefix: string
  can: ExceptionsCan
  sites: Loaded<PlanningSite[]>
  siteId: string | null
  controls: ExceptionsControls
  /** The first page with the tiles and the latest run. */
  list: Loaded<ExceptionList>
  /** Every row read so far (the first page and each "Show more"). */
  rows: PlanningException[]
  more: boolean
  loadingMore: boolean
  /** The end of the site's day (ISO): "Snoozed until today" keeps the snoozes that end by then. */
  endOfToday: string
  live: LiveState
  /** A newer run finished: "1 update · Show" (rows never move under the cursor). */
  updates: number
  running: boolean
  /** Exceptions a write is on its way for. */
  busy: readonly string[]
  notice: ExceptionsNotice | null
  /** The DetailModal (`?open=`): the row read fresh. */
  detail: { id: string; loaded: Loaded<PlanningException> } | null
  dialog: ExceptionsDialog | null
  /** The page's clock (the snooze choices are worked out from it). */
  now: number
  timeZone?: string
  /** Design cases: preset selection, focused row, keys panel. */
  selected?: readonly string[]
  focusRow?: number
  keysOpen?: boolean
}

export interface ExceptionsActions {
  onSite?: (siteId: string) => void
  onView?: (view: ExceptionsView) => void
  onKind?: (kind: ExceptionKind | null) => void
  onSearch?: (q: string) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onRun?: () => void
  /** Open a row's detail (null: close it). */
  onOpen?: (id: string | null) => void
  onAcknowledge?: (ids: string[]) => void
  onSnooze?: (id: string) => void
  /** `until` null: until the next run. Resolves true when it was snoozed. */
  onSnoozeConfirm?: (until: string | null) => Promise<boolean>
  onResolve?: (id: string) => void
  onResolveNote?: (note: string) => void
  onResolveConfirm?: () => void
  onExport?: (ids: string[]) => void
  onKeys?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
