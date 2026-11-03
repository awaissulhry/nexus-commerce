import { MAX_PIECE_NAME, MAX_PIECE_NOTE, MAX_PIECE_QUANTITY, nameKey, PATTERN_GRAINS, type PatternGrain, type PieceIssueCode } from '@nexus/factory-domain/product/pieces/rules'
import type { Piece, PieceGradeRow, PieceLineRow, PiecePatch, PiecesView } from './api'

/**
 * The Pattern pieces section's rules, pure (B-W2b-95; SCR-271; design products.styles › Style › Files & patterns ›
 * Pattern pieces): why the list cannot be changed now, a line and a grade in words, the size range read as people read it,
 * the checks a cell or the piece dialog makes before it sends (the same rules as the API, in this app's words), what a new
 * line does to a graded piece, what the list points out, the selection's held reasons and the order's moves. The view and
 * the container use these; the tests hold them.
 */

/** The section's read: like the studio's other parts, each loads and fails alone. */
export type PiecesPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: PiecesView } | { status: 'error'; problem: string }

export const PIECE_CELLS = ['name', 'quantity', 'bomLineId', 'minGradeId', 'grain', 'sizes', 'note'] as const
export type PieceCell = (typeof PIECE_CELLS)[number]

/** A cell's save: saving (sent), waiting (offline, queued on this page), refused (with our words); nothing once saved. */
export interface PieceMark {
  state: 'saving' | 'waiting' | 'refused'
  /** The value typed, shown until the server answers. */
  value?: unknown
  /** A message key (refused). */
  problem?: string
}

export const markKey = (pieceId: string, cell: PieceCell): string => `${pieceId}:${cell}`

/** The section's pop-ups: a piece (add, or every field of one: the phone's and Enter's way), the sizes of one, remove, a grade for several. */
export type PiecesDialog = { kind: 'piece'; pieceId: string | null } | { kind: 'sizes'; pieceId: string } | { kind: 'remove'; ids: string[] } | { kind: 'grade'; ids: string[] }

export interface PiecesNotice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

export interface PiecesModel {
  part: PiecesPart
  marks: Record<string, PieceMark>
  selected: string[]
  dialog: PiecesDialog | null
  /** The browser says it is offline: cell edits wait on this page. */
  offline: boolean
  notice: PiecesNotice | null
  busy: boolean
  /** Design cases: the piece dialog already filled. */
  draft?: PieceDraft
  /** Design cases: the row with the focus. */
  focusRow?: number
}

export interface PiecesActions {
  onRetry?: () => void
  onCell?: (piece: Piece, cell: PieceCell, value: unknown) => void
  onSelect?: (ids: string[]) => void
  onDialog?: (dialog: PiecesDialog | null) => void
  onSave?: (pieceId: string | null, patch: PiecePatch) => Promise<boolean>
  onRemove?: (ids: string[]) => Promise<boolean>
  onBulkGrade?: (ids: string[], minGradeId: string | null) => Promise<boolean>
  onMove?: (pieceId: string, delta: -1 | 1) => void
  onDismissNotice?: () => void
}

/** The empty model (nothing read yet). */
export const NO_PIECES: PiecesModel = { part: { status: 'idle' }, marks: {}, selected: [], dialog: null, offline: false, notice: null, busy: false }

// ---- who may change the list now ----------------------------------------------------------------------------------------

/** Why the list is read only now (a message key), or null: no edit right, a frozen revision, an archived style. */
export function piecesHeld(view: Pick<PiecesView, 'editable' | 'revision' | 'style'>, canManage: boolean): string | null {
  if (!canManage) return 'pieces.held.noManage'
  if (view.style.status === 'ARCHIVED') return 'held.archived'
  if (view.revision.status !== 'DRAFT') return 'pieces.held.frozen'
  return view.editable ? null : 'pieces.held.frozen'
}

// ---- words ----------------------------------------------------------------------------------------------------------------

export const lineLabel = (line: Pick<PieceLineRow, 'seq' | 'code'>): string => `${line.seq} · ${line.code}`

export const gradeName = (grade: Pick<PieceGradeRow, 'labelIt' | 'labelEn'>, locale: string): string => (locale.startsWith('it') ? grade.labelIt : grade.labelEn)

/**
 * The sizes as people read them: none = every size; a run of the range = "52–54"; otherwise the codes ("50, 54"). A code
 * the range no longer has stays named at the end.
 */
export function sizesText(sizes: readonly string[], range: readonly string[]): { key: string; params?: Record<string, string> } {
  if (sizes.length === 0) return { key: 'pieces.sizes.all' }
  const inRange = range.filter((size) => sizes.includes(size))
  const outside = sizes.filter((size) => !range.includes(size))
  const first = range.indexOf(inRange[0] ?? '')
  const run = inRange.length >= 3 && outside.length === 0 && inRange.every((size, index) => range[first + index] === size)
  if (run) return { key: 'pieces.sizes.run', params: { from: inRange[0]!, to: inRange[inRange.length - 1]! } }
  return { key: 'pieces.sizes.some', params: { sizes: [...inRange, ...outside].join(', ') } }
}

/** The pieces and the pieces per garment (the toolbar's count). */
export function piecesCount(view: Pick<PiecesView, 'pieces'>): { pieces: number; perGarment: number } {
  return { pieces: view.pieces.length, perGarment: view.pieces.reduce((sum, piece) => sum + piece.quantity, 0) }
}

/** What the list points out, in this app's words (the API's codes, never its English). */
export function issueWords(issue: PiecesView['issues'][number], view: Pick<PiecesView, 'pieces' | 'lines' | 'grades' | 'sizes'>): { key: string; params: Record<string, string> } {
  const piece = issue.pieceId ? view.pieces.find((entry) => entry.id === issue.pieceId) : undefined
  const line = issue.lineId ? view.lines.find((entry) => entry.id === issue.lineId) : undefined
  const code: PieceIssueCode = issue.code
  const params: Record<string, string> = { piece: piece?.name ?? '', line: line ? lineLabel(line) : '' }
  if (code === 'SIZE_NOT_IN_RANGE' && piece) params.sizes = piece.sizes.filter((size) => !view.sizes.some((entry) => entry.code === size)).join(', ')
  if (code === 'GRADE_RETIRED' && piece) params.grade = view.grades.find((grade) => grade.id === piece.minGradeId)?.code ?? ''
  return { key: `pieces.issue.${code}`, params }
}

// ---- checks before a save -------------------------------------------------------------------------------------------------

/** The pieces per garment a cell or field typed, or null when it is not a whole number from 1 to 99. */
export function quantityOf(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (!/^\d{1,2}$/.test(text)) return null
  const number = Number(text)
  return number >= 1 && number <= MAX_PIECE_QUANTITY ? number : null
}

/** Why a name cannot be saved (a message key), or null. */
export function nameProblem(name: string, pieces: readonly Pick<Piece, 'id' | 'name'>[], pieceId: string | null): string | null {
  const tidy = name.trim()
  if (tidy === '') return 'pieces.problem.nameBlank'
  if (tidy.length > MAX_PIECE_NAME) return 'pieces.problem.nameLong'
  if (pieces.some((other) => other.id !== pieceId && nameKey(other.name) === nameKey(tidy))) return 'pieces.problem.nameTaken'
  return null
}

const isLeather = (view: Pick<PiecesView, 'lines'>, lineId: string | null): boolean => lineId !== null && view.lines.some((line) => line.id === lineId && line.leather)

/**
 * A cell's value as the write sends it, or why not (a message key). A new line that is not leather takes the piece's grade
 * off in the same write (said in a notice, never silent): the grade is a hide rule.
 */
export function cellPatch(piece: Piece, cell: PieceCell, value: unknown, view: Pick<PiecesView, 'pieces' | 'lines' | 'grades'>): { patch: PiecePatch; cleared: boolean } | { problem: string } {
  switch (cell) {
    case 'name': {
      const problem = nameProblem(String(value ?? ''), view.pieces, piece.id)
      return problem ? { problem } : { patch: { name: String(value).trim().replace(/\s+/g, ' ') }, cleared: false }
    }
    case 'quantity': {
      const quantity = quantityOf(value)
      return quantity === null ? { problem: 'pieces.problem.quantity' } : { patch: { quantity }, cleared: false }
    }
    case 'bomLineId': {
      const lineId = value === '' || value === null ? null : String(value)
      const clear = piece.minGradeId !== null && !isLeather(view, lineId)
      return { patch: clear ? { bomLineId: lineId, minGradeId: null } : { bomLineId: lineId }, cleared: clear }
    }
    case 'minGradeId': {
      const gradeId = value === '' || value === null ? null : String(value)
      if (gradeId !== null && !isLeather(view, piece.bomLineId)) return { problem: 'pieces.problem.gradeNotLeather' }
      return { patch: { minGradeId: gradeId }, cleared: false }
    }
    case 'grain':
      return (PATTERN_GRAINS as readonly string[]).includes(String(value)) ? { patch: { grain: value as PatternGrain }, cleared: false } : { problem: 'pieces.problem.grain' }
    case 'sizes':
      return { patch: { sizes: Array.isArray(value) ? value.map(String) : [] }, cleared: false }
    case 'note': {
      const note = String(value ?? '').trim()
      return note.length > MAX_PIECE_NOTE ? { problem: 'pieces.problem.noteLong' } : { patch: { note: note === '' ? null : note }, cleared: false }
    }
  }
}

/** The value a cell shows: the one typed while it saves or waits, else the piece's. */
export function shownValue(piece: Piece, cell: PieceCell, marks: Readonly<Record<string, PieceMark>>): unknown {
  const mark = marks[markKey(piece.id, cell)]
  return mark && mark.state !== 'refused' && mark.value !== undefined ? mark.value : piece[cell]
}

// ---- the piece dialog -----------------------------------------------------------------------------------------------------

export interface PieceDraft {
  name: string
  quantity: string
  bomLineId: string
  minGradeId: string
  grain: PatternGrain
  sizes: string[]
  note: string
}

export function draftOf(piece: Piece | null): PieceDraft {
  return {
    name: piece?.name ?? '',
    quantity: String(piece?.quantity ?? 1),
    bomLineId: piece?.bomLineId ?? '',
    minGradeId: piece?.minGradeId ?? '',
    grain: piece?.grain ?? 'ANY',
    sizes: [...(piece?.sizes ?? [])],
    note: piece?.note ?? '',
  }
}

/** The dialog's problems by field (message keys); empty: it may be saved. */
export function draftProblems(draft: PieceDraft, view: Pick<PiecesView, 'pieces' | 'lines'>, pieceId: string | null): Partial<Record<PieceCell, string>> {
  const problems: Partial<Record<PieceCell, string>> = {}
  const name = nameProblem(draft.name, view.pieces, pieceId)
  if (name) problems.name = name
  if (quantityOf(draft.quantity) === null) problems.quantity = 'pieces.problem.quantity'
  if (draft.minGradeId !== '' && !isLeather(view, draft.bomLineId || null)) problems.minGradeId = 'pieces.problem.gradeNotLeather'
  if (draft.note.trim().length > MAX_PIECE_NOTE) problems.note = 'pieces.problem.noteLong'
  return problems
}

/** What the dialog sends: a new piece whole, a change only what differs from the piece. */
export function draftPatch(draft: PieceDraft, piece: Piece | null): PiecePatch {
  const next: Required<PiecePatch> = {
    name: draft.name.trim().replace(/\s+/g, ' '),
    quantity: quantityOf(draft.quantity) ?? 1,
    bomLineId: draft.bomLineId || null,
    minGradeId: draft.minGradeId || null,
    grain: draft.grain,
    sizes: [...draft.sizes],
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  }
  if (!piece) return next
  const patch: PiecePatch = {}
  if (next.name !== piece.name) patch.name = next.name
  if (next.quantity !== piece.quantity) patch.quantity = next.quantity
  if (next.bomLineId !== piece.bomLineId) patch.bomLineId = next.bomLineId
  if (next.minGradeId !== piece.minGradeId) patch.minGradeId = next.minGradeId
  if (next.grain !== piece.grain) patch.grain = next.grain
  if (next.sizes.join(',') !== piece.sizes.join(',')) patch.sizes = next.sizes
  if (next.note !== piece.note) patch.note = next.note
  return patch
}

/** The sizes ticked, in the range's order ("only these sizes"; every size is the empty list, chosen on its own). */
export function pickedSizes(picked: readonly string[], range: readonly string[]): string[] {
  return range.filter((size) => picked.includes(size))
}

// ---- the selection and the order ------------------------------------------------------------------------------------------

/** Why "Minimum grade…" for the selection is held (a key with the pieces named), or null. */
export function bulkGradeHeld(view: Pick<PiecesView, 'pieces' | 'lines'>, ids: readonly string[]): { key: string; params?: Record<string, string> } | null {
  const notLeather = view.pieces.filter((piece) => ids.includes(piece.id) && !isLeather(view, piece.bomLineId))
  if (notLeather.length > 0) return { key: 'pieces.held.bulkNotLeather', params: { pieces: notLeather.map((piece) => piece.name).join(', ') } }
  return null
}

/** The order after moving one piece up or down, or null at the ends. */
export function movedOrder(pieces: readonly Pick<Piece, 'id' | 'seq'>[], pieceId: string, delta: -1 | 1): string[] | null {
  const ordered = [...pieces].sort((a, b) => a.seq - b.seq).map((piece) => piece.id)
  const index = ordered.indexOf(pieceId)
  const to = index + delta
  if (index < 0 || to < 0 || to >= ordered.length) return null
  ;[ordered[index], ordered[to]] = [ordered[to]!, ordered[index]!]
  return ordered
}
