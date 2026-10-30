import type { Tone } from '@nexus/ui/primitives'
import { decimalValue, phrase, type Phrase } from '../../_shared/stock/model'
import { PICK_VIEWS, type CreateResult, type HeldEntry, type KitStatus, type PickRow, type PickSheet, type PickTiles, type PickView, type ReadinessMaterial, type ReadinessWord, type SheetLine } from './api'

/**
 * Warehouse › Picking & kits (SCR-237) — the pure rules of the page, the pick list dialog, the readiness popover, Create
 * pick lists and the paper: what this person may do, the saved rows and the address, the tones, the reasons in OUR words
 * (from the words, dates and figures the API answers, never its English), the kit check and why "Mark kit complete" is
 * held, the walk through the store sorted by bin path (the PDF), and how each Create outcome is said. The words live in
 * `messages/<locale>/warehouse-picking.json`. No money is read; no person is named (a pick is said by its team).
 */

export const PICKING_NAMESPACES = ['warehouse-picking', 'stock', 'lists'] as const
export const TIME_ZONE = 'Europe/Rome'

// ---- abilities -------------------------------------------------------------------------------------------------------------

export interface PickingCan {
  /** The page itself (GET /inventory/picking/pick-lists). */
  view: boolean
  /** Create pick lists (POST …: the reservations module's inventory.reserve). */
  reserve: boolean
  /** The work order's page (Production › Work orders). */
  workOrders: boolean
  /** "Open PO" in the readiness popover (Purchasing › Orders). */
  purchasing: boolean
  /** "Buy" in the readiness popover (Planning › What to buy & make). */
  planning: boolean
}

export function pickingCan(permissions: readonly string[]): PickingCan {
  const held = new Set(permissions)
  return {
    view: held.has('inventory.stock.view'),
    reserve: held.has('inventory.reserve'),
    workOrders: held.has('workorders.view'),
    purchasing: held.has('purchasing.view'),
    planning: held.has('planning.view'),
  }
}

// ---- the address and the saved rows ------------------------------------------------------------------------------------------

export interface PickingAddress {
  view: PickView
  q: string
  siteId: string | null
  /** The pick list dialog (`?open=<work order id>`). */
  open: string | null
  /** The Create pick lists dialog (`?new=1`). */
  create: boolean
}

export const isPickView = (value: string | null | undefined): value is PickView => !!value && (PICK_VIEWS as readonly string[]).includes(value)

export function addressOf(params: { get(name: string): string | null }): PickingAddress {
  const view = params.get('view')
  return { view: isPickView(view) && view !== 'toCreate' ? view : 'all', q: params.get('q') ?? '', siteId: params.get('site') || null, open: params.get('open') || null, create: params.get('new') === '1' }
}

export function addressText(address: PickingAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'all') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.siteId) query.set('site', address.siteId)
  if (address.open) query.set('open', address.open)
  if (address.create) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The tiles (design pk-metrics): each a saved row; pressing one again clears it. Substitutes waiting (W2b) is not built. */
export const TILES: readonly { id: 'today' | 'waiting' | 'complete'; view: PickView; count: (tiles: PickTiles) => number }[] = [
  { id: 'today', view: 'today', count: (tiles) => tiles.today },
  { id: 'waiting', view: 'waiting', count: (tiles) => tiles.waiting },
  { id: 'complete', view: 'complete', count: (tiles) => tiles.complete },
]

// ---- tones and words -------------------------------------------------------------------------------------------------------

export const READINESS_TONE: Readonly<Record<ReadinessWord, Tone>> = {
  NOT_ENOUGH: 'danger',
  DELAYED: 'danger',
  REQUESTED: 'warning',
  EXPECTED: 'info',
  NOT_BOOKED: 'warning',
  RECEIVED: 'success',
  NOT_PLANNED: 'neutral',
}

export const KIT_TONE: Readonly<Record<KitStatus, Tone>> = { OPEN: 'neutral', PARTLY: 'info', COMPLETE: 'success' }

/** The readiness word of a row: "Expected 3 Nov" carries its date (formatted by the view). */
export const readinessKey = (word: ReadinessWord, date: string | null): Phrase => (word === 'EXPECTED' && date ? phrase('ready.word.EXPECTED_ON', { date }) : phrase(`ready.word.${word}`))

/** One material's reason in our words (the popover "Why 'Delayed'"): what is short, in stock, on order, and when. */
export function materialReason(material: ReadinessMaterial): Phrase {
  const po = material.purchaseOrders[0]?.number ?? ''
  const params = { material: material.label, short: material.short, inStock: material.inStock, onOrder: material.onOrder, reserved: material.reserved, issued: material.issued, date: material.date ?? '', po, uom: material.uom }
  if (material.word === 'DELAYED') return phrase(po ? 'ready.reason.DELAYED_PO' : 'ready.reason.DELAYED', params)
  if (material.word === 'EXPECTED') return phrase(po ? 'ready.reason.EXPECTED_PO' : 'ready.reason.EXPECTED', params)
  return phrase(`ready.reason.${material.word}`, params)
}

/** The materials the popover lists: every one that is not there yet, worst first (the API's order); else all of them. */
export function popoverMaterials(row: Pick<PickRow, 'readiness'>): ReadinessMaterial[] {
  const open = row.readiness.materials.filter((material) => material.word !== 'RECEIVED')
  return open.length > 0 ? open : [...row.readiness.materials]
}

/** Who picked, in words: the teams, else the office; nobody yet: null. Never a person (Owner W1). */
export function pickedByWords(row: Pick<PickRow, 'pickedBy'>): { teams: string[]; office: boolean } | null {
  if (row.pickedBy.length === 0) return null
  return { teams: row.pickedBy.flatMap((entry) => (entry.kind === 'TEAM' && entry.name ? [entry.name] : [])), office: row.pickedBy.some((entry) => entry.kind === 'OFFICE') }
}

/** A held entry in our words: a lot that is not released (its reason), or a quality hold of a lot or one hide (its reason and day). */
export function heldPhrase(entry: HeldEntry, locale: 'it' | 'en'): Phrase {
  if (entry.reason === 'QUALITY_HOLD' && entry.hold) {
    const reason = locale === 'it' ? entry.hold.reasonIt : entry.hold.reasonEn
    return entry.hold.subjectType === 'Hide' && entry.hideCode
      ? phrase('held.holdHide', { hide: entry.hideCode, lot: entry.lotCode, reason, since: entry.hold.placedAt })
      : phrase('held.holdLot', { lot: entry.lotCode, reason, since: entry.hold.placedAt })
  }
  return phrase(`held.${entry.reason}`, { lot: entry.lotCode })
}

// ---- the pick list dialog ----------------------------------------------------------------------------------------------------

/** One place of a line on the paper and in the dialog: a reserved or proposed pick with where it lies. */
export interface PickStop {
  readonly locationCode: string
  readonly lotCode: string | null
  readonly hideCode: string | null
  readonly quantity: string
  /** Reserved for the work order (its pick list), or only proposed (no pick list yet). */
  readonly reserved: boolean
}

/** Where a line's material is picked from: its open reservations (with their places), else what a pick list would propose. */
export function stopsOf(line: SheetLine): PickStop[] {
  const open = line.pick.reservations.filter((row) => row.status === 'ACTIVE')
  const reserved: PickStop[] = open.map((row) => ({
    locationCode: row.locations.map((place) => place.locationCode).sort()[0] ?? '',
    lotCode: row.lotCode,
    hideCode: row.hideCode,
    quantity: (Math.max(0, (decimalValue(row.quantity) ?? 0) - (decimalValue(row.issued) ?? 0))).toFixed(4),
    reserved: true,
  }))
  const proposed: PickStop[] = line.pick.proposed.map((pick) => ({ locationCode: pick.locations.map((place) => place.locationCode).sort()[0] ?? '', lotCode: pick.lotCode, hideCode: pick.hideCode, quantity: pick.quantity, reserved: false }))
  return [...reserved, ...proposed].sort((a, b) => compareCodes(a.locationCode, b.locationCode) || compareCodes(a.hideCode ?? a.lotCode ?? '', b.hideCode ?? b.lotCode ?? ''))
}

const compareCodes = (a: string, b: string): number => (a === b ? 0 : a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1)

/** The first place of a line (its bin path): the dialog and the paper sort the lines by it. */
export const firstPlaceOf = (line: SheetLine): string => stopsOf(line)[0]?.locationCode ?? ''

/** The lines in the order the picker walks: by their first place (bin path), then material. */
export function walkOrder(lines: readonly SheetLine[]): SheetLine[] {
  return [...lines].sort((a, b) => compareCodes(firstPlaceOf(a), firstPlaceOf(b)) || compareCodes(a.itemCode, b.itemCode) || compareCodes(a.colourCode ?? '', b.colourCode ?? ''))
}

/** The kit complete check (pk-list): every line picked in full; the short lines named. */
export function kitCheck(sheet: Pick<PickSheet, 'lines'>): { complete: boolean; short: SheetLine[] } {
  const short = sheet.lines.filter((line) => !line.covered)
  return { complete: sheet.lines.length > 0 && short.length === 0, short }
}

/**
 * "Mark kit complete" is held (Owner rule: held buttons say why): while lines are short, by how many; once every line is
 * picked the kit already reads Complete — marking it by hand needs a kit record of its own (no schema in W2a: a named gap).
 */
export function markCompleteHeld(sheet: Pick<PickSheet, 'lines'>): Phrase {
  const check = kitCheck(sheet)
  return check.complete ? phrase('kit.markRecordLater') : phrase('kit.markShort', { count: check.short.length })
}

// ---- the paper: one walk through the store for many work orders (rule 1) -------------------------------------------------------

export interface WalkStop {
  readonly locationCode: string
  readonly picks: readonly { readonly workOrder: string; readonly itemCode: string; readonly colourCode: string | null; readonly lotCode: string | null; readonly hideCode: string | null; readonly quantity: string; readonly uom: string; readonly reserved: boolean }[]
}

/** Every work order's picks merged by place, in bin path order: the picker walks the store once for all of them. */
export function walkOf(sheets: readonly PickSheet[]): WalkStop[] {
  const stops = new Map<string, WalkStop['picks'][number][]>()
  for (const sheet of sheets) {
    for (const line of sheet.lines) {
      if (line.covered) continue
      for (const stop of stopsOf(line)) {
        const picks = stops.get(stop.locationCode) ?? []
        picks.push({ workOrder: sheet.workOrder.number, itemCode: line.itemCode, colourCode: line.colourCode, lotCode: stop.lotCode, hideCode: stop.hideCode, quantity: stop.quantity, uom: line.baseUom, reserved: stop.reserved })
        stops.set(stop.locationCode, picks)
      }
    }
  }
  return [...stops.entries()].sort(([a], [b]) => compareCodes(a, b)).map(([locationCode, picks]) => ({ locationCode, picks }))
}

export const printHref = (prefix: string, ids: readonly string[]): string => `${prefix}/warehouse/picking/print?ids=${ids.map(encodeURIComponent).join(',')}`

// ---- Create pick lists ---------------------------------------------------------------------------------------------------------

/** The rows the Create dialog offers: released or in progress, no pick list yet, kit not complete; by cut date (the API's order). */
export const createChoices = (rows: readonly PickRow[]): PickRow[] =>
  rows.filter((row) => !row.pickList.created && row.kit.status !== 'COMPLETE' && (row.workOrder.status === 'RELEASED' || row.workOrder.status === 'IN_PROGRESS'))

/** A row that may not be ticked in the Create dialog: why (null: it may). */
export function createHeld(row: PickRow): Phrase | null {
  if (row.workOrder.status === 'ON_HOLD') return phrase('create.heldOnHold')
  if (row.pickList.created) return phrase('create.heldHasList')
  if (row.kit.status === 'COMPLETE') return phrase('create.heldComplete')
  return null
}

const REFUSAL_CODES = ['ON_HOLD', 'NOT_RELEASED', 'NOT_FOUND', 'NOT_AVAILABLE', 'LOT_NOT_AVAILABLE', 'HIDE_RESERVED', 'HIDE_NOT_IN_STOCK', 'LOT_HELD'] as const

/** One Create outcome in our words. */
export function resultPhrase(result: CreateResult): Phrase {
  const number = result.number ?? '—'
  if (result.outcome === 'CREATED') return phrase(result.short.length > 0 ? 'create.result.createdShort' : 'create.result.created', { number, count: result.reserved.length, short: result.short.length })
  if (result.outcome === 'NOTHING_TO_RESERVE') return phrase(result.short.length > 0 ? 'create.result.nothingShort' : 'create.result.nothing', { number, short: result.short.length })
  const code = result.refusal?.code ?? ''
  return phrase(`create.refusal.${(REFUSAL_CODES as readonly string[]).includes(code) ? code : 'OTHER'}`, { number })
}

// ---- live --------------------------------------------------------------------------------------------------------------------

const LIVE_PREFIXES = ['inventory.issued', 'inventory.returned', 'inventory.pick_reversed', 'inventory.reserved', 'inventory.reservations_released', 'quality.hold_', 'purchasing.', 'planning.', 'workorder.']

/** An event that can change a row: an issue (picked counts), a reservation, a hold, a purchase order's dates, the plan. */
export const isPickingEvent = (type: string): boolean => LIVE_PREFIXES.some((prefix) => type.startsWith(prefix))
