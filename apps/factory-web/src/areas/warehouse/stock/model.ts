import type { LiveState } from '../../_shared/buying/hooks'
import type { LotCounts, PerUnit, QualityStatus, StockRow, Uom } from '../../_shared/stock/api'
import { decimalValue, isHeld, type StockCan } from '../../_shared/stock/model'
import type { AdjustDialogModel } from './adjust/model'

/**
 * Warehouse › Stock (SCR-060; design warehouse.stock), pure: the saved views and the tile filters in the address, the
 * API's rows (one per site, location, item, colour, lot and hide) folded into the rows the grid shows (a leather lot at
 * a place is ONE row with its hides counted and its area summed; the Leather view keeps one row per hide), the search
 * (text or a scanned code), the notices (the most serious first) and the totals per unit (never across units).
 */

export const STOCK_VIEWS = ['material', 'lot', 'location', 'leather', 'quarantine'] as const
export type StockViewKey = (typeof STOCK_VIEWS)[number]
export const STOCK_TILES = ['quarantine', 'crvi', 'blocked'] as const
export type StockTile = (typeof STOCK_TILES)[number]

export interface StockAddress {
  site: string | null
  view: StockViewKey
  q: string
  tile: StockTile | null
}

const one = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null)

/** The page's state from its address (`?site=&view=&q=&tile=`); unknown values fall back to the defaults. */
export function stockAddressOf(params: { get(name: string): string | null } | null): StockAddress {
  return {
    site: params?.get('site') || null,
    view: one(params?.get('view'), STOCK_VIEWS) ?? 'material',
    q: params?.get('q') ?? '',
    tile: one(params?.get('tile'), STOCK_TILES),
  }
}

export function stockQueryString(address: StockAddress): string {
  const query = new URLSearchParams()
  if (address.site) query.set('site', address.site)
  if (address.view !== 'material') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.tile) query.set('tile', address.tile)
  return query.toString()
}

/** One row of the grid: a stock key at a place (a leather lot's hides folded into it, except in the Leather view). */
export interface StockLine {
  id: string
  siteId: string
  siteCode: string
  location: StockRow['location']
  item: StockRow['item']
  colour: StockRow['colour']
  lot: StockRow['lot']
  /** One hide (the Leather view, or a lot of one hide here): adjustable as it stands. */
  hide: StockRow['hide']
  /** The hides folded into this row (leather); 0 for anything else. */
  hides: number
  onHand: string
  held: string
  available: string
  unitCost: string | null | undefined
  value: number | null | undefined
}

const add = (a: string, b: string) => ((decimalValue(a) ?? 0) + (decimalValue(b) ?? 0)).toFixed(4)

/** The API's rows as the grid shows them: per site, place, item, colour and lot; one per hide only when `perHide`. */
export function stockLines(rows: readonly StockRow[], perHide: boolean, withCost: boolean): StockLine[] {
  const lines = new Map<string, StockLine>()
  for (const row of rows) {
    const leather = row.item.tracking === 'HIDE' && row.hide !== null
    const key = [row.siteId, row.location.id, row.item.id, row.colour?.id ?? '-', row.lot?.id ?? '-', perHide ? (row.hide?.id ?? '-') : '-'].join('|')
    const found = lines.get(key)
    if (!found) {
      lines.set(key, {
        id: key,
        siteId: row.siteId,
        siteCode: row.siteCode,
        location: row.location,
        item: row.item,
        colour: row.colour,
        lot: row.lot,
        hide: row.hide,
        hides: leather ? 1 : 0,
        onHand: row.onHand,
        held: row.held,
        available: row.available,
        unitCost: withCost ? (row.unitCost ?? null) : undefined,
        value: withCost ? (row.value ?? null) : undefined,
      })
      continue
    }
    found.hides += leather ? 1 : 0
    found.hide = null
    found.onHand = add(found.onHand, row.onHand)
    found.held = add(found.held, row.held)
    found.available = add(found.available, row.available)
    if (withCost) {
      // A lot's hides share the lot's cost; a value is unknown as soon as one part of it is.
      found.unitCost = found.unitCost !== null && found.unitCost === (row.unitCost ?? null) ? found.unitCost : null
      found.value = found.value === null || found.value === undefined || row.value === null || row.value === undefined ? null : found.value + row.value
    }
  }
  return [...lines.values()]
}

const text = (line: StockLine) => [line.item.code, line.item.name, line.colour?.code, line.colour?.name, line.lot?.code, line.hide?.code, line.location.code, line.location.name].filter(Boolean).join(' ').toLowerCase()

/** The rows of a view, a tile and a search, in the view's order. `crViLots` = the lots that wait for their Cr VI result. */
export function visibleLines(rows: readonly StockRow[], address: StockAddress, withCost: boolean, crViLots: ReadonlySet<string> = new Set()): StockLine[] {
  let lines = stockLines(rows.filter((row) => address.view !== 'leather' || row.item.tracking === 'HIDE'), address.view === 'leather', withCost)
  if (address.view === 'lot') lines = lines.filter((line) => line.lot !== null)
  if (address.view === 'quarantine') lines = lines.filter((line) => isHeld(line.lot?.qualityStatus))
  if (address.tile === 'quarantine') lines = lines.filter((line) => line.lot?.qualityStatus === 'QUARANTINE')
  if (address.tile === 'blocked') lines = lines.filter((line) => line.lot?.qualityStatus === 'BLOCKED' || line.lot?.qualityStatus === 'REJECTED')
  if (address.tile === 'crvi') lines = lines.filter((line) => line.lot !== null && crViLots.has(line.lot.id))
  const needle = address.q.trim().toLowerCase()
  if (needle) lines = lines.filter((line) => text(line).includes(needle))
  const by = (...parts: (string | undefined | null)[]) => parts.map((part) => part ?? '').join('\u0000')
  const order: Record<StockViewKey, (line: StockLine) => string> = {
    material: (line) => by(line.item.code, line.colour?.code, line.lot?.code, line.location.code),
    lot: (line) => by(line.lot?.code, line.location.code),
    location: (line) => by(line.siteCode, line.location.code, line.item.code, line.lot?.code),
    leather: (line) => by(line.item.code, line.lot?.code, line.hide?.code),
    quarantine: (line) => by(line.lot?.qualityStatus, line.lot?.code, line.location.code),
  }
  return lines.sort((a, b) => order[address.view](a).localeCompare(order[address.view](b)))
}

/** A scanned (or typed) code that names exactly one record here: a hide tag or a lot code opens it. */
export function scanTarget(rows: readonly StockRow[], code: string): { type: 'Hide' | 'Lot'; id: string } | null {
  const wanted = code.trim().toUpperCase()
  if (!wanted) return null
  const hide = rows.find((row) => row.hide?.code.toUpperCase() === wanted)
  if (hide?.hide) return { type: 'Hide', id: hide.hide.id }
  const lot = rows.find((row) => row.lot?.code.toUpperCase() === wanted)
  return lot?.lot ? { type: 'Lot', id: lot.lot.id } : null
}

/** On hand per unit over some rows (the filter's or the selection's totals; units never added together). */
export function onHandPerUnit(lines: readonly StockLine[]): PerUnit[] {
  const sums = new Map<Uom, number>()
  for (const line of lines) sums.set(line.item.baseUom, (sums.get(line.item.baseUom) ?? 0) + (decimalValue(line.onHand) ?? 0))
  return [...sums.entries()].map(([uom, value]) => ({ uom, quantity: value.toFixed(4) }))
}

/** The hides among some rows. */
export const hidesOf = (lines: readonly StockLine[]) => lines.reduce((sum, line) => sum + line.hides, 0)

/** The rows' value in minor units with its currency, null when one is unknown or the currencies differ. */
export function valueOf(lines: readonly StockLine[], currencyOf: (line: StockLine) => string | null): { amount: number; currency: string } | null {
  let amount = 0
  let currency: string | null = null
  for (const line of lines) {
    const own = currencyOf(line)
    if (line.value === null || line.value === undefined || !own || (currency !== null && own !== currency)) return null
    currency = own
    amount += line.value
  }
  return currency === null ? null : { amount, currency }
}

// ---- notices ------------------------------------------------------------------------------------------------------------

export interface StockNotice {
  id: string
  tone: 'warning' | 'danger' | 'info'
  key: string
  params?: Record<string, string | number>
  /** The tile it applies ("Show them"). */
  tile?: StockTile
}

/** The notices of the page, the most serious first (design st-notice: one at a time, the rest behind "n more"). */
export function stockNotices(counts: LotCounts | null, truncated: boolean, unvalued: number | null): StockNotice[] {
  const notices: StockNotice[] = []
  if (counts && counts.crViFailed > 0) notices.push({ id: `crViFailed:${counts.crViFailed}`, tone: 'danger', key: 'st.notice.crViFailed', params: { count: counts.crViFailed } })
  if (counts && counts.waitingCrVi > 0) notices.push({ id: `crvi:${counts.waitingCrVi}`, tone: 'warning', key: 'st.notice.crVi', params: { count: counts.waitingCrVi }, tile: 'crvi' })
  if (counts && counts.quarantine > 0) notices.push({ id: `quarantine:${counts.quarantine}`, tone: 'info', key: 'st.notice.quarantine', params: { count: counts.quarantine }, tile: 'quarantine' })
  if (truncated) notices.push({ id: 'truncated', tone: 'warning', key: 'st.notice.truncated' })
  if (unvalued !== null && unvalued > 0) notices.push({ id: `unvalued:${unvalued}`, tone: 'info', key: 'st.notice.unvalued', params: { count: unvalued } })
  return notices
}

/** The tile's count (lots), unknown as "—" (never 0). */
export function tileCount(tile: StockTile, counts: LotCounts | null): number | null {
  if (!counts) return null
  return tile === 'quarantine' ? counts.quarantine : tile === 'crvi' ? counts.waitingCrVi : counts.blocked + counts.rejected
}

/** The quantity a tile's lots hold here, per unit (the tile's second number: "3 lots · 412,5 ft²"). */
export function tileStock(rows: readonly StockRow[], tile: StockTile, crViLots: ReadonlySet<string>): PerUnit[] {
  const lines = visibleLines(rows, { site: null, view: 'material', q: '', tile }, false, crViLots)
  return onHandPerUnit(lines)
}

// ---- the page model --------------------------------------------------------------------------------------------------------

export interface SiteChoice {
  id: string
  code: string
  name: string
}

export interface StockPageModel {
  prefix: string
  can: StockCan
  address: StockAddress
  sites: SiteChoice[]
  /** null while the first read runs. */
  rows: StockRow[] | null
  problem: string | null
  truncated: boolean
  counts: LotCounts | null
  /** The lots waiting for their Cr VI result (the tile's filter). */
  crViLots: string[]
  /** Moves not valued yet (cost grain only; null otherwise or unknown). */
  unvalued: number | null
  /** Currencies of the items (the value's), when known. */
  currencies?: Readonly<Record<string, string>>
  asOf: string | null
  live: LiveState
  updates: number
  dismissed: readonly string[]
  timeZone: string
  notice?: { tone: 'success' | 'danger'; key: string; params?: Record<string, string | number> } | null
  adjust?: AdjustDialogModel | null
  /** Design cases: the rows selected, the keys panel open. */
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
}

export interface StockPageActions {
  onAddress?: (next: Partial<StockAddress>) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismiss?: (id: string) => void
  onOpenRecord?: (type: 'Hide' | 'Lot', id: string) => void
  onAdjust?: (line: StockLine) => void
  onExport?: (lines: StockLine[]) => void
  onNotice?: () => void
}

/** Why Adjust cannot start on this row (one stock key at one place; a leather row of several hides names one hide). */
export function adjustHeldKey(line: StockLine | null, can: Pick<StockCan, 'adjust'>): string | null {
  if (!can.adjust) return 'st.held.noAdjust'
  if (!line) return 'st.held.pickOne'
  if (line.item.tracking === 'HIDE' && !line.hide) return 'st.held.severalHides'
  return null
}

export const qualityOf = (line: StockLine): QualityStatus | null => line.lot?.qualityStatus ?? null
