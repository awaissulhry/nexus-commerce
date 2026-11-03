import { CUT_OVERRIDE_REASONS, CUT_WARNING_KINDS, measuredThicknessProblem, thicknessCheck, type CutOverrideReasonCode, type CutWarningKind } from '@nexus/factory-domain/production/cutting/checks'
import { minimumRemnantIn } from '@nexus/factory-domain/inventory/remnants/rules'
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

export type RemnantProblem = 'empty' | 'tooLarge' | 'tooSmall' | null

/**
 * The remnant against what is left of the hide for the work order (both in the same unit): at most what is left, and
 * less than it when the draft logs pieces (they used some of it). Zero is "No remnant · done". With the hide's unit
 * (`uom`), a piece under the smallest remnant kept is waste (B-W2b-100 MINIMUM_REMNANT, 10 dm²: the office refuses it).
 */
export function remnantProblem(left: string, remnant: number | null, hasPieces: boolean, uom?: string): RemnantProblem {
  if (remnant === null || !(remnant > 0)) return 'empty'
  const value = new Dec(String(remnant))
  const rest = new Dec(left)
  if (value.gt(rest) || (hasPieces && value.gte(rest))) return 'tooLarge'
  const least = uom ? minimumRemnantIn(uom) : null
  if (least && value.lt(least)) return 'tooSmall'
  return null
}

/** The smallest remnant kept, in the hide's unit (two places, rounded up so the words never say less than the rule). */
export function remnantMinimum(uom: string): string | null {
  const least = minimumRemnantIn(uom)
  return least ? least.toDecimalPlaces(2, Dec.ROUND_UP).toFixed(2) : null
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

// ---- B-W2b-110: the hide check in depth (B-W2b-103's `checks`), "Cut anyway", the photo, the thickness measured here ------

export type { CutWarningKind }

export interface ShadeLot {
  readonly lotCode: string
  readonly shadeLabel: string | null
}

/** One warning of the hide check: kind, finer code and the facts the screen words in its own language (never the API's English). */
export interface CheckWarning {
  readonly kind: CutWarningKind
  readonly code: string
  readonly shade?: { readonly rule: string; readonly cutFrom: readonly ShadeLot[]; readonly hide: ShadeLot & { readonly outOfShade: boolean }; readonly cell: string | null } | undefined
  readonly wrongHide?:
    | { readonly reservedHides: readonly { readonly code: string; readonly lotCode: string; readonly grade: string | null }[]; readonly reservedLots: readonly string[]; readonly differs: readonly string[]; readonly hide: { readonly lotCode: string; readonly grade: string | null } }
    | undefined
  readonly thickness?: { readonly valueMm: string; readonly source: 'TABLE' | 'HIDE'; readonly minMm: string | null; readonly maxMm: string | null } | undefined
  readonly grade?: { readonly hideGrade: string | null; readonly pieces: readonly { readonly name: string; readonly minGrade: string }[] } | undefined
}

export type ThicknessVerdict = 'OK' | 'THIN' | 'THICK' | 'UNKNOWN' | 'NO_SPEC'

export interface ThicknessView {
  readonly verdict: ThicknessVerdict
  readonly valueMm: string | null
  readonly source: 'TABLE' | 'HIDE' | null
  readonly minMm: string | null
  readonly maxMm: string | null
}

/** The hide check of one work order as the office answered it (GET /production/cutting/hides `workOrders[].checks`). */
export interface HideChecks {
  readonly warnings: readonly CheckWarning[]
  readonly standing: readonly CutWarningKind[]
  readonly passed: readonly CutWarningKind[]
  readonly shade: { readonly rule: string; readonly cutFrom: readonly ShadeLot[]; readonly hide: ShadeLot & { readonly outOfShade: boolean }; readonly same: boolean | null }
  readonly thickness: ThicknessView
  readonly grade: { readonly hide: string | null; readonly byText: boolean; readonly pieces: readonly { readonly name: string; readonly minGrade: string | null; readonly verdict: 'OK' | 'BELOW' | 'UNKNOWN' }[] }
  readonly reserved: { readonly forIt: boolean; readonly hides: readonly string[]; readonly lots: readonly string[] }
  readonly photo: { readonly required: boolean }
}

/** What the card shows and stops on, once the thickness measured at the table is counted in. */
export interface CardCheck {
  /** Every warning (the office's; the thickness one from the table measure when there is one), in the database's kind order. */
  readonly warnings: readonly CheckWarning[]
  /** The kinds no lead passed for this hide and work order: the card stops on them ("Cut anyway"). Empty: straight to the sizes. */
  readonly standing: readonly CutWarningKind[]
  readonly thickness: ThicknessView
  /** "Cut anyway" on the thickness read off the hide's record needs the measure at the table first (the office refuses it otherwise). */
  readonly needsMeasure: boolean
}

const kindOrder = (kinds: Iterable<CutWarningKind>): CutWarningKind[] => {
  const set = new Set(kinds)
  return CUT_WARNING_KINDS.filter((kind) => set.has(kind))
}

/**
 * The card's check with the thickness measured at the table (`measuredMm`, mm; null: none): the office's check reads the
 * hide's record only, and a cut that carries the measure is checked against it (B-W2b-103 thicknessCheck: the table first).
 * So a measure inside the range takes a THICKNESS warning away, one outside it adds one, unless a lead passed THICKNESS
 * already for this hide and work order. Everything else is the office's word.
 */
export function cardCheck(checks: HideChecks, measuredMm: string | null): CardCheck {
  if (measuredMm === null) {
    const standing = kindOrder(checks.standing)
    return { warnings: [...checks.warnings], standing, thickness: checks.thickness, needsMeasure: standing.includes('THICKNESS') && checks.thickness.source !== 'TABLE' }
  }
  const recordedMm = checks.thickness.source === 'HIDE' ? checks.thickness.valueMm : null
  const thickness: ThicknessView = thicknessCheck({ minMm: checks.thickness.minMm, maxMm: checks.thickness.maxMm, recordedMm, measuredMm })
  const warns = thickness.verdict === 'THIN' || thickness.verdict === 'THICK'
  const others = checks.warnings.filter((warning) => warning.kind !== 'THICKNESS')
  const warning: CheckWarning | null = warns && thickness.valueMm !== null ? { kind: 'THICKNESS', code: thickness.verdict, thickness: { valueMm: thickness.valueMm, source: 'TABLE', minMm: thickness.minMm, maxMm: thickness.maxMm } } : null
  const warnings = [...others, ...(warning ? [warning] : [])].sort((a, b) => CUT_WARNING_KINDS.indexOf(a.kind) - CUT_WARNING_KINDS.indexOf(b.kind))
  const standing = kindOrder([...checks.standing.filter((kind) => kind !== 'THICKNESS'), ...(warning && !checks.passed.includes('THICKNESS') ? ['THICKNESS' as const] : [])])
  return { warnings, standing, thickness, needsMeasure: false }
}

/** The standing warnings themselves (the ones the card and "Cut anyway?" list). */
export function standingWarnings(card: Pick<CardCheck, 'warnings' | 'standing'>): CheckWarning[] {
  return card.warnings.filter((warning) => card.standing.includes(warning.kind))
}

/** Whether a thickness can be measured against a range (the leather article has one). */
export const hasThicknessSpec = (thickness: Pick<ThicknessView, 'minMm' | 'maxMm'>): boolean => thickness.minMm !== null || thickness.maxMm !== null

/** The thickness typed on the pad as the cut sends it ("0.98"), or why it is not one (the office's own rule). */
export function measureOf(value: number | null): { readonly text: string | null; readonly problem: 'empty' | 'invalid' | null } {
  if (value === null || !(value > 0)) return { text: null, problem: 'empty' }
  const text = new Dec(String(value)).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2)
  return measuredThicknessProblem(text) ? { text: null, problem: 'invalid' } : { text, problem: null }
}

/** Waiting cut actions of a work order on this tablet (they go first: "Cut anyway" waits for them). */
export function waitingCuts(items: readonly { readonly kind: string; readonly state: string; readonly payload: Readonly<Record<string, unknown>> }[], workOrderId: string): number {
  return items.filter((item) => (item.kind === 'production.cut.log' || item.kind === 'production.cut.remnant') && item.state === 'waiting' && item.payload.workOrderId === workOrderId).length
}

/**
 * Why "Cut anyway" cannot open now, in order (null: it may): the office checks the lead's PIN, so it needs the network;
 * this work order's cuts saved on the tablet go first (order); the thickness read off the hide's record needs a measure;
 * the first set needs a size with garments left; a photo the site asks for comes first.
 */
export type AnywayHeld = 'offline' | 'waiting' | 'measure' | 'pickSize' | 'allCut' | 'photo' | null

export function anywayHeld(facts: { readonly online: boolean; readonly waiting: number; readonly needsMeasure: boolean; readonly picked: SizeState | null; readonly photoMissing: boolean }): AnywayHeld {
  if (!facts.online) return 'offline'
  if (facts.waiting > 0) return 'waiting'
  if (facts.needsMeasure) return 'measure'
  if (!facts.picked) return 'pickSize'
  if (facts.picked.allCut) return 'allCut'
  if (facts.photoMissing) return 'photo'
  return null
}

/** The reason tiles of "Cut anyway" (B-W2b-103 CUT_OVERRIDE_REASONS, a fixed list): OTHER asks a few words. */
export const ANYWAY_REASONS = CUT_OVERRIDE_REASONS

/** The tile and its words are enough to sign (OTHER: three characters or more, the office's rule). */
export function anywayReady(reasonCode: string | null, words: string): reasonCode is CutOverrideReasonCode {
  const reason = ANYWAY_REASONS.find((entry) => entry.code === reasonCode)
  return Boolean(reason) && (!reason!.needsNote || words.trim().length >= 3)
}

/** What a refused signature says in the pop-up (the lead tries again), or null: it closes on the screen that says why. */
export type AnywayProblem = 'wrong' | 'self' | 'notLead' | 'note' | 'locked' | 'unavailable' | 'measure' | null

export function anywayProblemOf(problem: { readonly kind: string; readonly code?: string; readonly path?: string | null }): AnywayProblem | 'changed' | 'close' {
  if (problem.kind === 'refused') {
    switch (problem.code) {
      case 'LEAD_PIN_WRONG':
        return 'wrong'
      case 'LEAD_IS_CUTTER':
        return 'self'
      case 'NOT_A_LEAD':
        return 'notLead'
      case 'LEAD_NOTE_MISSING':
        return 'note'
      case 'CUT_WARNING':
        // A warning the card did not show (it changed since): the card is read again and the lead signs what stands now.
        return 'changed'
      default:
        return 'close'
    }
  }
  if (problem.kind === 'invalid' && problem.path === 'body/cut/measuredThicknessMm') return 'measure'
  if (problem.kind === 'rateLimited') return 'locked'
  if (problem.kind === 'offline' || problem.kind === 'unavailable') return 'unavailable'
  return 'close'
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
