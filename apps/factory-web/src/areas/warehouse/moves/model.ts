import type { LiveState } from '../../_shared/buying/hooks'
import { MOVE_REASONS, type Explain, type LedgerCounts, type LedgerQuery, type LedgerRow, type MoveDetail, type MoveReason } from '../../_shared/stock/api'
import { decimalValue, type Phrase, type StockCan } from '../../_shared/stock/model'
import type { AdjustDialogModel } from '../stock/adjust/model'
import type { SiteChoice } from '../stock/model'

/**
 * Warehouse › Movements (SCR-064; design warehouse.moves, Owner answer W2 B: one long fast grid), pure: the filters in
 * the address (a stock key — site, material, colour, lot, hide, place —, reasons, the period, has a note, reversed, the
 * move open in its detail), the API's query, the tiles as saved filters, the running balance (the balance now less the
 * deltas of the newer rows above), and what a reversal shows before it is posted (the mirror move).
 */

export const PERIODS = ['7d', '30d', '90d', '365d', 'all'] as const
export type Period = (typeof PERIODS)[number]
const DAYS: Readonly<Record<Exclude<Period, 'all'>, number>> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }
export const MOVE_TILES = ['adjustments', 'scraps', 'counts', 'reversals', 'unvalued'] as const
export type MoveTile = (typeof MOVE_TILES)[number]

export interface MovesAddress {
  site: string | null
  item: string | null
  colour: string | null
  lot: string | null
  hide: string | null
  location: string | null
  reasons: MoveReason[]
  period: Period
  note: 'with' | 'without' | null
  reversed: 'yes' | 'no' | null
  /** The move open in its detail (`?open=`). */
  open: string | null
}

/** A stock key is named (material, lot, hide or place): the ledger of that stock, whole by default. */
export const hasKey = (address: Pick<MovesAddress, 'item' | 'lot' | 'hide' | 'location'>) => !!(address.item || address.lot || address.hide || address.location)
/** The key is one figure "why is it this number" explains: the site and the material at least. */
export const explainsFigure = (address: Pick<MovesAddress, 'site' | 'item'>) => !!(address.site && address.item)

export function movesAddressOf(params: { get(name: string): string | null } | null): MovesAddress {
  const get = (name: string) => params?.get(name) || null
  const reasons = (get('reasons') ?? '').split(',').filter((reason): reason is MoveReason => (MOVE_REASONS as readonly string[]).includes(reason))
  const key = { item: get('item'), lot: get('lot'), hide: get('hide'), location: get('location') }
  const period = get('period')
  return {
    site: get('site'),
    ...key,
    colour: get('colour'),
    reasons,
    period: period && (PERIODS as readonly string[]).includes(period) ? (period as Period) : hasKey(key) ? 'all' : '30d',
    note: get('note') === 'with' ? 'with' : get('note') === 'without' ? 'without' : null,
    reversed: get('reversed') === 'yes' ? 'yes' : get('reversed') === 'no' ? 'no' : null,
    open: get('open'),
  }
}

export function movesQueryString(address: MovesAddress): string {
  const query = new URLSearchParams()
  for (const name of ['site', 'item', 'colour', 'lot', 'hide', 'location'] as const) if (address[name]) query.set(name, address[name]!)
  if (address.reasons.length > 0) query.set('reasons', address.reasons.join(','))
  if (address.period !== (hasKey(address) ? 'all' : '30d')) query.set('period', address.period)
  if (address.note) query.set('note', address.note)
  if (address.reversed) query.set('reversed', address.reversed)
  if (address.open) query.set('open', address.open)
  return query.toString()
}

/** The API's query for the address (`from` = the period's start; no `to`, so the running balance holds). */
export function ledgerQueryOf(address: MovesAddress, now: Date, cursor: string | null, limit = 500): LedgerQuery {
  return {
    siteId: address.site ?? undefined,
    itemId: address.item ?? undefined,
    itemColourId: address.colour,
    lotId: address.lot,
    hideId: address.hide,
    locationId: address.location,
    reasons: address.reasons,
    hasNote: address.note === 'with' ? true : address.note === 'without' ? false : null,
    reversed: address.reversed === 'yes' ? true : address.reversed === 'no' ? false : null,
    from: address.period === 'all' ? null : new Date(now.getTime() - DAYS[address.period] * 86_400_000).toISOString(),
    cursor,
    limit,
  }
}

/** A tile's saved filter, and whether the address is on it. */
export function tileFilter(tile: MoveTile): Partial<MovesAddress> | null {
  switch (tile) {
    case 'adjustments':
      return { reasons: ['ADJUSTMENT'], period: '7d', reversed: null, note: null }
    case 'scraps':
      return { reasons: ['SCRAP'], period: '30d', reversed: null, note: null }
    case 'counts':
      return { reasons: ['COUNT'], period: '30d', reversed: null, note: null }
    case 'reversals':
      return { reasons: [], period: '30d', reversed: 'yes', note: null }
    default:
      return null
  }
}

export function tileActive(tile: MoveTile, address: MovesAddress): boolean {
  const filter = tileFilter(tile)
  if (!filter) return false
  return filter.period === address.period && (filter.reasons ?? []).join(',') === address.reasons.join(',') && (filter.reversed ?? null) === address.reversed
}

export function tileCount(tile: MoveTile, counts: LedgerCounts | null): number | null {
  if (!counts) return null
  switch (tile) {
    case 'adjustments':
      return counts.adjustments7d
    case 'scraps':
      return counts.scraps30d
    case 'counts':
      return counts.counts30d
    case 'reversals':
      return counts.reversals30d
    default:
      return counts.unvalued ?? null
  }
}

/** The balance after each row (newest first): the balance now, less the deltas of the rows above it. */
export function runningBalances(rows: readonly LedgerRow[], closing: string | null): Map<string, number> | null {
  if (closing === null) return null
  const balances = new Map<string, number>()
  let balance = decimalValue(closing) ?? 0
  for (const row of rows) {
    balances.set(row.id, Math.round(balance * 10_000) / 10_000)
    balance -= decimalValue(row.delta) ?? 0
  }
  return balances
}

/** The mirror a reversal posts: the same quantity with its places swapped (shown before posting). */
export function mirrorOf(move: Pick<LedgerRow, 'from' | 'to' | 'quantity' | 'uom' | 'baseQuantity' | 'reason'>) {
  return { from: move.to, to: move.from, quantity: move.quantity, uom: move.uom, baseQuantity: move.baseQuantity, reason: move.reason }
}

/** The words of a side that is not a place of the site ("Supplier", "Work order"). */
export const sideKey = (side: LedgerRow['from']) => (side.kind === 'LOCATION' ? null : `side.${side.kind}`)

/** A refused reversal in our words: the stock is gone (used by later moves), refused in its state, or another answer. */
export function reverseProblemKey(kind: string, code: string, hasIssues: boolean): string {
  if (kind === 'conflict' && code === 'invalid_state') return 'rev.problem.notNow'
  if (kind === 'conflict' && hasIssues) return 'rev.problem.used'
  if (kind === 'conflict') return 'rev.problem.changed'
  if (kind === 'forbidden' || kind === 'step_up') return 'rev.problem.forbidden'
  if (kind === 'unavailable') return 'rev.problem.offline'
  if (kind === 'not_found') return 'rev.problem.gone'
  if (kind === 'invalid') return 'rev.problem.invalid'
  return 'rev.problem.write'
}

// ---- the page model ---------------------------------------------------------------------------------------------------------

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface ReverseModel {
  move: LedgerRow
  note: string
  posting: boolean
  problem: Phrase | null
}

export interface MovesPageModel {
  prefix: string
  can: StockCan
  address: MovesAddress
  sites: SiteChoice[]
  /** Loaded so far, newest first (null while the first page is read). */
  rows: LedgerRow[] | null
  problem: string | null
  loadingMore: boolean
  /** Every row of the filter is loaded. */
  done: boolean
  /** The balance now of the one stock key filtered (the running balance), else null. */
  closing: string | null
  counts: LedgerCounts | null
  explain: Loaded<Explain> | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  notice?: { tone: 'success' | 'danger'; key: string; params?: Record<string, string | number> } | null
  detail: Loaded<MoveDetail> | null
  reverse: ReverseModel | null
  adjust?: AdjustDialogModel | null
  /** Design cases. */
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
  /** "Now" for the period words (the design cases fix it). */
  now?: string
}

export interface MovesPageActions {
  onAddress?: (next: Partial<MovesAddress>) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string | null) => void
  onRetryDetail?: () => void
  onReverse?: (move: LedgerRow | null) => void
  onReverseNote?: (note: string) => void
  onPostReverse?: () => void
  onAdjust?: () => void
  onExport?: (rows: LedgerRow[]) => void
  onNotice?: () => void
}

/** The stock key an Adjust starts from: the key in the address (site and material), else the row's. */
export function adjustKeyOf(address: MovesAddress, row: LedgerRow | null): { siteId: string; itemId: string; colourId: string | null; lotId: string | null; hideId: string | null; locationId: string | null } | null {
  if (address.site && address.item) return { siteId: address.site, itemId: address.item, colourId: address.colour, lotId: address.lot, hideId: address.hide, locationId: address.location }
  if (!row) return null
  const place = row.to.location ?? row.from.location
  return { siteId: row.siteId, itemId: row.item.id, colourId: row.colour?.id ?? null, lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null, locationId: place?.id ?? null }
}
