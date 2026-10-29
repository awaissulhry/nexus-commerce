import type { HideState } from '../../inventory/issue/rules'
import { quantityText } from '../../inventory/ledger/moves'
import { NOT_COUNTED_WORDS, usabilityOf, type LotQuality, type UnusableReason } from '../../planning/usable'
import { NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE, type FloorReadiness } from '../../privacy/readiness'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253, PRD-030; PLAN §4.7 stage 11b-cut; A2
 * SCR-094), pure: what a cut of one hide for one work order logs, how much of the hide it uses, what the hide is after
 * it, and when an entry may be undone (the cutter's own last one) or corrected (the office). The API
 * (apps/factory-api modules/production/cutting) reads the facts inside the cutting command, under the work order's issue
 * lock and the hide's cut lock, and writes the CutLog; the …_production_guards trigger stays the last word on the work
 * order's state, the subject, the lot, the hide and the area.
 *
 *   sets       "+ 1 set" logs one piece of every part of one garment of a cell in the hide's material: the parts are
 *              the BOM lines' places (placement, else the material's code) of that material in the cell's frozen
 *              materials (WorkOrderMaterial). A cell takes at most the garments it still has to cut in that material
 *              ("Size 52 is all cut"); single parts (a hide that runs out mid-set, a recut) are logged by name, beyond.
 *   area       the BOM's need of the sets: the cell's planned base quantity of the material (wastage included) per
 *              garment, times the sets, rounded half up to four places. Single parts have no area in the BOM: they are
 *              logged with a typed area, or with Hide done. The area is never above what is left of the hide for the
 *              work order: issued minus returned (the ledger) minus what was cut (the cut log), SCM-194.
 *   hide done  closes the hide for the work order: what is left is either the remnant set aside (returned to stock by
 *              a RETURN move, MES-058) or used by this last entry (its pieces and the waste): area used = left minus
 *              remnant, shown, not typed. Nothing left anywhere and no remnant: the hide is CONSUMED (final).
 *   state      a cut leaves the hide PARTLY_CUT; Hide done with a remnant leaves it a REMNANT (the remnant is its stock);
 *              without one, CONSUMED once nothing of it is in stock or at another work order (SCM-253).
 *   undo       the cutter's own last entry on this device, before the next one, while nothing was made of it.
 *   correction the office reverses any entry once with a reason: a mirror entry (the same work order, hide, unit and
 *              areas, no pieces) that gives its area and pieces back.
 *   closing    a used-up (CONSUMED) hide names its closing entry: the Hide done's entry, or the last cut when Hide done
 *              used nothing more. Its cuts are final but that one: undoing or correcting the closing entry opens the
 *              hide again (PARTLY_CUT; its area is at the work order again), so a wrong closing cut is put right.
 *   readiness  a floor cut is real floor work: it waits for the site's floor to be ready (B-W1-36's privacy gate: a
 *              stored DPIA and a published worker notice; B-W1-37's floor rules: a legal basis on record where the site
 *              names workers), refused in the gate's own words.
 * A SCRAPPED hide never changes again, nor does a CONSUMED one but for the reversal of its closing entry (the
 * …_production_leftovers_guards triggers), and the cut log trigger cuts neither: their other entries are not undone or
 * corrected here (the area they gave back could never be cut or returned).
 *
 * Areas are decimals (decimal.js) in the hide's material's base unit (an area unit: m², dm² or ft²), never floats.
 */

/** Hides are cut only for a released work order or one in progress. */
export const CUTTABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS'])

/** Why a cut, an undo or a correction is refused: a stable code (the screens' words) and its sentence. */
export const CUT_REFUSALS = [
  'FLOOR_NOT_READY',
  'WORK_ORDER_NOT_OPEN',
  'CR_VI_PENDING',
  'CR_VI_FAILED',
  'QUALITY_HOLD',
  'BLOCKED',
  'REJECTED',
  'HIDE_USED_UP',
  'NOT_AT_WORK_ORDER',
  'NOTHING_LEFT',
  'NO_PIECES',
  'NOT_FOR_CELL',
  'CELL_ALL_CUT',
  'AREA_UNKNOWN',
  'AREA_EXCEEDED',
  'REMNANT_TOO_LARGE',
  'NOT_A_CUT',
  'REVERSED_ALREADY',
  'NOT_LAST_ACTION',
  'IN_BUNDLE',
] as const
export type CutRefusalCode = (typeof CUT_REFUSALS)[number]

export interface CutRefusal {
  readonly code: CutRefusalCode
  readonly message: string
}

const refuse = (code: CutRefusalCode, message: string): { readonly ok: false; readonly refusal: CutRefusal } => ({ ok: false, refusal: { code, message } })
const dec = (value: DecimalInput): Decimal => new Dec(value)
const text = quantityText
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** "BLK 52": a cell in the sentences. */
export const cellLabel = (colourwayCode: string, size: string): string => `${colourwayCode} ${size}`

/** A garment part as the BOM names it: the line's placement, else the material's code. */
export const partOf = (placement: string | null | undefined, itemCode: string): string => placement?.trim() || itemCode

// ---- the parts of a cell and what was cut of them ----------------------------------------------------------------------------

/** One planned row of a HIDE-tracked material of a work order (WorkOrderMaterial): its cell, material, part and need. */
export interface PlannedPart {
  readonly cellId: string
  readonly itemId: string
  readonly itemColourId: string | null
  /** partOf(placement, item code). */
  readonly part: string
  /** For the cell's whole quantity, in the material's base unit, wastage included. */
  readonly baseQuantity: DecimalInput
}

export interface Material {
  readonly itemId: string
  readonly itemColourId: string | null
}

const isMaterial = (row: PlannedPart, material: Material | undefined) => !material || (row.itemId === material.itemId && row.itemColourId === material.itemColourId)

/** The parts of a cell (of one material, or of every hide-cut material), sorted, once each. */
export function partsOf(planned: readonly PlannedPart[], cellId: string, material?: Material): string[] {
  return [...new Set(planned.filter((row) => row.cellId === cellId && isMaterial(row, material)).map((row) => row.part))].sort()
}

/** The BOM's need for ONE garment of the cell in this material (base unit); null: the cell does not use it. */
export function perGarmentOf(planned: readonly PlannedPart[], cell: { readonly id: string; readonly quantity: number }, material: Material): Decimal | null {
  const rows = planned.filter((row) => row.cellId === cell.id && isMaterial(row, material))
  if (rows.length === 0 || cell.quantity < 1) return null
  return rows.reduce((sum, row) => sum.plus(dec(row.baseQuantity)), ZERO).div(cell.quantity)
}

/** The BOM's need for `sets` garments of the cell in this material, rounded half up to four places. */
export function setsNeed(planned: readonly PlannedPart[], cell: { readonly id: string; readonly quantity: number }, material: Material, sets: number): Decimal {
  const rows = planned.filter((row) => row.cellId === cell.id && isMaterial(row, material))
  if (rows.length === 0 || cell.quantity < 1 || sets <= 0) return ZERO
  return rows
    .reduce((sum, row) => sum.plus(dec(row.baseQuantity)), ZERO)
    .times(sets)
    .div(cell.quantity)
    .toDecimalPlaces(4, Dec.ROUND_HALF_UP)
}

/** A cut piece row of a live entry (neither a reversal nor reversed). */
export interface CutPiece {
  readonly cutLogId: string
  readonly cellId: string
  readonly part: string
  readonly pieces: number
}

/** Pieces cut per part of one cell. */
export function piecesOf(pieces: readonly CutPiece[], cellId: string): Map<string, number> {
  const byPart = new Map<string, number>()
  for (const row of pieces) if (row.cellId === cellId) byPart.set(row.part, (byPart.get(row.part) ?? 0) + row.pieces)
  return byPart
}

/** Garment sets cut: the fewest pieces of any of the parts (one piece per part per garment); null: no parts to cut. */
export function setsCut(parts: readonly string[], cut: ReadonlyMap<string, number>): number | null {
  if (parts.length === 0) return null
  return Math.min(...parts.map((part) => cut.get(part) ?? 0))
}

export interface CellProgress {
  readonly cellId: string
  readonly quantity: number
  /** Garments cut (every hide-cut part of the cell); null: the cell has no part cut from hides (not counted here). */
  readonly cut: number | null
  /** Still to cut (from 0); null with `cut`. */
  readonly toCut: number | null
  /** Pieces cut per part, the BOM's parts first (0 when none), then parts logged by another name (recuts). */
  readonly parts: readonly { readonly part: string; readonly pieces: number; readonly planned: boolean }[]
}

/** The cut count of each cell of a work order (MES-056; the work order record's "cut"). */
export function cellProgress(cells: readonly { readonly id: string; readonly quantity: number }[], planned: readonly PlannedPart[], pieces: readonly CutPiece[]): CellProgress[] {
  return cells.map((cell) => {
    const parts = partsOf(planned, cell.id)
    const cut = piecesOf(pieces, cell.id)
    const count = setsCut(parts, cut)
    const others = [...cut.keys()].filter((part) => !parts.includes(part)).sort()
    return {
      cellId: cell.id,
      quantity: cell.quantity,
      cut: count,
      toCut: count === null ? null : Math.max(0, cell.quantity - count),
      parts: [...parts.map((part) => ({ part, pieces: cut.get(part) ?? 0, planned: true })), ...others.map((part) => ({ part, pieces: cut.get(part) ?? 0, planned: false }))],
    }
  })
}

// ---- a cut ---------------------------------------------------------------------------------------------------------------------

/** A cell as the cut sees it, for the hide's material. */
export interface CutCell {
  readonly id: string
  /** cellLabel(colourway, size). */
  readonly label: string
  readonly quantity: number
  /** The parts of the hide's material in the cell (empty: the cell does not use it). */
  readonly parts: readonly string[]
  /** The BOM's need of the cell's whole quantity in the hide's material (base unit); 0 when it does not use it. */
  readonly need: DecimalInput
  /** Pieces cut so far per part of the cell (live entries). */
  readonly cut: ReadonlyMap<string, number>
}

/** What the cutter logs for one cell: whole garment sets, and single parts by name. */
export interface CutLine {
  readonly cellId: string
  readonly sets?: number | undefined
  readonly parts?: readonly { readonly part: string; readonly pieces: number }[] | undefined
}

export interface CutFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly hide: { readonly code: string; readonly state: HideState }
  readonly lot: LotQuality & { readonly code: string }
  readonly baseUom: string
  /** What the work order holds of the hide: issued minus returned (the ledger), after an issue in this command. */
  readonly atWorkOrder: DecimalInput
  /** What was cut of the hide for the work order: its cut log, net of reversals. */
  readonly cut: DecimalInput
  /** The work order's cells the lines name. */
  readonly cells: ReadonlyMap<string, CutCell>
  readonly lines: readonly CutLine[]
  /** The area single parts used, typed (base unit); null: none typed. Ignored with Hide done (the rest is used). */
  readonly area: DecimalInput | null
  /** Hide done: the remnant set aside (base unit; 0 = none). Null: the hide stays open for the work order. */
  readonly done: { readonly remnant: DecimalInput } | null
  /** What else of the hide is anywhere: on hand at the site, or not yet cut at another work order (base unit). */
  readonly elsewhere: DecimalInput
}

export interface CutEntry {
  /** In the base unit: above 0. */
  readonly areaUsed: string
  /** The remnant set aside by this entry (Hide done), from 0. */
  readonly remnant: string
  /** The BOM's need of the whole sets it logs (the yield's pattern area). */
  readonly pattern: string
  readonly pieces: readonly { readonly cellId: string; readonly part: string; readonly pieces: number }[]
}

export type CutDecision =
  | {
      readonly ok: true
      /** Null: Hide done with nothing more used (only the remnant goes back, or the hide is closed as it is). */
      readonly entry: CutEntry | null
      /** The remnant going back to stock (base unit), from 0. */
      readonly remnant: string
      readonly hideState: HideState
      /** Hide done: the hide is closed for the work order. */
      readonly closes: boolean
      /** What is left of the hide for the work order after it (base unit). */
      readonly left: string
    }
  | { readonly ok: false; readonly refusal: CutRefusal }

/** The words of a lot that is not usable at the cutting table. */
export function lotWords(lotCode: string, reason: UnusableReason): string {
  return `Lot ${lotCode}: ${NOT_COUNTED_WORDS[reason]}. Do not cut this hide; only released leather is cut (REACH Annex XVII entry 47: chromium VI).`
}

/**
 * Whether the site's floor may log cuts (platform/privacy floorReadinessFor's answer; null: the site is not in scope):
 * the gate's words for what is missing, the privacy gate's first.
 */
export function floorReadyRefusal(readiness: FloorReadiness | null): CutRefusal | null {
  if (readiness?.readyForFloor) return null
  const missing = readiness
    ? [...(readiness.privacy.ready ? [] : readiness.privacy.notes.filter((note) => note === NO_DPIA_NOTE || note === NO_WORKER_NOTICE_NOTE)), ...(readiness.rules.readyForFloor ? [] : readiness.rules.notes)]
    : []
  const words = missing.length > 0 ? missing : (readiness?.notes ?? ['The floor rules of this site are not set up.'])
  return { code: 'FLOOR_NOT_READY', message: `Cutting is held at this site until its floor is ready: ${words.join(' ')}` }
}

/**
 * Whether the hide may be cut for the work order at all, before anything else is read or issued: the work order open,
 * the lot usable (a recall or a failed test stops the knife even on a hide already issued), the hide not used up.
 */
export function cuttableRefusal(facts: Pick<CutFacts, 'workOrder' | 'hide' | 'lot'>): CutRefusal | null {
  const { workOrder, hide } = facts
  if (!CUTTABLE_STATUSES.includes(workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${workOrder.number} is ${workOrder.status}; hides are cut only for a RELEASED or IN_PROGRESS work order.` }
  }
  const usability = usabilityOf(facts.lot)
  if (!usability.usable) return { code: usability.reason, message: lotWords(facts.lot.code, usability.reason) }
  if (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED') {
    return { code: 'HIDE_USED_UP', message: `Hide ${hide.code} is ${hide.state === 'CONSUMED' ? 'used up' : 'scrapped'}; it is not cut.` }
  }
  return null
}

/** What one cut logs, and whether it may (rules in the header). */
export function cutDecision(facts: CutFacts): CutDecision {
  const { workOrder, hide, baseUom } = facts
  const first = cuttableRefusal(facts)
  if (first) return { ok: false, refusal: first }
  const at = dec(facts.atWorkOrder)
  if (at.lte(0)) return refuse('NOT_AT_WORK_ORDER', `Work order ${workOrder.number} holds none of hide ${hide.code}: it was not issued to it, or it all came back.`)
  const left = Dec.max(ZERO, at.minus(dec(facts.cut)))

  // The pieces, per cell and part (sets: every part of the hide's material once per garment).
  const rows = new Map<string, { cellId: string; part: string; pieces: number }>()
  const add = (cellId: string, part: string, pieces: number) => {
    const key = `${cellId}|${part}`
    rows.set(key, { cellId, part, pieces: (rows.get(key)?.pieces ?? 0) + pieces })
  }
  let pattern = ZERO
  let singleParts = false
  const setsOf = new Map<string, number>()
  for (const line of facts.lines) {
    const cell = facts.cells.get(line.cellId)
    const sets = line.sets ?? 0
    const parts = (line.parts ?? []).filter((entry) => entry.pieces > 0 && entry.part.trim() !== '')
    if (!cell) return refuse('NOT_FOR_CELL', `Work order ${workOrder.number} has no such cell.`)
    if (cell.parts.length === 0) return refuse('NOT_FOR_CELL', `Work order ${workOrder.number} ${cell.label} does not use this hide's leather.`)
    if (sets > 0) {
      const done = setsCut(cell.parts, cell.cut) ?? 0
      const toCut = Math.max(0, cell.quantity - done)
      const asked = (setsOf.get(cell.id) ?? 0) + sets
      setsOf.set(cell.id, asked)
      if (asked > toCut) {
        return refuse('CELL_ALL_CUT', toCut === 0 ? `${cell.label} is all cut (${plural(cell.quantity, 'garment')}).` : `${cell.label} has ${plural(toCut, 'garment')} to cut; this logs ${plural(asked, 'set')}.`)
      }
      for (const part of cell.parts) add(cell.id, part, sets)
      pattern = pattern.plus(dec(cell.need).times(sets).div(cell.quantity))
    }
    for (const entry of parts) {
      add(cell.id, entry.part.trim(), entry.pieces)
      singleParts = true
    }
  }
  const pieces = [...rows.values()]
  pattern = pattern.toDecimalPlaces(4, Dec.ROUND_HALF_UP)

  if (facts.done) {
    const remnant = dec(facts.done.remnant)
    const used = left.minus(remnant)
    if (remnant.lt(0) || used.lt(0) || (pieces.length > 0 && used.lte(0))) {
      return refuse(
        'REMNANT_TOO_LARGE',
        pieces.length > 0
          ? `Hide ${hide.code} has ${text(left)} ${baseUom} left for work order ${workOrder.number}, and these pieces used some of it: the remnant is less than ${text(left)}.`
          : `Hide ${hide.code} has ${text(left)} ${baseUom} left for work order ${workOrder.number}; the remnant is at most ${text(left)}.`,
      )
    }
    const nothingElse = dec(facts.elsewhere).lte(0)
    const hideState: HideState = remnant.gt(0) ? 'REMNANT' : nothingElse ? 'CONSUMED' : hide.state === 'FULL' ? 'PARTLY_CUT' : hide.state
    const entry: CutEntry | null = used.gt(0) ? { areaUsed: text(used), remnant: text(remnant), pattern: text(Dec.min(pattern, used)), pieces } : null
    return { ok: true, entry, remnant: text(remnant), hideState, closes: true, left: text(ZERO) }
  }

  if (pieces.length === 0) return refuse('NO_PIECES', 'Log at least one garment set or one part, or close the hide (Hide done).')
  if (left.lte(0)) return refuse('NOTHING_LEFT', `Hide ${hide.code} has nothing left for work order ${workOrder.number}: all of it was cut. Close it (Hide done).`)
  let area: Decimal
  if (facts.area !== null) {
    area = dec(facts.area)
  } else if (singleParts) {
    return refuse('AREA_UNKNOWN', 'Single parts have no area in the BOM: give the area they used, or log them with Hide done (the rest of the hide).')
  } else {
    area = pattern
  }
  if (area.lte(0) || area.gt(left)) {
    return refuse(
      'AREA_EXCEEDED',
      `Hide ${hide.code} has ${text(left)} ${baseUom} left for work order ${workOrder.number}; these pieces need ${text(area)}${facts.area === null ? ' (the BOM)' : ''}. Log fewer pieces, or close the hide with Hide done.`,
    )
  }
  return { ok: true, entry: { areaUsed: text(area), remnant: text(ZERO), pattern: text(Dec.min(pattern, area)), pieces }, remnant: text(ZERO), hideState: 'PARTLY_CUT', closes: false, left: text(left.minus(area)) }
}

// ---- undo and correction -------------------------------------------------------------------------------------------------------

export interface ReversalFacts {
  readonly entry: { readonly id: string; readonly reversalOfId: string | null; readonly reversed: boolean }
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  /** The entry's hide; `closingCutLogId`: a CONSUMED hide's closing entry (Hide.closingCutLogId), else null. */
  readonly hide: { readonly code: string; readonly state: HideState; readonly closingCutLogId: string | null }
  /** The ACTIVE bundles that carry the entry's pieces (B-W1-41), by code. */
  readonly bundles: readonly string[]
}

/** The entry is its CONSUMED hide's closing entry: reversing it opens the hide again. */
export const closesHide = (facts: Pick<ReversalFacts, 'entry' | 'hide'>): boolean => facts.hide.state === 'CONSUMED' && facts.hide.closingCutLogId === facts.entry.id

/**
 * The hide's state after a reversal of one of its entries: a used-up hide whose closing entry is reversed is open again
 * (PARTLY_CUT); a remnant whose RETURN the undo took back to the work order is cut on (PARTLY_CUT); else as it was.
 */
export function stateAfterReversal(facts: { readonly state: HideState; readonly reopens: boolean; readonly remnantReturnReversed: boolean }): HideState {
  if (facts.state === 'CONSUMED') return facts.reopens ? 'PARTLY_CUT' : 'CONSUMED'
  if (facts.state === 'REMNANT' && facts.remnantReturnReversed) return 'PARTLY_CUT'
  return facts.state
}

/** Why the office may not correct (reverse) this entry, or null. */
export function correctionRefusal(facts: ReversalFacts): CutRefusal | null {
  if (facts.entry.reversalOfId !== null) return { code: 'NOT_A_CUT', message: 'This entry is itself a correction or an undo; it is not reversed. Log the cut again instead.' }
  if (facts.entry.reversed) return { code: 'REVERSED_ALREADY', message: 'This cut was reversed already; an entry has at most one reversal.' }
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}; its cut log changes only while it is RELEASED or IN_PROGRESS.` }
  }
  if (facts.hide.state === 'SCRAPPED') {
    return { code: 'HIDE_USED_UP', message: `Hide ${facts.hide.code} is scrapped: its cuts are final. The area a reversal gave back could never be cut or returned.` }
  }
  if (facts.hide.state === 'CONSUMED' && !closesHide(facts)) {
    return {
      code: 'HIDE_USED_UP',
      message: `Hide ${facts.hide.code} is used up: its cuts are final but its closing cut. Correct the closing cut first (that opens the hide again), then this one.`,
    }
  }
  if (facts.bundles.length > 0) {
    return { code: 'IN_BUNDLE', message: `The pieces of this cut travel in bundle${facts.bundles.length === 1 ? '' : 's'} ${facts.bundles.join(', ')}: void ${facts.bundles.length === 1 ? 'it' : 'them'} first.` }
  }
  return null
}

/**
 * Why the cutter may not undo this entry, or null: only their own last entry on this device (`own`: made on this device
 * by this worker, or by this station where the site records stations; `latest`: the device's newest entry), and only
 * what a correction could reverse.
 */
export function undoRefusal(facts: ReversalFacts & { readonly own: boolean; readonly latest: boolean }): CutRefusal | null {
  const refusal = correctionRefusal(facts)
  if (refusal && refusal.code !== 'IN_BUNDLE') return refusal
  if (!facts.own || !facts.latest) return { code: 'NOT_LAST_ACTION', message: 'Only your last cut on this tablet is undone, before the next one; ask the office to correct an older one.' }
  return refusal
}

// ---- a hide's area for a work order ----------------------------------------------------------------------------------------------

/** The pattern area of one entry: the BOM's need of the whole sets it logs; null when it logs single parts too. */
export function entryPattern(
  pieces: readonly { readonly cellId: string; readonly part: string; readonly pieces: number }[],
  cells: ReadonlyMap<string, { readonly parts: readonly string[]; readonly need: DecimalInput; readonly quantity: number }>,
): Decimal | null {
  let pattern = ZERO
  const byCell = new Map<string, Map<string, number>>()
  for (const row of pieces) {
    const parts = byCell.get(row.cellId) ?? new Map<string, number>()
    parts.set(row.part, (parts.get(row.part) ?? 0) + row.pieces)
    byCell.set(row.cellId, parts)
  }
  for (const [cellId, parts] of byCell) {
    const cell = cells.get(cellId)
    if (!cell || cell.parts.length === 0 || cell.quantity < 1) return null
    const sets = setsCut(cell.parts, parts) ?? 0
    if ([...parts.entries()].some(([part, count]) => !cell.parts.includes(part) || count !== sets)) return null
    pattern = pattern.plus(dec(cell.need).times(sets).div(cell.quantity))
  }
  return pattern.toDecimalPlaces(4, Dec.ROUND_HALF_UP)
}

export interface HideArea {
  /** Issued to the work order (ISSUE moves net of their reversals). */
  readonly issued: string
  /** The pattern area of the pieces cut (the BOM's need; an entry of single parts counts whole). */
  readonly cut: string
  /** Used beyond the pattern: offcuts not kept, defects, the rest of a closed hide. */
  readonly waste: string
  /** Returned to stock (RETURN moves net of their reversals): a remnant, or a hide that came back whole. */
  readonly returned: string
  /** Still at the work order, not cut. */
  readonly left: string
}

/** A hide's area bar for one work order (MES-057; the work order record's cut log): cut + waste + returned + left = issued. */
export function hideArea(facts: {
  readonly issued: DecimalInput
  readonly returned: DecimalInput
  /** The live entries: the area each used and its pattern (null: unknown, counted as cut). */
  readonly entries: readonly { readonly areaUsed: DecimalInput; readonly pattern: DecimalInput | null }[]
}): HideArea {
  let cut = ZERO
  let waste = ZERO
  for (const entry of facts.entries) {
    const used = dec(entry.areaUsed)
    const pattern = entry.pattern === null ? used : Dec.min(used, dec(entry.pattern))
    cut = cut.plus(pattern)
    waste = waste.plus(used.minus(pattern))
  }
  const issued = dec(facts.issued)
  const returned = dec(facts.returned)
  return { issued: text(issued), cut: text(cut), waste: text(waste), returned: text(returned), left: text(Dec.max(ZERO, issued.minus(returned).minus(cut).minus(waste))) }
}
