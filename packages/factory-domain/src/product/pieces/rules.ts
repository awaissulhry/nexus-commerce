import type { Issue } from '../../core/errors'
import type { RevisionStatus } from '../styles/revisions'
import type { StyleStatus } from '../styles/rules'

/**
 * A style revision's pattern pieces (B-W2b-95; PRD-219 "Pattern piece list for nesting and grades", MES-055 "Minimum grade
 * per pattern piece"; design products.styles › Style › Files & patterns › Pattern pieces), pure: what one piece is (its
 * name as the pattern names it, how many a garment takes, the BOM line it is cut from, the lowest leather grade it may be
 * cut from, the grain, the sizes it is in), the checks of a new piece or a change, the order of the list, what a copy into
 * a new revision keeps, and what the list points out. Quality where it shows, yield where it does not: a piece that shows
 * (a front, a collar) asks a good grade, a hidden one (a facing, an under-collar) takes any.
 *
 * A piece is a part of its revision, like a BOM line: it is written only while the revision is a DRAFT and freezes with
 * it (factory-db PatternPiece, its guards in …_cutting_room_w2b_guards). The cutting table reads the minimum grade by the
 * piece's name (CutLogPiece.part = PatternPiece.name; B-W2b-103): `gradeVerdict` is that comparison.
 */

/** The grain or stretch direction a piece is laid along (factory-db PatternGrain). */
export const PATTERN_GRAINS = ['ALONG', 'ACROSS', 'BIAS', 'ANY'] as const
export type PatternGrain = (typeof PATTERN_GRAINS)[number]

export const MAX_PIECES = 200
export const MAX_PIECE_NAME = 80
/** Pieces of one kind per garment (two sleeves, four pocket bags …). */
export const MAX_PIECE_QUANTITY = 99
export const MAX_PIECE_NOTE = 500
/** Places run 10, 20, 30 …; a new piece goes after the last one. */
export const PIECE_SEQ_STEP = 10
export const MAX_PIECE_SEQ = 99_990

export interface PieceFields {
  readonly seq: number
  readonly name: string
  readonly quantity: number
  /** The BOM line of the same revision it is cut from; null: not tied to one line. */
  readonly bomLineId: string | null
  /** The lowest leather grade it may be cut from; null: any grade. Only on a piece of a leather (hide) line. */
  readonly minGradeId: string | null
  readonly grain: PatternGrain
  /** Codes of the style's range, in the range's order; empty: every size. */
  readonly sizes: readonly string[]
  readonly note: string | null
}

export interface PieceData extends PieceFields {
  readonly id: string
}

/** A change to a piece: only what it names (the place moves by the order, never here). */
export type PieceChange = Partial<Omit<PieceFields, 'seq'>>

/** A BOM line of the revision as the pieces read it: leather when its material is tracked by HIDE. */
export interface PieceLine {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly leather: boolean
}

/** A leather grade (factory-db LeatherGrade): a lower sortOrder is a better grade (A before B). */
export interface PieceGrade {
  readonly id: string
  readonly code: string
  readonly sortOrder: number
  readonly active: boolean
}

/** What a piece is checked against: the style's range, the revision's lines, the grades and the revision's other pieces. */
export interface PieceWorld {
  readonly sizes: readonly string[]
  readonly lines: ReadonlyMap<string, PieceLine>
  readonly grades: ReadonlyMap<string, PieceGrade>
  /** The revision's other pieces (a name is unique per revision). */
  readonly others: readonly Pick<PieceData, 'id' | 'name'>[]
}

export type PiecePlan = { readonly ok: true; readonly piece: PieceFields } | { readonly ok: false; readonly issues: Issue[] }

/** Why this revision's pieces cannot be changed now (a 409, before the database's own refusal), or null. */
export function piecesEditRefusal(revision: { readonly revision: number; readonly status: RevisionStatus }, styleStatus: StyleStatus): string | null {
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: its pattern pieces are frozen. Change them in a new draft revision.`
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before changing its pattern pieces.'
  return null
}

/** A name as two pieces are compared: trimmed, one space between words, any case. */
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')

/** The sizes in the range's order, each once; unknown codes stay at the end (the check names them). */
export function sizesInRangeOrder(sizes: readonly string[], range: readonly string[]): string[] {
  const unique = [...new Set(sizes.map((size) => size.trim()))]
  const known = range.filter((size) => unique.includes(size))
  return [...known, ...unique.filter((size) => !range.includes(size))]
}

/**
 * A new piece (current null) or a change to one, checked against the world: the result is the piece as it will be
 * stored, or every problem at once (paths are the field names). A grade newly set must be in use; a grade the piece
 * already has stays even once retired (the database's rule too).
 */
export function planPiece(current: PieceFields | null, change: PieceChange, world: PieceWorld, seq: number): PiecePlan {
  const issues: Issue[] = []
  const name = (change.name ?? current?.name ?? '').trim().replace(/\s+/g, ' ')
  const quantity = change.quantity ?? current?.quantity ?? 1
  const bomLineId = change.bomLineId !== undefined ? change.bomLineId : (current?.bomLineId ?? null)
  const minGradeId = change.minGradeId !== undefined ? change.minGradeId : (current?.minGradeId ?? null)
  const grain = change.grain ?? current?.grain ?? 'ANY'
  const rawSizes = change.sizes ?? current?.sizes ?? []
  const noteText = change.note !== undefined ? change.note : (current?.note ?? null)
  const note = noteText === null || noteText.trim() === '' ? null : noteText.trim()

  if (name === '') issues.push({ path: 'name', message: 'Name the piece as the pattern names it ("Front left", "Sleeve").' })
  else if (name.length > MAX_PIECE_NAME) issues.push({ path: 'name', message: `A piece's name has at most ${MAX_PIECE_NAME} characters.` })
  else if (world.others.some((other) => nameKey(other.name) === nameKey(name))) issues.push({ path: 'name', message: `This revision already has a piece called "${name}": the cutting table tells pieces apart by their names.` })

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PIECE_QUANTITY) issues.push({ path: 'quantity', message: `Pieces per garment: a whole number from 1 to ${MAX_PIECE_QUANTITY}.` })

  if (!(PATTERN_GRAINS as readonly string[]).includes(grain)) issues.push({ path: 'grain', message: 'Choose along, across, on the bias or any direction.' })

  const line = bomLineId === null ? null : (world.lines.get(bomLineId) ?? null)
  if (bomLineId !== null && line === null) issues.push({ path: 'bomLineId', message: "No such line in this revision's BOM." })

  if (minGradeId !== null) {
    const grade = world.grades.get(minGradeId)
    const lineChanged = change.bomLineId !== undefined && change.bomLineId !== (current?.bomLineId ?? null)
    const at = lineChanged && change.minGradeId === undefined ? 'bomLineId' : 'minGradeId'
    if (!grade) issues.push({ path: 'minGradeId', message: 'No such leather grade.' })
    else if (!grade.active && minGradeId !== (current?.minGradeId ?? null)) issues.push({ path: 'minGradeId', message: `Grade ${grade.code} is retired: choose a grade in use.` })
    if (bomLineId === null) issues.push({ path: at, message: 'A minimum grade is a leather rule: choose the leather line the piece is cut from first.' })
    else if (line && !line.leather) issues.push({ path: at, message: `Line ${line.seq} (${line.code}) is not leather: a minimum grade is a leather (hide) rule. Clear the grade first.` })
  }

  const sizes = sizesInRangeOrder(rawSizes, world.sizes)
  if (rawSizes.length !== new Set(rawSizes.map((size) => size.trim())).size) issues.push({ path: 'sizes', message: 'Each size once.' })
  const outside = sizes.filter((size) => size === '' || !world.sizes.includes(size))
  // A size the range lost since it was set stays on an unchanged piece (the list points it out); a change sends only the range's.
  if (outside.length > 0 && (change.sizes !== undefined || current === null)) issues.push({ path: 'sizes', message: `Not in the style's range: ${outside.join(', ')}.` })

  if (note !== null && note.length > MAX_PIECE_NOTE) issues.push({ path: 'note', message: `A note has at most ${MAX_PIECE_NOTE} characters.` })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, piece: { seq, name, quantity, bomLineId, minGradeId, grain, sizes: change.sizes !== undefined || current === null ? sizes : (current?.sizes ?? []), note } }
}

const FIELDS = ['name', 'quantity', 'bomLineId', 'minGradeId', 'grain', 'sizes', 'note'] as const
export type PieceField = (typeof FIELDS)[number]

/** The fields that differ from one piece to another. */
export function pieceChanges(a: PieceFields, b: PieceFields): PieceField[] {
  return FIELDS.filter((field) => (field === 'sizes' ? a.sizes.join('\u0000') !== b.sizes.join('\u0000') : a[field] !== b[field]))
}

/** The place after the last piece. */
export const nextPieceSeq = (pieces: readonly Pick<PieceFields, 'seq'>[]): number => pieces.reduce((top, piece) => Math.max(top, piece.seq), 0) + PIECE_SEQ_STEP

/** A new order: every piece of the revision exactly once. */
export function pieceOrderProblems(current: readonly string[], sent: readonly string[]): Issue[] {
  const issues: Issue[] = []
  if (new Set(sent).size !== sent.length) issues.push({ path: 'pieceIds', message: 'Each piece once.' })
  const missing = current.filter((id) => !sent.includes(id))
  const unknown = sent.filter((id) => !current.includes(id))
  if (missing.length > 0) issues.push({ path: 'pieceIds', message: `The order leaves out ${missing.length} piece(s): send every piece of the revision.` })
  if (unknown.length > 0) issues.push({ path: 'pieceIds', message: `${unknown.length} piece(s) are not of this revision.` })
  return issues
}

/** The moves of a new order (10, 20, 30 …): only the pieces whose place changes. */
export function pieceRenumbering(pieces: readonly Pick<PieceData, 'id' | 'seq'>[], order: readonly string[]): { readonly id: string; readonly from: number; readonly to: number }[] {
  return order.flatMap((id, index) => {
    const piece = pieces.find((entry) => entry.id === id)
    const to = (index + 1) * PIECE_SEQ_STEP
    return piece && piece.seq !== to ? [{ id, from: piece.seq, to }] : []
  })
}

// ---- copy into a new revision or a copied style -------------------------------------------------------------------------

export interface PieceCopy {
  readonly pieces: PieceData[]
  /** Pieces not copied: every size they were in left the range. */
  readonly leftOut: string[]
  /** Pieces copied without their minimum grade: the grade is retired, or their line was not copied or is no longer leather. */
  readonly gradesCleared: string[]
  /** Pieces copied without their line (the line was not copied). */
  readonly linesCleared: string[]
}

/**
 * The pieces of a frozen revision (or of a copied style's source revision) for the new DRAFT: new ids, the same places,
 * names, counts, grain and note; the line the copy made of theirs (`lines`: old line id → the new line, absent when the
 * line was left out); the sizes still in the range (a piece whose every size left the range is left out); the grade
 * only on a leather line and only while it is in use (the database refuses a retired grade newly written, and a copy
 * writes anew). What was cleared or left out is named, never silent.
 */
export function copyPieces(pieces: readonly PieceData[], lines: ReadonlyMap<string, PieceLine>, grades: ReadonlyMap<string, PieceGrade>, range: readonly string[], newId: () => string): PieceCopy {
  const leftOut: string[] = []
  const gradesCleared: string[] = []
  const linesCleared: string[] = []
  const copied = [...pieces]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((piece): PieceData[] => {
      const sizes = piece.sizes.filter((size) => range.includes(size))
      if (piece.sizes.length > 0 && sizes.length === 0) {
        leftOut.push(piece.name)
        return []
      }
      const line = piece.bomLineId === null ? null : (lines.get(piece.bomLineId) ?? null)
      if (piece.bomLineId !== null && line === null) linesCleared.push(piece.name)
      const grade = piece.minGradeId === null ? null : (grades.get(piece.minGradeId) ?? null)
      const keepGrade = piece.minGradeId !== null && line !== null && line.leather && grade !== null && grade.active
      if (piece.minGradeId !== null && !keepGrade) gradesCleared.push(piece.name)
      return [{ ...piece, id: newId(), bomLineId: line?.id ?? null, minGradeId: keepGrade ? piece.minGradeId : null, sizes: sizesInRangeOrder(sizes, range) }]
    })
  return { pieces: copied, leftOut, gradesCleared, linesCleared }
}

// ---- what the list points out ---------------------------------------------------------------------------------------------

/**
 *   SIZE_NOT_IN_RANGE        a piece names a size the style's range no longer has (a copy leaves it out)
 *   GRADE_NOT_LEATHER        a piece has a minimum grade but its line is no longer leather (the cutting table cannot check it)
 *   GRADE_RETIRED            a piece's grade is retired (it stays here; a new revision's copy leaves it off)
 *   LEATHER_LINE_NO_PIECES   a leather line no piece names: the cutting table checks no grade for it (any grade)
 */
export const PIECE_ISSUE_CODES = ['SIZE_NOT_IN_RANGE', 'GRADE_NOT_LEATHER', 'GRADE_RETIRED', 'LEATHER_LINE_NO_PIECES'] as const
export type PieceIssueCode = (typeof PIECE_ISSUE_CODES)[number]

export interface PieceIssue {
  readonly code: PieceIssueCode
  readonly pieceId: string | null
  readonly lineId: string | null
  readonly message: string
}

/** What the list points out (never blocks the release: the floor warning reads the pieces, B-W2b-103). */
export function pieceIssues(pieces: readonly PieceData[], world: Omit<PieceWorld, 'others'>): PieceIssue[] {
  const issues: PieceIssue[] = []
  for (const piece of [...pieces].sort((a, b) => a.seq - b.seq)) {
    const outside = piece.sizes.filter((size) => !world.sizes.includes(size))
    if (outside.length > 0) issues.push({ code: 'SIZE_NOT_IN_RANGE', pieceId: piece.id, lineId: null, message: `${piece.name} names ${outside.join(', ')}, no longer in the style's range.` })
    if (piece.minGradeId !== null) {
      const line = piece.bomLineId === null ? null : world.lines.get(piece.bomLineId)
      const grade = world.grades.get(piece.minGradeId)
      if (!line || !line.leather) issues.push({ code: 'GRADE_NOT_LEATHER', pieceId: piece.id, lineId: piece.bomLineId, message: `${piece.name} has a minimum grade but is not cut from a leather line.` })
      if (grade && !grade.active) issues.push({ code: 'GRADE_RETIRED', pieceId: piece.id, lineId: null, message: `${piece.name}: grade ${grade.code} is retired.` })
    }
  }
  const named = new Set(pieces.map((piece) => piece.bomLineId).filter((id): id is string => id !== null))
  for (const line of [...world.lines.values()].sort((a, b) => a.seq - b.seq)) {
    if (line.leather && !named.has(line.id)) issues.push({ code: 'LEATHER_LINE_NO_PIECES', pieceId: null, lineId: line.id, message: `Line ${line.seq} (${line.code}) is leather and no piece names it: any grade may be cut for it.` })
  }
  return issues
}

// ---- the cutting table's question (B-W2b-103) ------------------------------------------------------------------------------

/**
 * May a hide of this grade be cut for a piece with this minimum grade? OK (no minimum, or the hide's grade is the same or
 * better), BELOW (worse than the minimum), UNKNOWN (the hide has no grade on record: a W1 hide, or a grade not read).
 */
export function gradeVerdict(hide: Pick<PieceGrade, 'sortOrder'> | null, min: Pick<PieceGrade, 'sortOrder'> | null): 'OK' | 'BELOW' | 'UNKNOWN' {
  if (min === null) return 'OK'
  if (hide === null) return 'UNKNOWN'
  return hide.sortOrder <= min.sortOrder ? 'OK' : 'BELOW'
}

/** The grades a piece may be cut from: the minimum and every better one, in order (all of them without a minimum). */
export function gradesAllowed<G extends PieceGrade>(grades: readonly G[], min: Pick<PieceGrade, 'sortOrder'> | null): G[] {
  return [...grades].filter((grade) => min === null || grade.sortOrder <= min.sortOrder).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
}
