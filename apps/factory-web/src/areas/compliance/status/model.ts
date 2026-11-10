import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvText } from '../../quality/ncr/model'
import { CELL_STATES, GAP_TYPES, GATES, type ActionLine, type BoardRow, type CellState, type FeedState, type FixPlace, type GapType, type Gate, type GateEvent, type Market } from './api'

/**
 * The pure rules of Compliance › Status board (B-W2b-266, SCR-119; the print window SCR-314): what this person may open (from the
 * session's permissions; the API checks each read and the override again), the address (markets, brand, gap, status, search, the
 * refusals' filter), where every number, blocker, evidence and refusal leads (a page only once built and in the role, else the
 * words say why), the cell walk (J / K), the override's limits and the files. Nothing here names a person.
 */

export { csvText }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface StatusCan {
  /** compliance.certificates.view: the page and every read of it. */
  view: boolean
  /** compliance.gates.override: the door; each refusal's `mayOverride` says whether the requirement names the role. */
  override: boolean
  /** The pages a number, a fix or a refusal opens (their own view permission). */
  lots: boolean
  workOrders: boolean
  shipments: boolean
  styles: boolean
}

export function statusCan(permissions: readonly string[]): StatusCan {
  const held = new Set(permissions)
  return {
    view: held.has('compliance.certificates.view'),
    override: held.has('compliance.gates.override'),
    lots: held.has('quality.lots.view'),
    workOrders: held.has('workorders.view'),
    shipments: held.has('shipping.view'),
    styles: held.has('product.styles.view'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export const STATUS_FILTERS = ['ready', 'missing', 'blocked', 'expiring'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]
export const FEED_FILTERS = ['all', 'blocked', 'cleared', 'overridden'] as const
export type FeedFilter = (typeof FEED_FILTERS)[number]
/** The refusals' window: the design's 7 days; 30 for the "shipments held" tile (what it counts). */
export const FEED_DAYS = [7, 30] as const
export type FeedDays = (typeof FEED_DAYS)[number]

export interface StatusAddress {
  /** The markets asked (none: the switched-on ones). */
  markets: string[]
  brandId: string | null
  /** One gap type (B-W2b-272's gap bars): the matrix and "Needs action" over that type only. */
  gap: GapType | null
  /** Rows by their state (a tile is a filter: ready, blocked). */
  status: StatusFilter | null
  q: string
  /** The refusals' filters. */
  gate: Gate | null
  feed: FeedFilter
  days: FeedDays
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => (value && (list as readonly string[]).includes(value) ? (value as T) : null)

export const EMPTY_ADDRESS: StatusAddress = Object.freeze({ markets: [], brandId: null, gap: null, status: null, q: '', gate: null, feed: 'all', days: 7 }) as StatusAddress

export function statusAddressOf(params: { get(name: string): string | null } | null | undefined): StatusAddress {
  const markets = (params?.get('markets') ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2,3}$/.test(code))
  const brand = params?.get('brand') ?? ''
  const days = Number(params?.get('days') ?? '')
  return {
    markets: [...new Set(markets)],
    brandId: UUID.test(brand) ? brand : null,
    gap: oneOf(GAP_TYPES, params?.get('gap')),
    status: oneOf(STATUS_FILTERS, params?.get('status')),
    q: (params?.get('q') ?? '').slice(0, 100),
    gate: oneOf(GATES, params?.get('gate')),
    feed: oneOf(FEED_FILTERS, params?.get('feed')) ?? 'all',
    days: (FEED_DAYS as readonly number[]).includes(days) ? (days as FeedDays) : 7,
  }
}

export function statusAddressText(address: StatusAddress): string {
  const terms = new URLSearchParams()
  if (address.markets.length > 0) terms.set('markets', address.markets.join(','))
  if (address.brandId) terms.set('brand', address.brandId)
  if (address.gap) terms.set('gap', address.gap)
  if (address.status) terms.set('status', address.status)
  if (address.q.trim()) terms.set('q', address.q.trim())
  if (address.gate) terms.set('gate', address.gate)
  if (address.feed !== 'all') terms.set('feed', address.feed)
  if (address.days !== 7) terms.set('days', String(address.days))
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** What the board is asked: Cr VI is per lot, not per style × market cell (it opens the lots; the matrix stays whole). */
export const boardQueryOf = (address: StatusAddress) => ({ markets: address.markets, brandId: address.brandId, gap: address.gap === 'crVi' ? null : address.gap, q: address.q.trim() || null })

/** The filters the matrix shows as chips (each with its Clear). */
export const filtersOn = (address: StatusAddress): number => (address.markets.length > 0 ? 1 : 0) + (address.brandId ? 1 : 0) + (address.gap ? 1 : 0) + (address.status ? 1 : 0) + (address.q.trim() ? 1 : 0)

// ---- the matrix --------------------------------------------------------------------------------------------------------------

const STATE_OF: Readonly<Record<StatusFilter, CellState>> = { ready: 'READY', missing: 'MISSING', blocked: 'BLOCKED', expiring: 'EXPIRING' }

/** The rows a status filter keeps: ready (every market ready), blocked (any cell blocked), missing / expiring (any such cell). */
export function rowsShown(rows: readonly BoardRow[], status: StatusFilter | null): BoardRow[] {
  if (!status) return [...rows]
  if (status === 'ready') return rows.filter((row) => row.ready)
  if (status === 'blocked') return rows.filter((row) => row.blocked)
  return rows.filter((row) => row.cells.some((cell) => cell.state === STATE_OF[status]))
}

/** The tone of a cell's state (always drawn with its word and icon). */
export const CELL_TONE: Readonly<Record<CellState, 'success' | 'warning' | 'danger' | 'info'>> = { READY: 'success', MISSING: 'warning', BLOCKED: 'danger', EXPIRING: 'info' }

/** Market codes that are not the ISO region's (the market profiles' UK and EL). */
const REGION_OF: Readonly<Record<string, string>> = { UK: 'GB', EL: 'GR' }

/**
 * "DE" → "Germania" / "Germany": the country's name in the page's language (Intl), else the market's own name as the API holds
 * it, else the code.
 */
export function marketName(code: string, markets: readonly Pick<Market, 'code' | 'name'>[], locale?: string): string {
  if (locale && /^[A-Z]{2}$/.test(code)) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'region' }).of(REGION_OF[code] ?? code)
      if (name && name !== code) return name
    } catch {
      // An engine without region names: the API's name.
    }
  }
  return markets.find((market) => market.code === code)?.name ?? code
}

export interface CellRef {
  readonly styleId: string
  readonly market: string
}

/**
 * The cell modal's walk (design cs-cell "J / K walk cells in the row, ⇧J / ⇧K rows"): the next and previous cell in the row and
 * the same market in the next and previous row of what is shown.
 */
export function cellWalk(rows: readonly BoardRow[], markets: readonly string[], at: CellRef): { next: CellRef | null; prev: CellRef | null; down: CellRef | null; up: CellRef | null } {
  const row = rows.findIndex((entry) => entry.style.id === at.styleId)
  const column = markets.indexOf(at.market)
  if (row < 0 || column < 0) return { next: null, prev: null, down: null, up: null }
  const cell = (r: number, c: number): CellRef | null => (r >= 0 && r < rows.length && c >= 0 && c < markets.length ? { styleId: rows[r]!.style.id, market: markets[c]! } : null)
  return { next: cell(row, column + 1), prev: cell(row, column - 1), down: cell(row + 1, column), up: cell(row - 1, column) }
}

/** The cell Enter on a row opens: its first blocked, else missing, else expiring cell, else its first. */
export function firstCellOf(row: BoardRow): CellRef | null {
  const rank: Readonly<Record<CellState, number>> = { BLOCKED: 0, MISSING: 1, EXPIRING: 2, READY: 3 }
  const cell = [...row.cells].sort((a, b) => rank[a.state] - rank[b.state])[0]
  return cell ? { styleId: row.style.id, market: cell.marketCode } : null
}

// ---- where things lead -------------------------------------------------------------------------------------------------------

/** The office page of each fix place (B-W2b-254's FIX_PLACES); Declarations and Rules & markets come with their steps. */
export const FIX_PAGE: Readonly<Record<FixPlace, string>> = {
  certificates: '/compliance/certificates',
  declarations: '/compliance/declarations',
  labels: '/compliance/labels',
  operators: '/compliance/settings',
  tests: '/compliance/tests',
  markets: '/compliance/settings',
  requirements: '/compliance/settings',
}

/** The page where a blocker is fixed, once built and in the role; null otherwise (`fixHeld` says why). */
export function fixHref(place: FixPlace, prefix: string, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const page = FIX_PAGE[place]
  if (!built.has(page)) return null
  if (place === 'tests' && !can.lots) return null
  return `${prefix}${page}`
}

/** Why a Fix button is held (a message key), or null when it opens its page. */
export function fixHeld(place: FixPlace, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  if (!built.has(FIX_PAGE[place])) return place === 'declarations' ? 'fix.held.declarations' : 'fix.held.settings'
  if (place === 'tests' && !can.lots) return 'fix.held.role'
  return null
}

/** A record's own page (or its panels while its page is not built). */
export const recordHref = (record: { readonly recordType: string; readonly recordId: string; readonly label?: string | null }, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): string =>
  `${prefix}${recordAddress({ type: record.recordType, id: record.recordId, label: record.label ?? undefined }, built)}`

/** The record a refusal stopped (a work order or a shipment), when the person may open its page. */
export function subjectHref(event: Pick<GateEvent, 'subject'>, prefix: string, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const type = event.subject.type
  if (type === 'WorkOrder' && !can.workOrders) return null
  if (type === 'Shipment' && !can.shipments) return null
  return recordHref({ recordType: type, recordId: event.subject.id, label: event.subject.number }, prefix, built)
}

/** A style's record (Products › Styles), when built and in the role. */
export const styleHref = (styleId: string, prefix: string, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null =>
  can.styles && built.has('/products/styles/[id]') ? `${prefix}/products/styles/${encodeURIComponent(styleId)}` : null

export type TileKey = 'stylesReady' | 'stylesBlocked' | 'certificatesExpiring90' | 'lotsWithoutCrVi' | 'missingLanguages' | 'shipmentsHeld'
export const TILE_KEYS: readonly TileKey[] = ['stylesReady', 'stylesBlocked', 'certificatesExpiring90', 'lotsWithoutCrVi', 'missingLanguages', 'shipmentsHeld']

/**
 * What a tile does (design cs-kpi "Tile = filter on the matrix below (chip)"): the styles' tiles and the languages filter the
 * matrix, "shipments held" filters the refusals; the certificates and the lots open their lists (they are records, not cells).
 */
export type TileAct = { kind: 'filter'; change: Partial<StatusAddress> } | { kind: 'link'; href: string } | { kind: 'none'; held: string }

export function tileAct(key: TileKey, prefix: string, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): TileAct {
  switch (key) {
    case 'stylesReady':
      return { kind: 'filter', change: { status: 'ready', gap: null } }
    case 'stylesBlocked':
      return { kind: 'filter', change: { status: 'blocked', gap: null } }
    case 'missingLanguages':
      return { kind: 'filter', change: { gap: 'docLanguage', status: null } }
    case 'shipmentsHeld':
      return { kind: 'filter', change: { gate: 'SHIPMENT', feed: 'blocked', days: 30 } }
    case 'certificatesExpiring90':
      return built.has('/compliance/certificates') ? { kind: 'link', href: `${prefix}/compliance/certificates?view=expiring90` } : { kind: 'none', held: 'tile.held.noList' }
    case 'lotsWithoutCrVi':
      return can.lots && built.has('/compliance/tests') ? { kind: 'link', href: `${prefix}/compliance/tests?view=waiting` } : { kind: 'none', held: 'tile.held.role' }
  }
}

/** Whether a filter tile is the one engaged now. */
export function tileActive(key: TileKey, address: StatusAddress): boolean {
  if (key === 'stylesReady') return address.status === 'ready'
  if (key === 'stylesBlocked') return address.status === 'blocked'
  if (key === 'missingLanguages') return address.gap === 'docLanguage'
  if (key === 'shipmentsHeld') return address.gate === 'SHIPMENT' && address.feed === 'blocked' && address.days === 30
  return false
}

/** Pressing an engaged filter tile again clears what it set. */
export function tileToggle(key: TileKey, address: StatusAddress, act: TileAct): Partial<StatusAddress> {
  if (act.kind !== 'filter') return {}
  if (!tileActive(key, address)) return act.change
  if (key === 'shipmentsHeld') return { gate: null, feed: 'all', days: 7 }
  if (key === 'missingLanguages') return { gap: null }
  return { status: null }
}

/** The lots a Cr VI gap opens (Tests & substances, waiting for evidence): Cr VI is per lot, never a style × market cell. */
export const crViHref = (prefix: string, can: StatusCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null => (can.lots && built.has('/compliance/tests') ? `${prefix}/compliance/tests?view=waiting` : null)

// ---- gate refusals ------------------------------------------------------------------------------------------------------------

const FEED_STATE: Readonly<Record<Exclude<FeedFilter, 'all'>, FeedState>> = { blocked: 'BLOCKED', cleared: 'CLEARED', overridden: 'OVERRIDDEN' }

/** The refusals a filter keeps (an override row stays with "all"). */
export const feedShown = (events: readonly GateEvent[], filter: FeedFilter): GateEvent[] => (filter === 'all' ? [...events] : events.filter((event) => event.state === FEED_STATE[filter]))

/** The tone of a refusal's state (with its word). */
export const FEED_TONE: Readonly<Record<FeedState, 'danger' | 'success' | 'warning' | 'neutral'>> = { BLOCKED: 'danger', CLEARED: 'success', OVERRIDDEN: 'warning', OVERRIDE: 'neutral' }

/** Why "Override…" is held on a refusal (a message key), or null when the person may override it now. */
export function overrideHeld(event: GateEvent, can: StatusCan, offline: boolean): string | null {
  if (event.outcome !== 'REFUSED') return 'override.held.notRefusal'
  if (event.state !== 'BLOCKED') return `override.held.state.${event.state}`
  if (event.requirement.locked) return 'override.held.locked'
  if (event.requirement.overrideRoleKeys.length === 0) return 'override.held.noRole'
  if (!can.override || !event.mayOverride) return 'override.held.role'
  if (offline) return 'override.held.offline'
  return null
}

// ---- the override (cs-override) ------------------------------------------------------------------------------------------------

/** The API's limits (factory-domain compliance/gates/override): a reason of 10 to 2000 characters; at most 7 days. */
export const OVERRIDE_REASON_MIN = 10
export const OVERRIDE_REASON_MAX = 2000
export const OVERRIDE_DAYS_MAX = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** The latest end an override may have now: the requirement's days, at most 7 (`latestUntil`). */
export const latestUntil = (now: Date, maxDays: number): Date => new Date(now.getTime() + Math.min(Math.max(maxDays, 0), OVERRIDE_DAYS_MAX) * DAY_MS)

/** A business day as YYYY-MM-DD in Rome (the site's zone). */
export const romeDay = (instant: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)

/** The end of a day in Rome as an instant (23:59:59 there). */
export function endOfRomeDay(day: string): Date {
  // Rome is UTC+1 or UTC+2: the later of the two candidates that is still that day in Rome.
  for (const offset of [1, 2]) {
    const candidate = new Date(`${day}T23:59:59.000+0${offset}:00`)
    if (romeDay(candidate) === day) return candidate
  }
  return new Date(`${day}T22:59:59.000Z`)
}

/** The override's end for a picked day: the end of that day in Rome, never later than the latest allowed. */
export function untilOf(day: string, now: Date, maxDays: number): Date {
  const latest = latestUntil(now, maxDays)
  const end = endOfRomeDay(day)
  return end.getTime() > latest.getTime() ? latest : end
}

export interface OverrideDraft {
  reason: string
  /** The last day it holds (YYYY-MM-DD, Rome). */
  day: string
}

/** The first day offered: tomorrow, or today when the requirement allows less than a day. */
export function defaultOverrideDay(now: Date, maxDays: number): string {
  const latest = latestUntil(now, maxDays)
  const tomorrow = romeDay(new Date(now.getTime() + DAY_MS))
  return romeDay(latest) < tomorrow ? romeDay(latest) : tomorrow
}

/** What is wrong with a draft (message keys by field), as the API would refuse it. */
export function overrideProblems(draft: OverrideDraft, now: Date, maxDays: number): { reason?: string; day?: string } {
  const problems: { reason?: string; day?: string } = {}
  const reason = draft.reason.trim()
  if (reason.length < OVERRIDE_REASON_MIN) problems.reason = 'override.problem.reasonShort'
  else if (reason.length > OVERRIDE_REASON_MAX) problems.reason = 'override.problem.reasonLong'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.day)) problems.day = 'override.problem.day'
  else if (draft.day < romeDay(now)) problems.day = 'override.problem.past'
  else if (draft.day > romeDay(latestUntil(now, maxDays))) problems.day = 'override.problem.tooLong'
  else if (untilOf(draft.day, now, maxDays).getTime() <= now.getTime()) problems.day = 'override.problem.past'
  return problems
}

/** Why the override's primary is held (a message key), or null. */
export function overrideSendHeld(draft: OverrideDraft, now: Date, maxDays: number, busy: boolean): string | null {
  if (busy) return 'override.held.busy'
  const problems = overrideProblems(draft, now, maxDays)
  return problems.reason ?? problems.day ?? null
}

/** The words of an API refusal of the override (our own words per kind; the feed re-read shows the state). */
export function overrideRefusalKey(kind: string): string {
  if (kind === 'forbidden') return 'override.refused.role'
  if (kind === 'conflict') return 'override.refused.conflict'
  if (kind === 'invalid') return 'override.refused.invalid'
  if (kind === 'not_found') return 'override.refused.gone'
  return 'override.refused.unavailable'
}

// ---- files and the print window -------------------------------------------------------------------------------------------------

/** The matrix as rows of a file: style, name, brand, then each market's state in words. */
export function boardCsvRows(rows: readonly BoardRow[], markets: readonly string[], words: (state: CellState, missing: number) => string): (string | number | null)[][] {
  return rows.map((row) => [row.style.code, row.style.name, row.style.brand ? `${row.style.brand.code} · ${row.style.brand.name}` : null, ...markets.map((code) => {
    const cell = row.cells.find((entry) => entry.marketCode === code)
    return cell ? `${words(cell.state, cell.missing)}${cell.first ? ` (${cell.first.code})` : ''}` : null
  })])
}

/** The refusals as rows of a file (no person on a refusal; an override's office person stays out of the file too). */
export const feedCsvRows = (events: readonly GateEvent[], words: { gate: (gate: Gate) => string; state: (state: FeedState) => string }): (string | number | null)[][] =>
  events.map((event) => [event.at, words.gate(event.gate), event.subject.number ?? event.subject.id, event.style?.code ?? null, event.colourway, event.size, event.marketCode, event.requirement.code, words.state(event.state), event.reason])

export const actionsCsvRows = (lines: readonly ActionLine[]): (string | number | null)[][] => lines.map((line) => [line.severity, line.styleCode, line.marketCode, line.requirementCode, line.who, line.words])

/** The print window's address (a new tab; the filters of the board go with it). */
export const printAddress = (prefix: string, address: StatusAddress): string => `${prefix}/compliance/status/print${statusAddressText({ ...address, gate: null, feed: 'all', days: 7 })}`

/** The file name of a part's export. */
export const csvName = (part: 'board' | 'refusals' | 'actions', day: string): string => `compliance-status-${part}-${day}.csv`

/** Every cell state in the order the legend reads. */
export const CELL_ORDER: readonly CellState[] = CELL_STATES
