import type { LiveState } from '../../_shared/buying/hooks'
import type { PickerReason } from '../../_shared/reasons/api'
import type { LotCounts, PastStockRow, PerUnit, QualityStatus, ReservedKey, StockRow, Uom } from '../../_shared/stock/api'
import { decimalValue, isHeld, type StockCan } from '../../_shared/stock/model'
import type { AdjustDialogModel } from './adjust/model'
import type { HoldRow } from './daily/api'
import type { HoldDialogModel, HoldSubjectLine } from './daily/dialog-model'
import { availableOf, holdOfRow, holdsBySubject, spreadReservations, type HoldFact } from './daily/model'

/**
 * Warehouse › Stock (SCR-060; design warehouse.stock), pure: the saved views and the tile filters in the address, the
 * API's rows (one per site, location, item, colour, lot and hide) folded into the rows the grid shows (a leather lot at
 * a place is ONE row with its hides counted and its area summed; the Leather view keeps one row per hide), the search
 * (text or a scanned code), the notices (the most serious first) and the totals per unit (never across units).
 * B-W2a-64: what reservations hold of each row (and what is left available, never below what is reserved), why a row is
 * held (a quality hold's reason), the stock as of a past date (`?asOf=<instant>`: read only, held / reserved /
 * available are not kept for past days), the lots a selection puts on hold, and what the person may do every day.
 */

/** A stock row as read now or as of a past date (then held and available are null). */
export type GridRow = PastStockRow

/** The every-day abilities the shared StockCan does not carry (B-W2a-64). */
export interface DailyCan {
  /** quality.holds.view: the holds' reasons are read and said on the rows. */
  holdsView: boolean
  /** quality.holds.place: lots can be put on hold. */
  holdsPlace: boolean
  /** files.upload: a write-off's photo. */
  filesUpload: boolean
  /** quality.ncr.raise: "Open a nonconformance" on a write-off. */
  ncrRaise: boolean
}
export function dailyCan(permissions: readonly string[]): DailyCan {
  const held = new Set(permissions)
  return { holdsView: held.has('quality.holds.view'), holdsPlace: held.has('quality.holds.place'), filesUpload: held.has('files.upload'), ncrRaise: held.has('quality.ncr.raise') }
}

export const STOCK_VIEWS = ['material', 'lot', 'location', 'leather', 'quarantine'] as const
export type StockViewKey = (typeof STOCK_VIEWS)[number]
export const STOCK_TILES = ['quarantine', 'crvi', 'blocked', 'reserved'] as const
export type StockTile = (typeof STOCK_TILES)[number]

export interface StockAddress {
  site: string | null
  view: StockViewKey
  q: string
  tile: StockTile | null
  /** Stock as of a past instant (B-W2a-64, design st-asof); null: now. */
  asOf?: string | null
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

const one = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null => (value && (allowed as readonly string[]).includes(value) ? (value as T) : null)

/** The page's state from its address (`?site=&view=&q=&tile=`); unknown values fall back to the defaults. */
export function stockAddressOf(params: { get(name: string): string | null } | null): StockAddress {
  return {
    site: params?.get('site') || null,
    view: one(params?.get('view'), STOCK_VIEWS) ?? 'material',
    q: params?.get('q') ?? '',
    tile: one(params?.get('tile'), STOCK_TILES),
    asOf: asOfParam(params?.get('asOf')),
  }
}

/** An as-of instant from the address: a UTC instant in the past (a future or unreadable one is ignored: now). */
export function asOfParam(value: string | null | undefined, now: number = Date.now()): string | null {
  if (!value || !INSTANT.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) && at <= now + 60_000 ? new Date(at).toISOString() : null
}

export function stockQueryString(address: StockAddress): string {
  const query = new URLSearchParams()
  if (address.site) query.set('site', address.site)
  if (address.view !== 'material') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.tile) query.set('tile', address.tile)
  if (address.asOf) query.set('asOf', address.asOf)
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
  /** Null as of a past date (no history of quality status). */
  held: string | null
  /** What hides' own reservations hold of the row (the API's rows.reserved, summed). */
  hideReserved: number
  /** What reservations hold of the row (its hides' own, and the lot / any-lot ones placed on it); null as of a past date. */
  reserved: number | null
  /** On hand − held − reserved (below 0 when over-reserved); null as of a past date. */
  available: string | null
  /** The ACTIVE quality hold of the row's lot or hide (its reason in words), when the person may read holds. */
  hold: HoldFact | null
  unitCost: string | null | undefined
  value: number | null | undefined
}

const add = (a: string, b: string) => ((decimalValue(a) ?? 0) + (decimalValue(b) ?? 0)).toFixed(4)
const addOrNull = (a: string | null, b: string | null) => (a === null || b === null ? null : add(a, b))

/**
 * The API's rows as the grid shows them: per site, place, item, colour and lot; one per hide only when `perHide`. With
 * `holds` each row carries its lot's (or hide's) ACTIVE quality hold; as of a past date (held null) nothing is reserved.
 */
export function stockLines(rows: readonly GridRow[], perHide: boolean, withCost: boolean, holds: ReadonlyMap<string, HoldFact> = new Map()): StockLine[] {
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
        hideReserved: decimalValue(row.reserved) ?? 0,
        reserved: row.held === null ? null : (decimalValue(row.reserved) ?? 0),
        available: row.available,
        hold: holdOfRow(holds, { lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null }),
        unitCost: withCost ? (row.unitCost ?? null) : undefined,
        value: withCost ? (row.value ?? null) : undefined,
      })
      continue
    }
    found.hides += leather ? 1 : 0
    found.hide = null
    found.onHand = add(found.onHand, row.onHand)
    found.held = addOrNull(found.held, row.held)
    found.available = addOrNull(found.available, row.available)
    found.hideReserved = Math.round((found.hideReserved + (decimalValue(row.reserved) ?? 0)) * 10_000) / 10_000
    found.reserved = found.reserved === null || row.held === null ? null : found.hideReserved
    found.hold = found.hold ?? holdOfRow(holds, { lotId: row.lot?.id ?? null, hideId: row.hide?.id ?? null })
    if (withCost) {
      // A lot's hides share the lot's cost; a value is unknown as soon as one part of it is.
      found.unitCost = found.unitCost !== null && found.unitCost === (row.unitCost ?? null) ? found.unitCost : null
      found.value = found.value === null || found.value === undefined || row.value === null || row.value === undefined ? null : found.value + row.value
    }
  }
  return [...lines.values()]
}

const text = (line: StockLine) => [line.item.code, line.item.name, line.colour?.code, line.colour?.name, line.lot?.code, line.hide?.code, line.location.code, line.location.name].filter(Boolean).join(' ').toLowerCase()

/** What the lines' reservations come to: the lot and any-lot ones placed per row, available again, and the keys over-reserved. */
export function reservedLines(lines: StockLine[], reservations: readonly ReservedKey[]): { lines: StockLine[]; over: number } {
  if (lines.some((line) => line.held === null)) return { lines, over: 0 }
  const spread = spreadReservations(
    lines.map((line) => ({ id: line.id, siteId: line.siteId, itemId: line.item.id, colourId: line.colour?.id ?? null, lotId: line.lot?.id ?? null, locationCode: line.location.code, onHand: decimalValue(line.onHand) ?? 0, held: decimalValue(line.held) ?? 0, hideReserved: line.hideReserved })),
    reservations,
  )
  return {
    lines: lines.map((line) => {
      const reserved = spread.reserved.get(line.id) ?? line.hideReserved
      return { ...line, reserved, available: availableOf(decimalValue(line.onHand) ?? 0, decimalValue(line.held) ?? 0, reserved).toFixed(4) }
    }),
    over: spread.over.size,
  }
}

/** What the page knows beside the rows: the reservations per key and the ACTIVE quality holds (both may be absent). */
export interface StockExtras {
  reservations?: readonly ReservedKey[]
  holds?: readonly HoldRow[]
}

/** The rows of a view, a tile and a search, in the view's order. `crViLots` = the lots that wait for their Cr VI result. */
export function visibleLines(rows: readonly GridRow[], address: StockAddress, withCost: boolean, crViLots: ReadonlySet<string> = new Set(), extras: StockExtras = {}): StockLine[] {
  const holds = holdsBySubject(extras.holds ?? [])
  // Reservations are placed over every row of the site (before a view or a filter narrows them: the figures never change with it).
  let lines = reservedLines(stockLines(rows.filter((row) => address.view !== 'leather' || row.item.tracking === 'HIDE'), address.view === 'leather', withCost, holds), extras.reservations ?? []).lines
  if (address.view === 'lot') lines = lines.filter((line) => line.lot !== null)
  // On hold: lots not released, and (B-W2a-64) stock under a quality hold.
  if (address.view === 'quarantine') lines = lines.filter((line) => isHeld(line.lot?.qualityStatus) || line.hold !== null)
  if (address.tile === 'quarantine') lines = lines.filter((line) => line.lot?.qualityStatus === 'QUARANTINE')
  if (address.tile === 'blocked') lines = lines.filter((line) => line.lot?.qualityStatus === 'BLOCKED' || line.lot?.qualityStatus === 'REJECTED')
  if (address.tile === 'crvi') lines = lines.filter((line) => line.lot !== null && crViLots.has(line.lot.id))
  if (address.tile === 'reserved') lines = lines.filter((line) => (line.reserved ?? 0) > 0)
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
export function scanTarget(rows: readonly GridRow[], code: string): { type: 'Hide' | 'Lot'; id: string } | null {
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
export function stockNotices(counts: LotCounts | null, truncated: boolean, unvalued: number | null, overReserved = 0): StockNotice[] {
  const notices: StockNotice[] = []
  if (overReserved > 0) notices.push({ id: `overReserved:${overReserved}`, tone: 'warning', key: 'st.notice.overReserved', params: { count: overReserved }, tile: 'reserved' })
  if (counts && counts.crViFailed > 0) notices.push({ id: `crViFailed:${counts.crViFailed}`, tone: 'danger', key: 'st.notice.crViFailed', params: { count: counts.crViFailed } })
  if (counts && counts.waitingCrVi > 0) notices.push({ id: `crvi:${counts.waitingCrVi}`, tone: 'warning', key: 'st.notice.crVi', params: { count: counts.waitingCrVi }, tile: 'crvi' })
  if (counts && counts.quarantine > 0) notices.push({ id: `quarantine:${counts.quarantine}`, tone: 'info', key: 'st.notice.quarantine', params: { count: counts.quarantine }, tile: 'quarantine' })
  if (truncated) notices.push({ id: 'truncated', tone: 'warning', key: 'st.notice.truncated' })
  if (unvalued !== null && unvalued > 0) notices.push({ id: `unvalued:${unvalued}`, tone: 'info', key: 'st.notice.unvalued', params: { count: unvalued } })
  return notices
}

/** The tile's count (lots; for Reserved the rows holding reservations), unknown as "—" (never 0). */
export function tileCount(tile: StockTile, counts: LotCounts | null, reservedRows: number | null = null): number | null {
  if (tile === 'reserved') return reservedRows
  if (!counts) return null
  return tile === 'quarantine' ? counts.quarantine : tile === 'crvi' ? counts.waitingCrVi : counts.blocked + counts.rejected
}

/** The quantity a tile's lots hold here, per unit (the tile's second number: "3 lots · 412,5 ft²"); Reserved: what is reserved. */
export function tileStock(rows: readonly GridRow[], tile: StockTile, crViLots: ReadonlySet<string>, extras: StockExtras = {}): PerUnit[] {
  const lines = visibleLines(rows, { site: null, view: 'material', q: '', tile }, false, crViLots, extras)
  if (tile !== 'reserved') return onHandPerUnit(lines)
  return reservedPerUnit(lines)
}

/** What reservations hold over some rows, per unit. */
export function reservedPerUnit(lines: readonly StockLine[]): PerUnit[] {
  const sums = new Map<Uom, number>()
  for (const line of lines) if ((line.reserved ?? 0) > 0) sums.set(line.item.baseUom, (sums.get(line.item.baseUom) ?? 0) + (line.reserved ?? 0))
  return [...sums.entries()].map(([uom, value]) => ({ uom, quantity: value.toFixed(4) }))
}

/** How many keys hold more reserved than there is (the notice). */
export const overReservedKeys = (rows: readonly GridRow[], withCost: boolean, reservations: readonly ReservedKey[]): number =>
  reservedLines(stockLines(rows, false, withCost), reservations).over

// ---- putting lots on hold ---------------------------------------------------------------------------------------------------

/** The lots some rows name (each once, with what of it these rows hold, per unit and in hides), and the rows without a lot. */
export function holdSubjectsOf(lines: readonly StockLine[]): { subjects: HoldSubjectLine[]; leftOut: number } {
  const subjects = new Map<string, HoldSubjectLine>()
  let leftOut = 0
  for (const line of lines) {
    if (!line.lot) {
      leftOut += 1
      continue
    }
    const found = subjects.get(line.lot.id) ?? { id: line.lot.id, code: line.lot.code, stock: [], hides: 0 }
    found.stock = [...found.stock, { uom: line.item.baseUom, quantity: line.onHand }]
    found.hides += line.hides
    subjects.set(line.lot.id, found)
  }
  return { subjects: [...subjects.values()], leftOut }
}

/** Why "Put N lots on hold" is held (a key of warehouse-daily), or null. */
export function holdHeldKey(lines: readonly StockLine[], can: Pick<DailyCan, 'holdsPlace'>, pastDate: boolean): string | null {
  if (pastDate) return 'hold.held.pastDate'
  if (!can.holdsPlace) return 'hold.held.noRight'
  if (!lines.some((line) => line.lot !== null)) return lines.length === 1 ? 'hold.held.noLot' : 'hold.held.pickLots'
  return null
}

// ---- stock as of a date ------------------------------------------------------------------------------------------------------

/** The as-of dialog's draft: a day (YYYY-MM-DD) and a time (HH:MM, end of day by default). */
export interface AsOfDraft {
  day: string
  time: string
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
  rows: GridRow[] | null
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
  /** B-W2a-64: the every-day abilities (holds, photos, NCRs). */
  daily?: DailyCan
  /** What open reservations hold per site, material, colour and lot (empty as of a past date). */
  reservations?: readonly ReservedKey[]
  /** The ACTIVE quality holds of the site's lots and hides (quality.holds.view), and the HOLD reasons' words. */
  holds?: readonly HoldRow[]
  holdReasons?: readonly PickerReason[]
  /** The as-of dialog open (its draft), the hold dialog. */
  asOfDialog?: AsOfDraft | null
  hold?: HoldDialogModel | null
  /** "Now" for the as-of dialog's checks (design cases fix it; else the clock). */
  now?: string
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
  /** B-W2a-64: the as-of dialog (open with a draft, change, show, back to now, close) and Put on hold. */
  onAsOf?: (draft: AsOfDraft | null) => void
  onAsOfShow?: (draft: AsOfDraft) => void
  onNow?: () => void
  onHold?: (lines: StockLine[]) => void
}

/** Why Adjust cannot start on this row (one stock key at one place; a leather row of several hides names one hide). */
export function adjustHeldKey(line: StockLine | null, can: Pick<StockCan, 'adjust'>, pastDate = false): string | null {
  if (pastDate) return 'st.held.pastDate'
  if (!can.adjust) return 'st.held.noAdjust'
  if (!line) return 'st.held.pickOne'
  if (line.item.tracking === 'HIDE' && !line.hide) return 'st.held.severalHides'
  return null
}

export const qualityOf = (line: StockLine): QualityStatus | null => line.lot?.qualityStatus ?? null
