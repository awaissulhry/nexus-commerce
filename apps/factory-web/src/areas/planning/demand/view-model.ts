import type { DemandLayer } from '@nexus/factory-domain/planning/demand/rules'
import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { Demand, SourceRow, SourceRows } from './api'
import type { Bucket, CellRef, DemandCan, DemandControls } from './model'

/**
 * The ONE view model of Planning › Demand & forecast (SCR-374) and what it may ask for. The view fetches nothing: the page
 * container (DemandPage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

/** One read's state: a failed read is never drawn as empty. */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** The list's rows so far (pages of 100 with the API's cursor) and the read of the next page. */
export interface ListRows {
  readonly rows: readonly SourceRow[]
  readonly pieces: number
  readonly sources: number
  readonly nextCursor: string | null
  readonly more: 'idle' | 'loading' | 'failed'
}

/** The open popover: its cell and the sources that make its number. */
export interface DemandPopover {
  readonly ref: CellRef
  readonly rows: Loaded<SourceRows>
}

export interface DemandModel {
  readonly prefix: string
  readonly can: DemandCan
  readonly sites: Loaded<PlanningSite[]>
  readonly siteId: string | null
  readonly controls: DemandControls
  /** GET /planning/demand: the tiles and the grid. */
  readonly demand: Loaded<Demand>
  /** GET /planning/demand/rows: the list. */
  readonly list: Loaded<ListRows>
  /** The style-colour lines opened to their sizes. */
  readonly open: readonly string[]
  readonly popover: DemandPopover | null
  readonly live: LiveState
  /** Live changes of the demand's sources wait behind "N updates · Show" (rows never move under the cursor). */
  readonly updates: number
  readonly dialog: { readonly kind: 'keys' } | null
  /** The office pages that are built (record-links: a source opens its own page once built). */
  readonly built: ReadonlySet<string>
  /** Design cases only: a preset selection, a focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly selectedRows?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface DemandActions {
  onSite?: (siteId: string) => void
  onBucket?: (bucket: Bucket) => void
  onWeeks?: (weeks: number | null) => void
  onLayers?: (layers: readonly DemandLayer[]) => void
  onSearch?: (q: string) => void
  /** A tile pressed: the list shows that layer (null: every layer). */
  onTile?: (layer: DemandLayer | null) => void
  onToggleOpen?: (lineIds: readonly string[], open: boolean) => void
  /** Open (or close: null) the popover of a cell. */
  onCell?: (ref: CellRef | null) => void
  onRetryCell?: () => void
  /** The list's own filters (its layer, its search, one cell of the grid). */
  onList?: (next: Partial<Pick<DemandControls, 'layer' | 'rq' | 'style' | 'colour' | 'size' | 'mtm' | 'cell'>>) => void
  onClearList?: () => void
  onMore?: () => void
  /** Enter on a list row: its source document (the address record-links gives). */
  onOpenSource?: (href: string) => void
  onRetry?: (section: 'demand' | 'list') => void
  onShowUpdates?: () => void
  /** The grid as a file (the lines asked for; none: every line shown). */
  onExportGrid?: (lineIds: readonly string[]) => void
  onKeys?: () => void
  onCloseDialog?: () => void
}
