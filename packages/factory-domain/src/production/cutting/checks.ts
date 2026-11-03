import { shadeLotKey, shadeLotsOf, shadeLotWords, shadeRefusal, type ShadeFacts, type ShadeRule } from '../../inventory/reservations/shade'
import { gradeVerdict } from '../../product/pieces/rules'
import { Dec, type DecimalInput } from '../../tax/decimal'
import type { CutRefusal } from './rules'

/**
 * The cutting table's leather checks (B-W2b-103; MES-053, MES-055, MES-060, MES-063, MES-064; design floor.hidecut "Check the
 * hide": "W2b: wrong hide (reserved article, colour, lot, grade) and thickness against the style spec as warnings with a
 * reason to override", pop-up hidecut.override "What differs, a reason tile, the cutting manager's PIN"), pure. Before the
 * knife the table looks at the hide against the work order and says what differs. A warning stops on the card; "Cut anyway"
 * is a lead's PIN (a worker of the site holding production.cut.override, never the cutter) and a reason tile. The entry then
 * records which warnings stood (CutLog.overrides), the lead and the reason, written with it (append-only: never later).
 *
 *   SHADE       the shade rule of the site (inventory/reservations/shade shadeRuleFor; Q18's default ORDER, one shade lot per
 *               order): under ORDER the hide's shade lot against what the work order holds and has reserved of the leather
 *               (B-W2b-100's shadeRefusal, the same rule the pick refuses by; the table only warns: its scan issues without
 *               the pick's check); under GARMENT a single part that completes a garment against the shade lot its other
 *               parts were cut from; OFF never.
 *   WRONG_HIDE  the work order's own ACTIVE leather reservations of the article (B-W2a-11): a hide reserved by name, or an
 *               area of one lot. A hide that is neither, while a reservation still waits, is the wrong hide: the warning says
 *               what differs (colour, lot, grade). No reservation: nothing to compare (W1: the cutter's eye).
 *   THICKNESS   the thickness the cutter measured at the table, else the one recorded on the hide (receipt or incoming),
 *               against the leather article's range (Item.thicknessMinMm/MaxMm, the spec the style's BOM names). Unknown
 *               thickness or no range: no warning (said as information). Overriding a thickness read off the hide's record
 *               takes a measure at the table first: the entry records the thickness the lead saw.
 *   GRADE       the pieces this cut makes (pattern pieces of the work order's revision, B-W2b-95: by the BOM line they are
 *               cut from or by name, in the cell's size) against the hide's grade: gradeVerdict (product/pieces) BELOW, or
 *               UNKNOWN for a hide with no grade when a piece asks one.
 * A warning a lead passed for a hide and a work order stays passed for that hide's later entries of the work order (while
 * the entry that recorded it is live); a new kind of warning asks again. The photo (MES-060) is not a warning: it is
 * taken when the site asks it (no setting yet: optional everywhere) and stored with the hide and the entry.
 *
 * Knife or press (Q17's default: either): the checks are the same.
 */

/** The warnings, in the database's CutOverrideKind order (the order an entry records them in). */
export const CUT_WARNING_KINDS = ['SHADE', 'WRONG_HIDE', 'THICKNESS', 'GRADE'] as const
export type CutWarningKind = (typeof CUT_WARNING_KINDS)[number]

/** The finer reason of a warning (the floor's words per code). */
export const CUT_WARNING_CODES = ['SHADE_LOT', 'OUT_OF_SHADE', 'GARMENT_SHADE', 'NOT_RESERVED', 'RESERVED_LOT', 'THIN', 'THICK', 'BELOW', 'UNGRADED'] as const
export type CutWarningCode = (typeof CUT_WARNING_CODES)[number]

/** What differs between a hide and the reservations it is not one of. */
export const WRONG_HIDE_DIFFERENCES = ['COLOUR', 'LOT', 'GRADE'] as const
export type WrongHideDifference = (typeof WRONG_HIDE_DIFFERENCES)[number]

export interface ShadeLotRef {
  readonly lotCode: string
  readonly shadeLabel: string | null
}

export interface CutWarning {
  readonly kind: CutWarningKind
  readonly code: CutWarningCode
  /** In words (English; the floor composes its own language from the facts below). */
  readonly message: string
  /** SHADE: the shade lots the work order (or the garment) is cut from, and the hide's. */
  readonly shade?: { readonly rule: ShadeRule; readonly cutFrom: ShadeLotRef[]; readonly hide: ShadeLotRef & { readonly outOfShade: boolean }; readonly cell: string | null } | undefined
  /** WRONG_HIDE: the hides and lots reserved, and what differs. */
  readonly wrongHide?:
    | {
        readonly reservedHides: { readonly code: string; readonly lotCode: string; readonly grade: string | null }[]
        readonly reservedLots: string[]
        readonly differs: WrongHideDifference[]
        readonly hide: { readonly lotCode: string; readonly grade: string | null }
      }
    | undefined
  /** THICKNESS: the thickness read, where from, the range. */
  readonly thickness?: { readonly valueMm: string; readonly source: ThicknessSource; readonly minMm: string | null; readonly maxMm: string | null } | undefined
  /** GRADE: the hide's grade and the pieces that ask a better one. */
  readonly grade?: { readonly hideGrade: string | null; readonly pieces: { readonly name: string; readonly minGrade: string }[] } | undefined
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)
const list = (words: readonly string[], max = 5) => (words.length <= max ? words.join(', ') : `${words.slice(0, max).join(', ')} and ${words.length - max} more`)
const norm = (text: string | null | undefined): string => text?.trim().toUpperCase() ?? ''
const LEAD = 'or a lead lets it be cut anyway with their PIN and a reason'

// ---- SHADE -----------------------------------------------------------------------------------------------------------------------

const lotRef = (facts: Pick<ShadeFacts, 'lotCode' | 'shadeLabel'>): ShadeLotRef => ({ lotCode: facts.lotCode, shadeLabel: facts.shadeLabel?.trim() || null })

/**
 * ORDER: the hide against what the work order holds (issued less returned above 0) and has reserved of the leather, by the
 * pick's own rule (shadeRefusal): out of shade, or another shade lot. Null: the same lot, the first hide, or another rule.
 */
export function orderShadeWarning(rule: ShadeRule, workOrderNumber: string, held: readonly ShadeFacts[], hide: ShadeFacts): CutWarning | null {
  const refusal = shadeRefusal(rule, `work order ${workOrderNumber}`, held, hide)
  if (!refusal) return null
  const cutFrom = shadeLotsOf(held.filter((other) => other.hideId !== hide.hideId)).map((lot) => lotRef(lot.first))
  const shade = { rule, cutFrom, hide: { ...lotRef(hide), outOfShade: hide.outOfShade }, cell: null }
  if (refusal.code === 'OUT_OF_SHADE') {
    return { kind: 'SHADE', code: 'OUT_OF_SHADE', message: `Hide ${hide.hideCode} is out of shade (${shadeLotWords(hide)}): work order ${workOrderNumber} asks one shade lot. Take another hide, ${LEAD}.`, shade }
  }
  return {
    kind: 'SHADE',
    code: 'SHADE_LOT',
    message: `Work order ${workOrderNumber} is cut from ${cutFrom.map((lot) => shadeLotWords(lot)).join('; ')}; hide ${hide.hideCode} is ${shadeLotWords(hide)}. One shade lot per order: take a hide of the same shade lot, ${LEAD}.`,
    shade,
  }
}

/** A live piece row of the work order with the shade facts of its entry's hide, oldest entry first. */
export interface ShadedPiece {
  readonly cellId: string
  readonly part: string
  readonly pieces: number
  readonly shade: ShadeFacts
}

/**
 * GARMENT (one shade lot per garment): single parts that complete a garment of a cell (their part has fewer pieces cut than
 * another part of the cell) against the shade lot of the newest piece of the parts ahead (the garment's other parts). Whole
 * sets come from one hide, so they never mix; a part that starts a new garment has nothing to match.
 */
export function garmentShadeWarning(
  rule: ShadeRule,
  cells: ReadonlyMap<string, { readonly label: string; readonly parts: readonly string[] }>,
  live: readonly ShadedPiece[],
  parts: readonly { readonly cellId: string; readonly part: string }[],
  hide: ShadeFacts,
): CutWarning | null {
  if (rule !== 'GARMENT') return null
  const key = shadeLotKey(hide)
  for (const { cellId, part } of parts) {
    const cell = cells.get(cellId)
    const rows = live.filter((row) => row.cellId === cellId)
    const counts = new Map<string, number>((cell?.parts ?? []).map((name) => [name, 0]))
    for (const row of rows) counts.set(row.part, (counts.get(row.part) ?? 0) + row.pieces)
    const mine = counts.get(part) ?? 0
    const ahead = [...counts.entries()].filter(([, count]) => count > mine).map(([name]) => name)
    if (ahead.length === 0) continue
    const theirs = [...rows].reverse().find((row) => ahead.includes(row.part))
    if (!theirs || shadeLotKey(theirs.shade) === key) continue
    const label = cell?.label ?? ''
    return {
      kind: 'SHADE',
      code: 'GARMENT_SHADE',
      message: `Garment ${label}: its ${list(ahead.sort())} ${plural(ahead.length, 'is', 'are')} from ${shadeLotWords(theirs.shade)}; hide ${hide.hideCode} is ${shadeLotWords(hide)}. One shade lot per garment: cut its ${part} from a hide of the same shade lot, ${LEAD}.`,
      shade: { rule, cutFrom: [lotRef(theirs.shade)], hide: { ...lotRef(hide), outOfShade: hide.outOfShade }, cell: label },
    }
  }
  return null
}

// ---- WRONG_HIDE ------------------------------------------------------------------------------------------------------------------

/** One of the work order's own ACTIVE leather reservations of the hide's article (a hide by name, or an area of a lot or any). */
export interface ReservedLeather {
  readonly kind: 'HIDE' | 'AREA'
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly itemColourId: string | null
  /** The reserved hide's grade (its record's code, else its text); null for an area or an ungraded hide. */
  readonly grade: string | null
}

export interface HideIdentity {
  readonly id: string
  readonly code: string
  readonly lotId: string
  readonly lotCode: string
  readonly itemColourId: string | null
  readonly grade: string | null
}

/**
 * The hide against the work order's own ACTIVE reservations of its article: its own hide reservation or an area it fits (of
 * any lot, or of its lot, in its colour) → fine; hides reserved by name still waiting → NOT_RESERVED (what differs: colour,
 * lot, grade); areas of other lots only → RESERVED_LOT. No reservation: null.
 */
export function wrongHideWarning(workOrderNumber: string, reserved: readonly ReservedLeather[], hide: HideIdentity): CutWarning | null {
  if (reserved.some((row) => row.kind === 'HIDE' && row.hideId === hide.id)) return null
  const areas = reserved.filter((row) => row.kind === 'AREA')
  if (areas.some((row) => row.itemColourId === hide.itemColourId && (row.lotId === null || row.lotId === hide.lotId))) return null
  const hides = reserved.filter((row) => row.kind === 'HIDE')
  const lotCodes = (rows: readonly ReservedLeather[]) => [...new Set(rows.flatMap((row) => (row.lotCode ? [row.lotCode] : [])))].sort()
  if (hides.length > 0) {
    const differs: WrongHideDifference[] = []
    if (!hides.some((row) => row.itemColourId === hide.itemColourId)) differs.push('COLOUR')
    if (!hides.some((row) => row.lotId === hide.lotId)) differs.push('LOT')
    if (!hides.some((row) => norm(row.grade) === norm(hide.grade))) differs.push('GRADE')
    const grades = [...new Set(hides.flatMap((row) => (row.grade?.trim() ? [row.grade.trim()] : [])))].sort()
    const what = [
      ...(differs.includes('COLOUR') ? ['another colour'] : []),
      ...(differs.includes('LOT') ? [`lot ${hide.lotCode}, not ${list(lotCodes(hides))}`] : []),
      ...(differs.includes('GRADE') ? [`grade ${hide.grade?.trim() || 'none'}, not ${grades.length > 0 ? list(grades) : 'ungraded'}`] : []),
    ]
    const codes = hides.flatMap((row) => (row.hideCode ? [row.hideCode] : [])).sort()
    return {
      kind: 'WRONG_HIDE',
      code: 'NOT_RESERVED',
      message: `Work order ${workOrderNumber} has ${hides.length} ${plural(hides.length, 'hide', 'hides')} reserved for it (${list(codes)}); hide ${hide.code} is not one of them${what.length > 0 ? ` (${what.join('; ')})` : ''}. Take a reserved hide, ${LEAD}.`,
      wrongHide: { reservedHides: hides.map((row) => ({ code: row.hideCode ?? '', lotCode: row.lotCode ?? '', grade: row.grade?.trim() || null })).sort((a, b) => (a.code < b.code ? -1 : 1)), reservedLots: lotCodes(hides), differs, hide: { lotCode: hide.lotCode, grade: hide.grade?.trim() || null } },
    }
  }
  if (areas.length > 0) {
    const differs: WrongHideDifference[] = [...(areas.some((row) => row.itemColourId === hide.itemColourId) ? [] : ['COLOUR' as const]), 'LOT']
    const lots = lotCodes(areas)
    return {
      kind: 'WRONG_HIDE',
      code: 'RESERVED_LOT',
      message: `Work order ${workOrderNumber} has its leather reserved from ${plural(lots.length, 'lot', 'lots')} ${list(lots)}${differs.includes('COLOUR') ? ' in another colour' : ''}; hide ${hide.code} is of lot ${hide.lotCode}. Take a hide of the reserved lot, ${LEAD}.`,
      wrongHide: { reservedHides: [], reservedLots: lots, differs, hide: { lotCode: hide.lotCode, grade: hide.grade?.trim() || null } },
    }
  }
  return null
}

// ---- THICKNESS -------------------------------------------------------------------------------------------------------------------

export type ThicknessSource = 'TABLE' | 'HIDE'
export type ThicknessVerdict = 'OK' | 'THIN' | 'THICK' | 'UNKNOWN' | 'NO_SPEC'

export interface ThicknessCheck {
  readonly verdict: ThicknessVerdict
  /** "1.20": the thickness read, two decimals; null when none is known. */
  readonly valueMm: string | null
  readonly source: ThicknessSource | null
  readonly minMm: string | null
  readonly maxMm: string | null
}

const mm = (value: DecimalInput | null | undefined): string | null => (value === null || value === undefined ? null : new Dec(value).toFixed(2))

/** The thickness the table reads (measured at the table, else recorded on the hide) against the article's range. */
export function thicknessCheck(facts: { readonly minMm: DecimalInput | null; readonly maxMm: DecimalInput | null; readonly recordedMm: DecimalInput | null; readonly measuredMm: DecimalInput | null }): ThicknessCheck {
  const source: ThicknessSource | null = facts.measuredMm !== null ? 'TABLE' : facts.recordedMm !== null ? 'HIDE' : null
  const value = facts.measuredMm ?? facts.recordedMm
  const base = { valueMm: mm(value), source, minMm: mm(facts.minMm), maxMm: mm(facts.maxMm) }
  if (facts.minMm === null && facts.maxMm === null) return { verdict: 'NO_SPEC', ...base }
  if (value === null) return { verdict: 'UNKNOWN', ...base }
  if (facts.minMm !== null && new Dec(value).lt(new Dec(facts.minMm))) return { verdict: 'THIN', ...base }
  if (facts.maxMm !== null && new Dec(value).gt(new Dec(facts.maxMm))) return { verdict: 'THICK', ...base }
  return { verdict: 'OK', ...base }
}

/** "1.10–1.30 mm", "at least 1.10 mm", "at most 1.30 mm". */
export function rangeWords(check: Pick<ThicknessCheck, 'minMm' | 'maxMm'>): string {
  if (check.minMm !== null && check.maxMm !== null) return `${check.minMm}–${check.maxMm} mm`
  return check.minMm !== null ? `at least ${check.minMm} mm` : `at most ${check.maxMm} mm`
}

export function thicknessWarning(check: ThicknessCheck, hideCode: string, itemCode: string): CutWarning | null {
  if ((check.verdict !== 'THIN' && check.verdict !== 'THICK') || check.valueMm === null || check.source === null) return null
  const where = check.source === 'TABLE' ? 'measured at the table' : 'as recorded on the hide'
  return {
    kind: 'THICKNESS',
    code: check.verdict,
    message: `Hide ${hideCode} is ${check.valueMm} mm (${where}); leather ${itemCode} is specified ${rangeWords(check)}. Take another hide, ${LEAD}${check.source === 'HIDE' ? ' once the thickness is measured at the table' : ''}.`,
    thickness: { valueMm: check.valueMm, source: check.source, minMm: check.minMm, maxMm: check.maxMm },
  }
}

// ---- GRADE -----------------------------------------------------------------------------------------------------------------------

export interface GradeRef {
  readonly id: string
  readonly code: string
  readonly sortOrder: number
}

/** A pattern piece of the work order's revision, as the table reads it. */
export interface PieceRef {
  readonly name: string
  /** The BOM line it is cut from; null: not tied to one line (matched by its name only). */
  readonly bomLineId: string | null
  readonly minGrade: GradeRef | null
  /** The sizes it is in; empty: every size. */
  readonly sizes: readonly string[]
}

/** One planned row of the hide's material in a cell: the BOM line and the part it makes (partOf(placement, code)). */
export interface PlannedLine {
  readonly cellId: string
  readonly bomLineId: string
  readonly part: string
}

/**
 * The pattern pieces a cut makes: per cell, the pieces of each part it logs (whole sets: every part of the hide's material in
 * the cell) — a piece cut from the part's BOM line, or named as the part (any case) — that are in the cell's size. Once each.
 */
export function piecesOfCut(pieces: readonly PieceRef[], planned: readonly PlannedLine[], cut: readonly { readonly cellId: string; readonly size: string; readonly parts: readonly string[] }[]): PieceRef[] {
  const found = new Map<string, PieceRef>()
  for (const { cellId, size, parts } of cut) {
    const lines = planned.filter((row) => row.cellId === cellId)
    for (const part of parts) {
      const lineIds = new Set(lines.filter((row) => row.part === part).map((row) => row.bomLineId))
      for (const piece of pieces) {
        const ofPart = (piece.bomLineId !== null && lineIds.has(piece.bomLineId)) || norm(piece.name) === norm(part)
        if (ofPart && (piece.sizes.length === 0 || piece.sizes.includes(size))) found.set(piece.name, piece)
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The pieces below the hide's grade (gradeVerdict BELOW), or asking a grade of a hide with none (UNKNOWN). */
export function gradeWarning(hideCode: string, hideGrade: GradeRef | null, pieces: readonly PieceRef[]): CutWarning | null {
  const asking = pieces.filter((piece) => piece.minGrade !== null && gradeVerdict(hideGrade, piece.minGrade) !== 'OK')
  if (asking.length === 0) return null
  const rows = asking.map((piece) => ({ name: piece.name, minGrade: piece.minGrade!.code }))
  const asks = rows.map((row) => `${row.name} asks ${row.minGrade} or better`).join('; ')
  if (hideGrade === null) {
    return { kind: 'GRADE', code: 'UNGRADED', message: `Hide ${hideCode} has no grade; ${asks}. A lead looks at the hide and lets it be cut anyway with their PIN and a reason.`, grade: { hideGrade: null, pieces: rows } }
  }
  return { kind: 'GRADE', code: 'BELOW', message: `Hide ${hideCode} is grade ${hideGrade.code}; ${asks}. Cut other pieces from it, ${LEAD}.`, grade: { hideGrade: hideGrade.code, pieces: rows } }
}

// ---- the warnings that stand, and "Cut anyway" -----------------------------------------------------------------------------------

/** The warnings a lead has not passed yet for this hide and work order (`passed`: the kinds its live entries recorded). */
export function standingWarnings(warnings: readonly CutWarning[], passed: readonly CutWarningKind[]): CutWarning[] {
  return warnings.filter((warning) => !passed.includes(warning.kind))
}

/** The kinds of these warnings, each once, in the database's order: what the entry records. */
export function kindsOf(warnings: readonly { readonly kind: CutWarningKind }[]): CutWarningKind[] {
  return CUT_WARNING_KINDS.filter((kind) => warnings.some((warning) => warning.kind === kind))
}

/** What a cut refused by standing warnings answers: one refusal, the warnings' words joined; the floor's queue keeps it. */
export function warningsRefusal(standing: readonly CutWarning[], signed: readonly CutWarningKind[] | null): CutRefusal & { readonly fix: string; readonly final: boolean } {
  const first = signed === null ? 'This hide has warnings' : 'The lead signed for other warnings than stand now'
  return {
    code: 'CUT_WARNING',
    message: `${first}: ${standing.map((warning) => warning.message).join(' ')}`,
    fix: 'Take another hide, or a lead signs "Cut anyway" on this tablet (online) with their PIN and a reason: the cut is then recorded.',
    final: true,
  }
}

/** The reason tiles of "Cut anyway" (design hidecut.override "a reason tile"): a fixed list, as the floor's other overrides. */
export const CUT_OVERRIDE_REASON_CODES = ['CHECKED_BY_EYE', 'HIDDEN_PARTS', 'NO_OTHER_HIDE', 'OFFICE_AGREED', 'OTHER'] as const
export type CutOverrideReasonCode = (typeof CUT_OVERRIDE_REASON_CODES)[number]

export const CUT_OVERRIDE_REASONS: readonly { readonly code: CutOverrideReasonCode; readonly label: { readonly it: string; readonly en: string }; readonly needsNote: boolean }[] = Object.freeze([
  { code: 'CHECKED_BY_EYE', label: { it: 'Controllata a vista: va bene', en: 'Checked by eye: it is fine' }, needsNote: false },
  { code: 'HIDDEN_PARTS', label: { it: 'Per parti interne o nascoste', en: 'For inner or hidden parts' }, needsNote: false },
  { code: 'NO_OTHER_HIDE', label: { it: "Nessun'altra pelle disponibile", en: 'No other hide available' }, needsNote: false },
  { code: 'OFFICE_AGREED', label: { it: "D'accordo con l'ufficio", en: 'Agreed with the office' }, needsNote: false },
  { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
])

/** The reason the entry records: the tile's English words, and the note when there is one. */
export function cutOverrideReasonText(code: CutOverrideReasonCode, note: string | null): string {
  const tile = CUT_OVERRIDE_REASONS.find((reason) => reason.code === code)!
  return note ? `${tile.label.en}: ${note}` : tile.label.en
}

export const leadPinWrong = (): CutRefusal => ({ code: 'LEAD_PIN_WRONG', message: "The lead's badge or PIN is wrong, or they are locked for a few minutes after too many wrong PINs. The lead tries again, or another lead signs." })

/** Why a lead's "Cut anyway" is refused (the PIN was checked first, by the API), or null. */
export function cutOverrideRefusal(facts: { readonly leadId: string; readonly cutterId: string; readonly mayOverride: boolean; readonly reasonCode: CutOverrideReasonCode; readonly note: string | null }): CutRefusal | null {
  if (facts.leadId === facts.cutterId) return { code: 'LEAD_IS_CUTTER', message: 'The lead who lets a hide be cut anyway is another person than the cutter (four eyes). Ask another lead to sign.' }
  if (!facts.mayOverride) return { code: 'NOT_A_LEAD', message: 'This person may not let a hide be cut anyway (production.cut.override). Ask a lead of this site to sign.' }
  const tile = CUT_OVERRIDE_REASONS.find((reason) => reason.code === facts.reasonCode)
  if (tile?.needsNote && !facts.note) return { code: 'LEAD_NOTE_MISSING', message: 'With "Other" the lead says why in a few words, then signs again.' }
  return null
}

/** A thickness typed at the table: above 0 and below 100 mm, at most two decimals (the database's own check). */
export function measuredThicknessProblem(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value.trim())) return 'The thickness is in millimetres, like 1.25 (at most two decimals).'
  const number = new Dec(value.trim())
  return number.lte(0) || number.gte(100) ? 'The thickness is above 0 and below 100 mm.' : null
}
