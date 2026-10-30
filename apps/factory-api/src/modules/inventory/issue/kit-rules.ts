import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { quantityText, type ItemTracking } from '@nexus/factory-domain/inventory/ledger/moves'

/**
 * Picking & kits (B-W2a-58; design warehouse.picking, SCR-237; PLN-086), pure: what a pick list proposes for one material
 * and colour of a work order, the kit's state from what was issued, and the page's saved rows. No money, no person.
 *
 * A pick list is the work order's reservations (the wave-4 schema's note: "pick lists read Reservation, issued vs
 * quantity"): "Create pick lists" reserves for each work order what it still needs, from the usable stock of its site,
 * oldest first (the pick list's own order: lot receipt, lot code, hide tag, place), never stock another demand holds,
 * never held stock (a lot that is not released, a lot or hide under a quality hold: the pick list's candidates already
 * leave them out). Leather goes hide by hide, whole (it is issued whole); a lot-tracked material by quantity per lot; an
 * untracked one by quantity from any lot. What the stock cannot cover is the line's `short`.
 *
 * A kit is OPEN while nothing is issued, PARTLY while some line still needs material, COMPLETE when every line is issued
 * in full (the floor's scans and the office's issues post the ISSUE moves; returns count back).
 */

export const KIT_STATUSES = ['OPEN', 'PARTLY', 'COMPLETE'] as const
export type KitStatus = (typeof KIT_STATUSES)[number]

/** The page's saved rows (the tiles press them): every row, to pick today, waiting for material, kits complete, no pick list yet. */
export const PICK_VIEWS = ['all', 'today', 'waiting', 'complete', 'toCreate'] as const
export type PickView = (typeof PICK_VIEWS)[number]

/** The readiness words (planning readiness) that mean the material is not there yet. */
export const WAITING_WORDS: readonly string[] = ['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'EXPECTED']

/** At most this many work orders in one "Create pick lists" or one pick list sheet. */
export const MAX_PICK_LISTS = 50
export const MAX_SHEETS = 20

const dec = (value: { toString(): string } | string): Decimal => new Dec(value.toString())
const positive = (value: Decimal): Decimal => (value.gt(0) ? value : ZERO)

/** A usable place of the stock, as the pick list offers it (oldest first). */
export interface PickSource {
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly locationId: string
  readonly locationCode: string
  readonly onHand: string
}

/** An ACTIVE reservation of the material and colour (its open part: quantity − issued). */
export interface OpenReservation {
  readonly id: string
  readonly lotId: string | null
  readonly hideId: string | null
  readonly open: string
}

export interface ProposeInput {
  readonly tracking: ItemTracking
  /** What the work order still needs to be issued (planned − issued), base unit. */
  readonly toIssue: string
  /** The usable sources, oldest first (no held stock among them). */
  readonly sources: readonly PickSource[]
  /** The work order's own ACTIVE reservations of this material (its pick list so far). */
  readonly mine: readonly OpenReservation[]
  /** Every other demand's ACTIVE reservations of this material at the site (open demands only). */
  readonly others: readonly OpenReservation[]
}

/** One proposed pick: a whole hide, a quantity of a lot, or a quantity from any lot; where it lies. */
export interface ProposedPick {
  readonly kind: 'HIDE' | 'LOT' | 'ANY'
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly quantity: string
  /** Its places, by place code (the bin path the picker walks). */
  readonly locations: { readonly locationId: string; readonly locationCode: string; readonly onHand: string }[]
}

export interface Proposal {
  /** Already reserved for the work order (open). */
  readonly reserved: string
  /** What a new pick list would reserve now. */
  readonly picks: ProposedPick[]
  /** What neither the reservations nor the usable stock cover. */
  readonly short: string
}

const byCode = (a: { locationCode: string }, b: { locationCode: string }) => (a.locationCode < b.locationCode ? -1 : a.locationCode > b.locationCode ? 1 : 0)

/** What a pick list reserves for one material and colour (rules in the header), counted as reserveRefusals counts. */
export function proposePicks(input: ProposeInput): Proposal {
  const reserved = input.mine.reduce((sum, row) => sum.plus(dec(row.open)), ZERO)
  let need = positive(dec(input.toIssue).minus(reserved))
  const all = [...input.mine, ...input.others]
  const takenHides = new Set(all.flatMap((row) => (row.hideId ? [row.hideId] : [])))
  const onHandOf = (rows: readonly PickSource[]) => rows.reduce((sum, row) => sum.plus(dec(row.onHand)), ZERO)
  // What is free of the whole key, and of each lot (every ACTIVE reservation holds its open part).
  let keyFree = onHandOf(input.sources).minus(all.reduce((sum, row) => sum.plus(dec(row.open)), ZERO))
  const lotFree = new Map<string, Decimal>()
  for (const source of input.sources) if (source.lotId) lotFree.set(source.lotId, (lotFree.get(source.lotId) ?? ZERO).plus(dec(source.onHand)))
  for (const row of all) if (row.lotId && lotFree.has(row.lotId)) lotFree.set(row.lotId, lotFree.get(row.lotId)!.minus(dec(row.open)))
  const picks: ProposedPick[] = []
  if (need.gt(0) && input.tracking === 'HIDE') {
    const hides = new Map<string, PickSource[]>()
    for (const source of input.sources) if (source.hideId && !takenHides.has(source.hideId)) hides.set(source.hideId, [...(hides.get(source.hideId) ?? []), source])
    for (const [hideId, places] of hides) {
      if (!need.gt(0)) break
      const first = places[0]!
      const quantity = onHandOf(places)
      const lotLeft = first.lotId ? (lotFree.get(first.lotId) ?? ZERO) : keyFree
      if (!quantity.gt(0) || quantity.gt(lotLeft) || quantity.gt(keyFree)) continue
      picks.push({ kind: 'HIDE', lotId: first.lotId, lotCode: first.lotCode, hideId, hideCode: first.hideCode, quantity: quantityText(quantity), locations: places.map(placeOf).sort(byCode) })
      need = need.minus(quantity)
      keyFree = keyFree.minus(quantity)
      if (first.lotId) lotFree.set(first.lotId, lotLeft.minus(quantity))
    }
  } else if (need.gt(0) && input.tracking === 'LOT') {
    const lots = new Map<string, PickSource[]>()
    for (const source of input.sources) if (source.lotId) lots.set(source.lotId, [...(lots.get(source.lotId) ?? []), source])
    for (const [lotId, places] of lots) {
      if (!need.gt(0)) break
      const take = Dec.min(need, positive(lotFree.get(lotId) ?? ZERO), positive(keyFree))
      if (!take.gt(0)) continue
      picks.push({ kind: 'LOT', lotId, lotCode: places[0]!.lotCode, hideId: null, hideCode: null, quantity: quantityText(take), locations: places.map(placeOf).sort(byCode) })
      need = need.minus(take)
      keyFree = keyFree.minus(take)
      lotFree.set(lotId, (lotFree.get(lotId) ?? ZERO).minus(take))
    }
  } else if (need.gt(0)) {
    const take = Dec.min(need, positive(keyFree))
    if (take.gt(0)) {
      picks.push({ kind: 'ANY', lotId: null, lotCode: null, hideId: null, hideCode: null, quantity: quantityText(take), locations: input.sources.map(placeOf).sort(byCode) })
      need = need.minus(take)
    }
  }
  return { reserved: quantityText(reserved), picks, short: quantityText(positive(need)) }
}

const placeOf = (source: PickSource) => ({ locationId: source.locationId, locationCode: source.locationCode, onHand: source.onHand })

/** One material and colour of a work order: planned and issued (net of returns), base unit. */
export interface KitLine {
  readonly planned: string
  readonly issued: string
}

/** The kit's state and "6 of 9": lines issued in full of all lines. */
export function kitOf(lines: readonly KitLine[]): { readonly status: KitStatus; readonly all: number; readonly picked: number; readonly short: number } {
  const all = lines.length
  const picked = lines.filter((line) => dec(line.issued).gte(dec(line.planned))).length
  const started = lines.some((line) => dec(line.issued).gt(0))
  const status: KitStatus = all > 0 && picked === all ? 'COMPLETE' : started ? 'PARTLY' : 'OPEN'
  return { status, all, picked, short: all - picked }
}

/** The facts a saved row reads of a pick list row. */
export interface ViewFacts {
  readonly kit: KitStatus
  readonly word: string
  readonly cutDate: string | null
  readonly created: boolean
  readonly status: string
}

/** Is the row in the saved row (`today` is the site's business date)? */
export function inView(view: PickView, row: ViewFacts, today: string): boolean {
  switch (view) {
    case 'today':
      return row.kit !== 'COMPLETE' && row.status !== 'ON_HOLD' && row.cutDate !== null && row.cutDate <= today
    case 'waiting':
      return row.kit !== 'COMPLETE' && WAITING_WORDS.includes(row.word)
    case 'complete':
      return row.kit === 'COMPLETE'
    case 'toCreate':
      return !row.created && row.kit !== 'COMPLETE' && (row.status === 'RELEASED' || row.status === 'IN_PROGRESS')
    default:
      return true
  }
}

/** The order of the rows: by cut date (none last), then priority (higher first), due date, number. */
export function byCutDate<Row extends { readonly cutDate: string | null; readonly workOrder: { readonly priority: number; readonly dueDate: string | null; readonly number: string } }>(a: Row, b: Row): number {
  if (a.cutDate !== b.cutDate) {
    if (a.cutDate === null) return 1
    if (b.cutDate === null) return -1
    return a.cutDate < b.cutDate ? -1 : 1
  }
  if (a.workOrder.priority !== b.workOrder.priority) return b.workOrder.priority - a.workOrder.priority
  const due = (a.workOrder.dueDate ?? '9999') < (b.workOrder.dueDate ?? '9999') ? -1 : (a.workOrder.dueDate ?? '9999') > (b.workOrder.dueDate ?? '9999') ? 1 : 0
  return due || (a.workOrder.number < b.workOrder.number ? -1 : a.workOrder.number > b.workOrder.number ? 1 : 0)
}
