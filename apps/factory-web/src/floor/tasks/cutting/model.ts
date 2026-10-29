import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'

/**
 * SCR-094 Hide check & cut log (design floor.hidecut; MES-051, MES-056, MES-058, SCM-194, SCM-253), the rules without a
 * screen: the other area unit shown beside the hide's (sq ft beside dm², dm² beside sq ft and m²), the tablet's draft
 * of garment sets per size until Hide done (one tap per set, Undo last set), the size buttons' state (what is left per
 * size, less the draft and the cuts saved on this tablet and not yet recorded), the remnant against what is left, the
 * area used (= left − remnant, shown, not typed) and the shade information (dye batches of the work order's hides).
 * Areas are decimal strings (decimal.js), never floats; a float appears only on the pad (the DS QuantityPad's number).
 * The API decides every rule again (factory-domain production/cutting/rules); this only says it first.
 */

export const AREA_UOMS = ['M2', 'DM2', 'FT2'] as const
export type AreaUom = (typeof AREA_UOMS)[number]

/** Square metres per unit (factory-domain product/units: M2 1, DM2 0.01, FT2 0.09290304). */
const M2_PER: Readonly<Record<AreaUom, string>> = { M2: '1', DM2: '0.01', FT2: '0.09290304' }

export const isAreaUom = (value: string): value is AreaUom => (AREA_UOMS as readonly string[]).includes(value)

/** The unit shown beside the hide's own (design: "Area in sq ft and dm² (both)"). */
export function otherUnitOf(uom: AreaUom): AreaUom {
  return uom === 'FT2' ? 'DM2' : 'FT2'
}

/** An area in another unit, with `places` decimals (half up); null for a value that is not a number. */
export function convertArea(value: string, from: AreaUom, to: AreaUom, places = 2): string | null {
  try {
    const amount = new Dec(value)
    if (!amount.isFinite()) return null
    return amount.times(M2_PER[from]).div(M2_PER[to]).toDecimalPlaces(places, Dec.ROUND_HALF_UP).toFixed(places)
  } catch {
    return null
  }
}

/** The text a decimal string shows with (trailing zeros of the API's four places dropped, at most `places`). */
export function areaPlain(value: string, places = 2): string {
  try {
    return new Dec(value).toDecimalPlaces(places, Dec.ROUND_HALF_UP).toString()
  } catch {
    return value
  }
}

// ---- the draft of sets (one tap per garment set; a draft on this tablet until Hide done) ----------------------------

/** The draft is the sets in the order they were tapped (cell ids): Undo last set takes the last one off. */
export type Draft = readonly string[]

export const addSet = (draft: Draft, cellId: string): Draft => [...draft, cellId]
export const undoSet = (draft: Draft): Draft => draft.slice(0, -1)

export function setsOf(draft: Draft): Map<string, number> {
  const counts = new Map<string, number>()
  for (const cellId of draft) counts.set(cellId, (counts.get(cellId) ?? 0) + 1)
  return counts
}

export interface CutCell {
  readonly id: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
  /** Garments still to cut in the hide's leather (the server's count). */
  readonly toCut: number
}

/** "52", or "NERO 52" when the work order cuts this leather for more than one colourway. */
export function cellLabelOf(cell: Pick<CutCell, 'colourwayCode' | 'size'>, cells: readonly Pick<CutCell, 'colourwayCode'>[]): string {
  const colours = new Set(cells.map((entry) => entry.colourwayCode))
  return colours.size > 1 ? `${cell.colourwayCode} ${cell.size}` : cell.size
}

/** The draft's lines in the cells' order: "52 × 2 · 54 × 1", and the cut's body lines. */
export function draftLines(draft: Draft, cells: readonly CutCell[]): { cellId: string; label: string; sets: number }[] {
  const counts = setsOf(draft)
  return cells.filter((cell) => (counts.get(cell.id) ?? 0) > 0).map((cell) => ({ cellId: cell.id, label: cellLabelOf(cell, cells), sets: counts.get(cell.id)! }))
}

export function cutLines(draft: Draft, cells: readonly CutCell[]): { workOrderSizeId: string; sets: number }[] {
  return draftLines(draft, cells).map((line) => ({ workOrderSizeId: line.cellId, sets: line.sets }))
}

export interface SizeState {
  readonly id: string
  readonly label: string
  /** Garments left to cut in this size: the server's, less the cuts saved here and not yet recorded, less the draft. */
  readonly remaining: number
  /** Nothing left: the size is held ("Size 52 is all cut."). */
  readonly allCut: boolean
}

/** The size buttons of the work order for this hide. `pending`: sets per cell saved on this tablet, not yet recorded. */
export function sizeStates(cells: readonly CutCell[], draft: Draft, pending: ReadonlyMap<string, number> = new Map()): SizeState[] {
  const counts = setsOf(draft)
  return cells.map((cell) => {
    const remaining = Math.max(0, cell.toCut - (pending.get(cell.id) ?? 0) - (counts.get(cell.id) ?? 0))
    return { id: cell.id, label: cellLabelOf(cell, cells), remaining, allCut: remaining === 0 }
  })
}

/** Whether "+ 1 set" may add one more set of this size now. */
export function maySet(sizes: readonly SizeState[], cellId: string | null): boolean {
  if (!cellId) return false
  const size = sizes.find((entry) => entry.id === cellId)
  return Boolean(size && !size.allCut)
}

/** The size picked after a set: the same one while it has garments left, else the next one that has (the picked size stays picked). */
export function nextPicked(sizes: readonly SizeState[], picked: string | null): string | null {
  const current = sizes.find((entry) => entry.id === picked)
  if (current && !current.allCut) return current.id
  return sizes.find((entry) => !entry.allCut)?.id ?? null
}

/** Sets per cell of a work order's cut log entries saved on this tablet and not yet recorded (they count already). */
export function pendingSets(items: readonly { readonly kind: string; readonly state: string; readonly payload: Readonly<Record<string, unknown>> }[], workOrderId: string): Map<string, number> {
  const pending = new Map<string, number>()
  for (const item of items) {
    if (item.kind !== 'production.cut.log' || item.state !== 'waiting' || item.payload.workOrderId !== workOrderId) continue
    const lines = Array.isArray(item.payload.lines) ? (item.payload.lines as { workOrderSizeId?: unknown; sets?: unknown }[]) : []
    for (const line of lines) {
      if (typeof line.workOrderSizeId === 'string' && typeof line.sets === 'number') pending.set(line.workOrderSizeId, (pending.get(line.workOrderSizeId) ?? 0) + line.sets)
    }
  }
  return pending
}

// ---- Hide done: the remnant and the area used --------------------------------------------------------------------------

export type RemnantProblem = 'empty' | 'tooLarge' | null

/**
 * The remnant against what is left of the hide for the work order (both in the same unit): at most what is left, and
 * less than it when the draft logs pieces (they used some of it). Zero is "No remnant · done".
 */
export function remnantProblem(left: string, remnant: number | null, hasPieces: boolean): RemnantProblem {
  if (remnant === null || !(remnant > 0)) return 'empty'
  const value = new Dec(String(remnant))
  const rest = new Dec(left)
  if (value.gt(rest) || (hasPieces && value.gte(rest))) return 'tooLarge'
  return null
}

/** The area this Hide done uses: what is left less the remnant (shown, never typed), from 0. */
export function areaUsed(left: string, remnant: number | null): string {
  const rest = new Dec(left).minus(remnant !== null && remnant > 0 ? new Dec(String(remnant)) : ZERO)
  return Dec.max(ZERO, rest).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
}

/** The remnant as the cut's body sends it (four places at most, as the API keeps areas). */
export const remnantText = (remnant: number): string => new Dec(String(remnant)).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** The largest remnant the pad takes: what is left, rounded down to the pad's places. */
export function remnantMax(left: string, places = 2): number {
  return Number(new Dec(left).toDecimalPlaces(places, Dec.ROUND_DOWN).toFixed(places))
}

// ---- the hide check -----------------------------------------------------------------------------------------------------

export type ShadeMatch =
  /** Every other hide of the work order has this dye batch. */
  | { readonly kind: 'same'; readonly batch: string }
  /** Another hide of the work order has another batch (information in W1; W2b blocks it, MES-053). */
  | { readonly kind: 'different'; readonly batch: string | null; readonly others: readonly string[] }
  /** The first hide of the work order, or no batch known. */
  | { readonly kind: 'first' | 'unknown' }

export function shadeMatch(batch: string | null, others: readonly { readonly hideId: string; readonly dyeBatch: string | null }[], hideId: string): ShadeMatch {
  const batches = [...new Set(others.filter((other) => other.hideId !== hideId).map((other) => other.dyeBatch).filter((value): value is string => Boolean(value)))]
  if (batches.length === 0) return { kind: others.some((other) => other.hideId !== hideId) || !batch ? 'unknown' : 'first' }
  if (!batch) return { kind: 'unknown' }
  return batches.every((other) => other === batch) ? { kind: 'same', batch } : { kind: 'different', batch, others: batches.filter((other) => other !== batch) }
}

/** The hide states the floor cuts (a used-up or scrapped hide is refused before the knife). */
export const isUsedUp = (state: string): boolean => state === 'CONSUMED' || state === 'SCRAPPED'

/** Why a lot may not be cut, from what the hide's answer says of it (the API's own code wins when it gives one). */
export function lotReasonOf(lot: { readonly qualityStatus: string; readonly crViStatus: string }, apiCode?: string | null): 'CR_VI_PENDING' | 'CR_VI_FAILED' | 'QUALITY_HOLD' | 'BLOCKED' | 'REJECTED' {
  const known = ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED'] as const
  const given = known.find((code) => code === apiCode)
  if (given) return given
  const failed = lot.crViStatus === 'FAIL'
  switch (lot.qualityStatus) {
    case 'RELEASED':
      return failed ? 'CR_VI_FAILED' : 'CR_VI_PENDING'
    case 'QUARANTINE':
      return failed ? 'CR_VI_FAILED' : lot.crViStatus === 'PASS' || lot.crViStatus === 'NOT_REQUIRED' ? 'QUALITY_HOLD' : 'CR_VI_PENDING'
    case 'BLOCKED':
      return failed ? 'CR_VI_FAILED' : 'BLOCKED'
    default:
      return 'REJECTED'
  }
}
