import type { Tone } from '@nexus/ui/primitives'
// F-PR-02: the production pages' one customer filter.
import { PARTY_KEY, partyTerm } from '../_shared/customer/model'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CutEntry, CutLog } from '../_shared/api'
import { CUT_VIEWS, type CutRow, type CutState, type CutTiles, type CutView, type Replacement, type YieldFigures, type YieldHide } from './api'
// B-W2b-F51: a refusal names the missing right in words, never its code.
import { rightRef } from '../../../lib/i18n/rights'

/**
 * Production › Cutting room › Cutting (SCR-238; design production.cutting): the rules without a screen. What a person may
 * do (from the session's permissions; the API checks every call again), the page's address (`?view=` the saved filters,
 * `?q=`, `?new=1` New cut order, `?alloc=<work order>` Allocate hides), the tiles, the words of a cut's state, its area
 * per unit (never added across units), a work order's pieces by part and size with the recuts and the yield per lot and
 * supplier (F-PR-06: drawn on the work order's Cutting & bundles tab, where the Cut record merged), and a refused write in
 * words. Here a cut is one work order's leather, cut by hide at the cutting table; cut orders of several work orders (fabric lays, markers, a leather
 * group, MES-034/037) are B-W2b-129's `orders/` beside it on the same page. Words are message keys
 * of the `cutting` catalogue with their parameters; the views translate them. Never who cut: per work order, table, hide
 * and lot only (Statuto dei Lavoratori art. 4; SCM-255).
 */

export const CUTTING_NAMESPACE = 'cutting'

const ROME = 'Europe/Rome'

/** The instant the day of `now` began in Rome (the tiles' "today", as the API counts it). */
export function romeDayStart(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: ROME, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  for (const hour of [-2, -1, 0, 1]) {
    const candidate = new Date(`${day}T00:00:00Z`)
    candidate.setUTCHours(hour)
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(candidate)
    const of = (type: string) => parts.find((part) => part.type === type)?.value
    if (`${of('year')}-${of('month')}-${of('day')}` === day && of('hour') === '00') return candidate
  }
  return new Date(`${day}T00:00:00Z`)
}

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
export const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface CuttingCan {
  /** production.cutting.view: the page, its tiles and the room's yield. */
  readonly view: boolean
  /** workorders.view: a cut's record (its cut log, yield and tickets are the work order's reads). */
  readonly workOrders: boolean
  /** inventory.reserve: Allocate hides (each hide reserved whole for the work order). */
  readonly reserve: boolean
  /** inventory.stock.view: the hides allocated, and the Find hides dialog's stock. */
  readonly stock: boolean
  /** production.scrap.view: the recuts on the Pieces tab. */
  readonly scrap: boolean
  /** production.scrap: a recut marked cut by its cut log entry. */
  readonly recut: boolean
  /** production.bundles: reprint and void a ticket. */
  readonly bundles: boolean
  /** B-W2b-129: purchasing.claims.manage: a supplier lot raised with its supplier from the yield (a supplier claim). */
  readonly claims: boolean
}

export function cuttingCanOf(permissions: readonly string[]): CuttingCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.cutting.view'),
    workOrders: held.has('workorders.view'),
    reserve: held.has('inventory.reserve'),
    stock: held.has('inventory.stock.view'),
    scrap: held.has('production.scrap.view'),
    recut: held.has('production.scrap'),
    bundles: held.has('production.bundles'),
    claims: held.has('purchasing.claims.manage'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CutAddress {
  readonly view: CutView
  readonly q: string
  /** New cut order is open. */
  readonly newCut: boolean
  /** Allocate hides is open for this work order. */
  readonly alloc: string | null
  /** F-PR-02: the customer filter (`?party=`, the production pages' one filter); absent or null: every customer. */
  readonly party?: string | null
}

export function addressOf(params: { get(name: string): string | null } | null): CutAddress {
  const view = params?.get('view') ?? ''
  const alloc = params?.get('alloc') ?? ''
  return {
    view: (CUT_VIEWS as readonly string[]).includes(view) ? (view as CutView) : 'open',
    q: (params?.get('q') ?? '').trim().slice(0, 60),
    newCut: params?.get('new') === '1',
    alloc: UUID.test(alloc) ? alloc : null,
    ...partyTerm(params),
  }
}

export function addressText(address: CutAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.newCut) query.set('new', '1')
  if (address.alloc) query.set('alloc', address.alloc)
  if (address.party) query.set(PARTY_KEY, address.party)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- tiles ---------------------------------------------------------------------------------------------------------------------

export interface TileRule {
  readonly id: 'waiting' | 'cutting' | 'piecesToday' | 'areaToday' | 'yieldToday'
  /** The saved filter the tile sets; null: a figure of today, no filter. */
  readonly view: CutView | null
}
export const TILES: readonly TileRule[] = [
  { id: 'waiting', view: 'waiting' },
  { id: 'cutting', view: 'cutting' },
  { id: 'piecesToday', view: null },
  { id: 'areaToday', view: null },
  { id: 'yieldToday', view: null },
]

/**
 * The tile's figure in words ("—" while unknown). B-W2b-129: Waiting to cut and Cutting now add the fabric cut orders
 * (`fabric`: planned + released wait, in progress cuts; a leather cut order's work orders are counted by their cuts).
 */
export function tileValue(id: TileRule['id'], tiles: CutTiles | null, yieldToday: YieldFigures | null, locale: string, fabric: { readonly waiting: number; readonly cutting: number } | null = null): string {
  if (!tiles) return '—'
  if (id === 'waiting') return String(tiles.waiting + (fabric?.waiting ?? 0))
  if (id === 'cutting') return String(tiles.cutting + (fabric?.cutting ?? 0))
  if (id === 'piecesToday') return String(tiles.piecesToday)
  if (id === 'areaToday') return `${tiles.hidesToday} · ${areaNumber(tiles.areaTodayM2, locale)} m²`
  if (!yieldToday || yieldToday.yieldPct === null) return '—'
  return yieldToday.plannedPct === null ? percent(yieldToday.yieldPct, locale) : `${percent(yieldToday.yieldPct, locale)} / ${percent(yieldToday.plannedPct, locale)}`
}

// ---- numbers -------------------------------------------------------------------------------------------------------------------

/** An area with at most two decimals ("48,16"); "—" for nothing. */
export function areaNumber(value: string | null, locale: string): string {
  if (value === null) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: number % 1 === 0 ? 0 : 2 }).format(number)
}

export function percent(value: string | null, locale: string): string {
  if (value === null) return '—'
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Number(value))} %`
}

const UNIT_WORDS: Readonly<Record<string, string>> = { FT2: 'ft²', M2: 'm²', DM2: 'dm²' }
export const unitWord = (uom: string): string => UNIT_WORDS[uom] ?? uom

/** The area used per unit, joined ("48,16 ft² · 2,1 m²"): areas of different units are never added. */
export function usedText(used: CutRow['hides']['used'], locale: string): string {
  return used.length === 0 ? '—' : used.map((part) => `${areaNumber(part.area, locale)} ${unitWord(part.uom)}`).join(' · ')
}

/** Yield against the plan: the tone of the variance (behind the plan by more than 2 points: warning; ahead: success). */
export function varianceTone(variancePct: string | null): Tone {
  if (variancePct === null) return 'neutral'
  const value = Number(variancePct)
  if (value < -2) return 'warning'
  if (value > 0) return 'success'
  return 'neutral'
}

// ---- a cut's state ---------------------------------------------------------------------------------------------------------------

export const STATE_TONE: Readonly<Record<CutState, Tone>> = { WAITING: 'neutral', CUTTING: 'info', CUT: 'success', HELD: 'warning' }

/** The material and colour of a cut, as one line ("SEED-LEA-100 · BLK"). */
export function materialLine(row: Pick<CutRow, 'materials'>): string {
  return row.materials.map((material) => [material.code, material.colourCode].filter(Boolean).join(' · ')).join(', ') || '—'
}

/** The shade lots (lot code and dye batch). */
export function lotLine(row: Pick<CutRow, 'lots'>): string {
  return row.lots.map((lot) => (lot.dyeBatch ? `${lot.code} (${lot.dyeBatch})` : lot.code)).join(', ') || '—'
}

/**
 * F-PR-06: a leather cut opens its work order's Cutting & bundles tab (the Cut record merged there; its old address redirects).
 */
export const cutHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}?tab=cutting`

// ---- Allocate hides ---------------------------------------------------------------------------------------------------------------

/** Why Allocate hides is held for a cut (else null). */
export function allocateHeld(row: Pick<CutRow, 'state' | 'workOrder'> | null, can: CuttingCan): Phrase | null {
  if (!can.reserve) return phrase('held.permission', { right: rightRef('inventory.reserve') })
  if (!can.stock) return phrase('held.permission', { right: rightRef('inventory.stock.view') })
  if (!row) return phrase('held.loading')
  if (row.state === 'CUT') return phrase('alloc.held.cut')
  if (row.workOrder.status === 'COMPLETED') return phrase('alloc.held.cut')
  return null
}

/** Why Print tickets is held (else null): it opens one cut's tickets. */
export function ticketsHeld(selected: number, can: CuttingCan): Phrase | null {
  if (!can.workOrders) return phrase('held.permission', { right: rightRef('workorders.view') })
  if (selected !== 1) return phrase('held.tickets.one')
  return null
}

// ---- a work order's parts (F-PR-06: the Cut record merged into the work order's Cutting & bundles tab) ------------------------

/** One part of a work order read on its own: its value, or the problem in words (a message key), or neither while loading. */
export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const loading = <T>(): Part<T> => ({ value: null, problem: null })

/** A read's problem as a message key: no right, gone, no answer, else a failed read. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

const REFUSALS: Readonly<Record<string, string>> = {
  NOT_A_RECUT: 'problem.recut.notRecut',
  CUT_NOT_OF_CELL: 'problem.recut.notOfCell',
  WRONG_STATE: 'problem.recut.state',
  // The reservation's rules (B-W2a-11, a line's `body/lines/<i>/refusal/<CODE>`): Allocate hides.
  HIDE_RESERVED: 'problem.alloc.reserved',
  HIDE_NOT_IN_STOCK: 'problem.alloc.notInStock',
  LOT_HELD: 'problem.alloc.lotHeld',
  NOT_AVAILABLE: 'problem.alloc.hide',
  LOT_NOT_AVAILABLE: 'problem.alloc.hide',
}

/** A refused write in this app's words: the rule the API named (`refusal/<CODE>`, also a line's), else by its kind. */
export function writeProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const code = /(?:^|\/)refusal\/([A-Z_]+)$/.exec(path)?.[1] ?? null
    if (code && REFUSALS[code]) return phrase(REFUSALS[code]!)
    if (/(?:^|\/|\.)lines[./]\d+[./]hideId$/.test(path)) return phrase('problem.alloc.hide')
  }
  if (error.kind === 'conflict') return phrase('problem.changed')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return phrase('problem.forbidden')
  if (error.kind === 'not_found') return phrase('problem.gone')
  if (error.kind === 'invalid') return phrase('problem.invalid')
  if (error.kind === 'unavailable') return phrase('problem.offline')
  return phrase('problem.write')
}

// ---- Pieces: by part and size ---------------------------------------------------------------------------------------------------

export interface PieceCell {
  readonly cellId: string
  readonly planned: number
  readonly cut: number
  /** Pieces still to cut against the plan (never below 0). */
  readonly short: number
  /** Recuts asked and not cut yet, in pieces of this part (whole-garment recuts count one piece of every part). */
  readonly recut: number
}

export interface PieceRow {
  readonly part: string
  /** A part the BOM names (else a part logged by another name, a recut's). */
  readonly planned: boolean
  readonly cells: readonly PieceCell[]
}

/** The matrix part × size: planned (the cell's garments), cut, recut open, short; the BOM's parts first. */
export function piecesMatrix(log: Pick<CutLog, 'cells'>, recuts: readonly Replacement[]): PieceRow[] {
  const parts: { part: string; planned: boolean }[] = []
  for (const cell of log.cells) for (const part of cell.parts) if (!parts.some((row) => row.part === part.part)) parts.push({ part: part.part, planned: part.planned })
  parts.sort((a, b) => (a.planned === b.planned ? 0 : a.planned ? -1 : 1))
  const open = recuts.filter((recut) => recut.status === 'OPEN')
  return parts.map(({ part, planned }) => ({
    part,
    planned,
    cells: log.cells.map((cell) => {
      const found = cell.parts.find((row) => row.part === part)
      const plannedPieces = found?.planned ? cell.quantity : 0
      const cut = found?.pieces ?? 0
      const recut = open.filter((row) => row.cell.id === cell.id && (row.part === null || row.part === part)).reduce((sum, row) => sum + row.quantity, 0)
      return { cellId: cell.id, planned: plannedPieces, cut, short: Math.max(0, plannedPieces - cut), recut }
    }),
  }))
}

/** The live entries a recut may be marked cut by: entries of its cell with pieces of its part (any part for whole garments). */
export function recutEntries(log: CutLog, recut: Replacement): CutEntry[] {
  return log.entries.filter((entry) => entry.live && !entry.reversalOfId && entry.pieces.some((piece) => piece.workOrderSizeId === recut.cell.id && (recut.part === null || piece.part === recut.part)))
}

/** Why "Mark cut" is held for a recut (else null). */
export function recutHeld(recut: Replacement, log: CutLog | null, can: CuttingCan, busy: boolean): Phrase | null {
  if (!can.recut) return phrase('held.permission', { right: rightRef('production.scrap') })
  if (recut.status !== 'OPEN') return phrase('held.recut.done')
  if (busy) return phrase('held.busy')
  if (!log) return phrase('held.loading')
  if (recutEntries(log, recut).length === 0) return phrase('held.recut.noEntry', { cell: `${recut.cell.colourwayCode} ${recut.cell.size}`, part: recut.part ?? '' })
  return null
}

// ---- Yield: per lot and supplier ------------------------------------------------------------------------------------------------

export interface LotYield {
  readonly lotId: string
  readonly lotCode: string
  readonly supplierLotRef: string | null
  readonly supplier: string | null
  readonly hides: number
  readonly uom: string
  readonly used: number
  readonly pattern: number
  readonly waste: number
  /** pattern / (used − unmatched) of the sums, two places; null when nothing counts. */
  readonly yieldPct: string | null
}

/** What a yield row brings to its lot (the work order's yield read, `GET /production/yield/work-orders/:id`). */
export type LotHide = Pick<YieldHide, 'lot' | 'supplier' | 'item' | 'used' | 'unmatched' | 'pattern' | 'waste'>

/** The work order's hides summed per lot: the areas added first, the percentage of the sums (never an average of percentages). */
export function lotYields(hides: readonly LotHide[]): LotYield[] {
  const groups = new Map<string, LotHide[]>()
  for (const hide of hides) groups.set(hide.lot.id, [...(groups.get(hide.lot.id) ?? []), hide])
  return [...groups.values()].map((rows) => {
    const first = rows[0]!
    const sum = (pick: (row: LotHide) => string) => rows.reduce((total, row) => total + Number(pick(row)), 0)
    const counted = sum((row) => row.used) - sum((row) => row.unmatched)
    const pattern = sum((row) => row.pattern)
    return {
      lotId: first.lot.id,
      lotCode: first.lot.code,
      supplierLotRef: first.lot.supplierLotRef,
      supplier: first.supplier?.name ?? null,
      hides: rows.length,
      uom: first.item.uom,
      used: sum((row) => row.used),
      pattern,
      waste: sum((row) => row.waste),
      yieldPct: counted > 0 ? ((pattern * 100) / counted).toFixed(2) : null,
    }
  })
}
