import type { LiveState } from '../../_shared/buying/hooks'
import type { PickerReason } from '../../_shared/reasons/api'
import { MOVE_REASONS, type LedgerCounts, type LedgerRow, type MoveDetail, type MoveReason } from '../../_shared/stock/api'
import { decimalValue, type Phrase, type StockCan } from '../../_shared/stock/model'
import type { AdjustDialogModel } from '../stock/adjust/model'
import type { WriteOffDialogModel } from '../stock/daily/dialog-model'
import type { DailyCan, SiteChoice } from '../stock/model'
// B-W2b-327: the balance bridge (GET /inventory/why), posting days against entry days, adjustments waiting for a yes.
import type { PostedLedgerQuery, PostedLedgerRow, WaitingAdjustment, Why } from '../stock/depth/api'
import { periodFromDay } from '../stock/depth/model'

/** A ledger row with its posting day (B-W2b-314's fields; absent in older fixtures). */
export type MoveRow = LedgerRow & Partial<Pick<PostedLedgerRow, 'postingDate' | 'postingDay'>>

/**
 * Warehouse › Movements (SCR-064; design warehouse.moves, Owner answer W2 B: one long fast grid), pure: the filters in
 * the address (a stock key — site, material, colour, lot, hide, place —, reasons, the period, has a note, reversed, the
 * move open in its detail), the API's query, the tiles as saved filters, the running balance (the balance now less the
 * deltas of the newer rows above), and what a reversal shows before it is posted (the mirror move). B-W2a-64: the text
 * search across the ledger (`?q=`), write-offs as their own saved filter (`?writeOffs=yes`, the Write-offs tile), the
 * ledger's whole count, and when Write off… may start (one stock key, inventory.scrap).
 */

export const PERIODS = ['7d', '30d', '90d', '365d', 'all'] as const
export type Period = (typeof PERIODS)[number]
const DAYS: Readonly<Record<Exclude<Period, 'all'>, number>> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }
export const MOVE_TILES = ['adjustments', 'writeOffs', 'counts', 'reversals', 'unvalued'] as const
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
  /** B-W2a-64: text across the ledger (material, lot, hide, places, receipt, work order, reference, note). */
  q: string
  /** B-W2a-64: only write-offs (the Write-offs tile). */
  writeOffs: 'yes' | null
  /** The move open in its detail (`?open=`). */
  open: string | null
  /** B-W2b-327 (SCM-196): the period counts the days the moves happened (entry) or the days they count on in the books (posting). */
  by: 'entry' | 'posting'
  /** B-W2b-327: only moves dated apart from the day they happened (back), or none of them (same). */
  dated: 'back' | 'same' | null
  /** B-W2b-327 (design mv-approval): the adjustments waiting for a yes open (`?waiting=all`, or one request's id). */
  waiting: string | null
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
    q: (get('q') ?? '').trim().slice(0, 80),
    writeOffs: get('writeOffs') === 'yes' ? 'yes' : null,
    open: get('open'),
    by: get('by') === 'posting' ? 'posting' : 'entry',
    dated: get('dated') === 'back' ? 'back' : get('dated') === 'same' ? 'same' : null,
    waiting: get('waiting'),
  }
}

export function movesQueryString(address: MovesAddress): string {
  const query = new URLSearchParams()
  for (const name of ['site', 'item', 'colour', 'lot', 'hide', 'location'] as const) if (address[name]) query.set(name, address[name]!)
  if (address.reasons.length > 0) query.set('reasons', address.reasons.join(','))
  if (address.period !== (hasKey(address) ? 'all' : '30d')) query.set('period', address.period)
  if (address.note) query.set('note', address.note)
  if (address.reversed) query.set('reversed', address.reversed)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.writeOffs) query.set('writeOffs', address.writeOffs)
  if (address.open) query.set('open', address.open)
  if (address.by === 'posting') query.set('by', 'posting')
  if (address.dated) query.set('dated', address.dated)
  if (address.waiting) query.set('waiting', address.waiting)
  return query.toString()
}

/**
 * The API's query for the address (`from` = the period's start; no `to`, so the running balance holds). B-W2b-327: by
 * posting day the period is `postedFrom` (Rome) instead, and `dated` asks only moves dated apart (or none of them); the
 * ledger then answers no running balance.
 */
export function ledgerQueryOf(address: MovesAddress, now: Date, cursor: string | null, limit = 500, timeZone = 'Europe/Rome'): PostedLedgerQuery {
  const days = address.period === 'all' ? null : DAYS[address.period]
  const byPosting = address.by === 'posting'
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
    from: byPosting || days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString(),
    postedFrom: byPosting ? periodFromDay(days, now, timeZone) : null,
    backDated: address.dated === 'back' ? true : address.dated === 'same' ? false : null,
    cursor,
    limit,
    q: address.q.trim() || null,
    writeOffs: address.writeOffs === 'yes' ? true : null,
  }
}

/** A tile's saved filter, and whether the address is on it. */
export function tileFilter(tile: MoveTile): Partial<MovesAddress> | null {
  switch (tile) {
    case 'adjustments':
      return { reasons: ['ADJUSTMENT'], period: '7d', reversed: null, note: null, writeOffs: null }
    case 'writeOffs':
      return { reasons: [], period: '30d', reversed: null, note: null, writeOffs: 'yes' }
    case 'counts':
      return { reasons: ['COUNT'], period: '30d', reversed: null, note: null, writeOffs: null }
    case 'reversals':
      return { reasons: [], period: '30d', reversed: 'yes', note: null, writeOffs: null }
    default:
      return null
  }
}

export function tileActive(tile: MoveTile, address: MovesAddress): boolean {
  const filter = tileFilter(tile)
  if (!filter) return false
  return filter.period === address.period && (filter.reasons ?? []).join(',') === address.reasons.join(',') && (filter.reversed ?? null) === address.reversed && (filter.writeOffs ?? null) === address.writeOffs
}

export function tileCount(tile: MoveTile, counts: LedgerCounts | null): number | null {
  if (!counts) return null
  switch (tile) {
    case 'adjustments':
      return counts.adjustments7d
    case 'writeOffs':
      return counts.writeOffs30d ?? null
    case 'counts':
      return counts.counts30d
    case 'reversals':
      return counts.reversals30d
    default:
      return counts.unvalued ?? null
  }
}

/** The first day of the address's period (Rome), for the balance bridge; null: the whole ledger. */
export const periodStartOf = (address: Pick<MovesAddress, 'period'>, now: Date, timeZone = 'Europe/Rome'): string | null => periodFromDay(address.period === 'all' ? null : DAYS[address.period], now, timeZone)

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
  rows: MoveRow[] | null
  problem: string | null
  loadingMore: boolean
  /** Every row of the filter is loaded. */
  done: boolean
  /** The balance now of the one stock key filtered (the running balance), else null. */
  closing: string | null
  /** Every move of the filter (the first page's `rowCount`), else null. */
  rowCount?: number | null
  counts: LedgerCounts | null
  /** B-W2b-327: why is it this number — the balance bridge of the stock key (GET /inventory/why, the address's period). */
  explain: Loaded<Why> | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  notice?: { tone: 'success' | 'danger'; key: string; params?: Record<string, string | number> } | null
  detail: Loaded<MoveDetail> | null
  reverse: ReverseModel | null
  adjust?: AdjustDialogModel | null
  /** B-W2a-64: Write off (the shared dialog), the WRITE_OFF reasons' words for the rows, the every-day abilities. */
  writeOff?: WriteOffDialogModel | null
  writeOffReasons?: readonly PickerReason[]
  daily?: DailyCan
  /** Design cases. */
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
  /** "Now" for the period words (the design cases fix it). */
  now?: string
  /** B-W2b-327 (design mv-approval, page.conn Approvals): the adjustments waiting for a yes at the sites shown. */
  waiting?: Loaded<{ rows: WaitingAdjustment[]; count: number }> | null
  /** B-W2b-327: an adjustment just asked that waits for a yes (nothing posted yet). */
  waitingNotice?: WaitingAdjustment | null
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
  onWriteOff?: () => void
  onExport?: (rows: LedgerRow[]) => void
  onNotice?: () => void
  /** B-W2b-327: the waiting adjustments' popover open or closed; read again; the waiting notice dismissed. */
  onWaiting?: (open: boolean) => void
  onRetryWaiting?: () => void
  onDismissWaitingNotice?: () => void
}

/** Why Write off… cannot start here (a key of warehouse-daily), or null: inventory.scrap and a stock key at a site. */
export function writeOffHeldKey(address: Pick<MovesAddress, 'site' | 'item'>, can: Pick<StockCan, 'scrap'>): string | null {
  if (!can.scrap) return 'wo.held.noRight'
  if (!explainsFigure(address)) return 'wo.held.noKey'
  return null
}

/** The stock key an Adjust starts from: the key in the address (site and material), else the row's. */
export function adjustKeyOf(address: MovesAddress, row: LedgerRow | null): { siteId: string; itemId: string; colourId: string | null; lotId: string | null; hideId: string | null; locationId: string | null } | null {
  if (address.site && address.item) return { siteId: address.site, itemId: address.item, colourId: address.colour, lotId: address.lot, hideId: address.hide, locationId: address.location }
  if (!row) return null
  const place = row.to.location ?? row.from.location
  return { siteId: row.siteId, itemId: row.item.id, colourId: row.colour?.id ?? null, lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null, locationId: place?.id ?? null }
}
