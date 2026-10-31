import type { Phrase } from '../../_shared/stock/model'
import type { LiveState } from '../../_shared/buying/hooks'
import type { CreateResult, PickRow, PickSheet, PickTiles, PickView } from './api'
import type { PickingAddress, PickingCan } from './model'

/**
 * The view models of Warehouse › Picking & kits (SCR-237): the page (tiles, the list frame, the band), the pick list dialog
 * (pk-list), Create pick lists (pk-create) and the paper (pk-tab-pdf). Each view takes ONE of these and fetches nothing.
 */

export interface SiteChoice {
  id: string
  code: string
  name: string
}

export interface Notice {
  tone: 'success' | 'danger' | 'warning' | 'info'
  words: Phrase
}

export interface SheetModel {
  /** The work order on show (`?open=`). */
  id: string
  /** The rows as shown now (J / K walk them). */
  ids: readonly string[]
  sheet: PickSheet | null
  /** A key of `stock` (problem.*) when the read failed. */
  problem: string | null
  /**
   * B-W2b-15: the places the kit may be staged at (the work order's site, never a workshop's); null without
   * inventory.locations.view (the place is then shown, not chosen).
   */
  places?: { items: { id: string; code: string; name: string; depth: number }[] | null; problem: string | null } | null
  /** A kit write is on its way. */
  kitBusy?: boolean
  /** The last kit write refused, in our words. */
  kitProblem?: Phrase | null
  /** "Open again": the reason being typed (null: the form is closed). */
  reopen?: { reason: string } | null
}

export interface CreateModel {
  /** The site the choices are read for; null: every site (Create then sends one call per site). */
  siteId: string | null
  sites: readonly SiteChoice[]
  /** Released work orders without a pick list, by cut date (null while read). */
  choices: { items: PickRow[] | null; problem: string | null }
  picked: readonly string[]
  busy: boolean
  /** The outcomes of the last Create, one per work order. */
  results: CreateResult[] | null
  problem: Phrase | null
}

export interface PickingListModel {
  prefix: string
  can: PickingCan
  address: PickingAddress
  sites: readonly SiteChoice[]
  rows: { items: PickRow[] | null; more: boolean; total: number | null; problem: string | null }
  tiles: PickTiles | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  sheet: SheetModel | null
  create: CreateModel | null
  notice: Notice | null
  /** Design cases: rows ticked, the keys panel open, one readiness popover open. */
  selected?: readonly string[]
  helpOpen?: boolean
  readinessOpen?: string | null
}

export interface PickingListActions {
  onView?: (view: PickView) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  /** The pick list dialog of a row (null closes it). */
  onOpen?: (id: string | null) => void
  onRetrySheet?: () => void
  /** B-W2b-15: the kit staged at a place (null: taken off it), checked complete, opened again with the reason. */
  onStageKit?: (locationId: string | null) => void
  onCompleteKit?: () => void
  onReopenKit?: (reason: string | null) => void
  onReopenReason?: (reason: string) => void
  onConfirmReopen?: () => void
  /** The paper of these work orders, in a new tab. */
  onPrint?: (ids: readonly string[]) => void
  onCreate?: () => void
  onCloseCreate?: () => void
  onCreateSite?: (siteId: string | null) => void
  onPick?: (ids: string[]) => void
  onConfirmCreate?: () => void
  onDismissNotice?: () => void
}

export interface PrintModel {
  company: string
  /** The work orders asked (`?ids=`). */
  ids: readonly string[]
  sheets: { value: PickSheet[] | null; problem: string | null }
  readAt: string | null
  timeZone: string
  /** The person may see the page at all. */
  allowed: boolean
}
