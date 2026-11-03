import { describe, expect, it } from 'vitest'
import { addPieceBody, changePiecesBody, updatePieceBody } from './contracts'
import {
  copyPieces,
  gradesAllowed,
  gradeVerdict,
  nextPieceSeq,
  pieceChanges,
  pieceIssues,
  pieceOrderProblems,
  pieceRenumbering,
  piecesEditRefusal,
  planPiece,
  sizesInRangeOrder,
  type PieceData,
  type PieceGrade,
  type PieceLine,
  type PieceWorld,
} from './rules'

/** B-W2b-95 (PRD-219, MES-055): the pattern pieces' rules, with made-up lines, grades and pieces. */

const LEATHER: PieceLine = { id: 'line-10', seq: 10, code: 'LEA-100', leather: true }
const LINING: PieceLine = { id: 'line-20', seq: 20, code: 'LIN-200', leather: false }
const A: PieceGrade = { id: 'g-a', code: 'A', sortOrder: 1, active: true }
const B: PieceGrade = { id: 'g-b', code: 'B', sortOrder: 2, active: true }
const C: PieceGrade = { id: 'g-c', code: 'C', sortOrder: 3, active: true }
const D: PieceGrade = { id: 'g-d', code: 'D', sortOrder: 4, active: false }
const RANGE = ['50', '52', '54']

const world = (others: PieceWorld['others'] = []): PieceWorld => ({
  sizes: RANGE,
  lines: new Map([LEATHER, LINING].map((line) => [line.id, line])),
  grades: new Map([A, B, C, D].map((grade) => [grade.id, grade])),
  others,
})
const piece = (fields: Partial<PieceData> = {}): PieceData => ({ id: 'p-1', seq: 10, name: 'Front left', quantity: 1, bomLineId: LEATHER.id, minGradeId: B.id, grain: 'ALONG', sizes: [], note: null, ...fields })

describe('a new piece or a change (planPiece)', () => {
  it('takes a piece with defaults: one per garment, any grain, every size; the name tidied', () => {
    expect(planPiece(null, { name: '  Front   left ' }, world(), 10)).toEqual({ ok: true, piece: { seq: 10, name: 'Front left', quantity: 1, bomLineId: null, minGradeId: null, grain: 'ANY', sizes: [], note: null } })
  })

  it('keeps sizes in the range order and refuses one outside it', () => {
    const plan = planPiece(null, { name: 'Sleeve', sizes: ['54', '52'] }, world(), 20)
    expect(plan.ok && plan.piece.sizes).toEqual(['52', '54'])
    expect(planPiece(null, { name: 'Sleeve', sizes: ['48'] }, world(), 20)).toEqual({ ok: false, issues: [{ path: 'sizes', message: "Not in the style's range: 48." }] })
    expect(planPiece(null, { name: 'Sleeve', sizes: ['52', '52'] }, world(), 20)).toMatchObject({ ok: false, issues: [{ path: 'sizes', message: 'Each size once.' }] })
  })

  it('refuses a name twice in the revision, in any case and spacing', () => {
    expect(planPiece(null, { name: 'front  LEFT' }, world([{ id: 'p-1', name: 'Front left' }]), 20)).toMatchObject({ ok: false, issues: [{ path: 'name' }] })
    // The piece itself is not "another" piece.
    expect(planPiece(piece(), { name: 'FRONT LEFT' }, world([]), 10).ok).toBe(true)
  })

  it('takes a minimum grade only on a leather line, and a retired grade only when the piece already has it', () => {
    expect(planPiece(null, { name: 'Collar', bomLineId: LEATHER.id, minGradeId: A.id }, world(), 10).ok).toBe(true)
    expect(planPiece(null, { name: 'Collar', minGradeId: A.id }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'minGradeId', message: expect.stringContaining('choose the leather line') }] })
    expect(planPiece(null, { name: 'Collar', bomLineId: LINING.id, minGradeId: A.id }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'minGradeId', message: expect.stringContaining('is not leather') }] })
    expect(planPiece(null, { name: 'Collar', bomLineId: LEATHER.id, minGradeId: D.id }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'minGradeId', message: 'Grade D is retired: choose a grade in use.' }] })
    expect(planPiece(piece({ minGradeId: D.id }), { quantity: 2 }, world(), 10).ok).toBe(true)
  })

  it('points at the line when a graded piece moves off leather, and lets it go with its grade cleared', () => {
    expect(planPiece(piece(), { bomLineId: LINING.id }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'bomLineId', message: expect.stringContaining('Clear the grade first') }] })
    expect(planPiece(piece(), { bomLineId: LINING.id, minGradeId: null }, world(), 10)).toMatchObject({ ok: true, piece: { bomLineId: LINING.id, minGradeId: null } })
  })

  it('refuses a line of another revision and pieces per garment outside 1–99', () => {
    expect(planPiece(null, { name: 'X', bomLineId: 'line-99' }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'bomLineId' }] })
    expect(planPiece(null, { name: 'X', quantity: 0 }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'quantity' }] })
    expect(planPiece(null, { name: 'X', quantity: 100 }, world(), 10)).toMatchObject({ ok: false, issues: [{ path: 'quantity' }] })
  })

  it('keeps a size the range lost on a change that does not touch the sizes (the list points it out)', () => {
    expect(planPiece(piece({ sizes: ['48', '52'] }), { quantity: 2 }, world(), 10)).toMatchObject({ ok: true, piece: { sizes: ['48', '52'], quantity: 2 } })
  })

  it('names what changed', () => {
    expect(pieceChanges(piece(), { ...piece(), sizes: ['52'], note: 'x' })).toEqual(['sizes', 'note'])
    expect(pieceChanges(piece(), piece())).toEqual([])
  })
})

describe('the order', () => {
  it('puts a new piece after the last, and renumbers 10, 20, 30 moving only what changes', () => {
    expect(nextPieceSeq([])).toBe(10)
    expect(nextPieceSeq([{ seq: 10 }, { seq: 40 }])).toBe(50)
    const pieces = [piece({ id: 'a', seq: 10 }), piece({ id: 'b', seq: 20 }), piece({ id: 'c', seq: 30 })]
    expect(pieceRenumbering(pieces, ['b', 'a', 'c'])).toEqual([
      { id: 'b', from: 20, to: 10 },
      { id: 'a', from: 10, to: 20 },
    ])
  })

  it('wants every piece once', () => {
    expect(pieceOrderProblems(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(pieceOrderProblems(['a', 'b'], ['a'])[0]!.message).toContain('leaves out 1 piece')
    expect(pieceOrderProblems(['a', 'b'], ['a', 'a', 'b'])[0]!.message).toBe('Each piece once.')
  })

  it("refuses a frozen revision's pieces and an archived style's in words", () => {
    expect(piecesEditRefusal({ revision: 3, status: 'RELEASED' }, 'ACTIVE')).toBe('Revision 3 is released: its pattern pieces are frozen. Change them in a new draft revision.')
    expect(piecesEditRefusal({ revision: 3, status: 'DRAFT' }, 'ARCHIVED')).toContain('archived')
    expect(piecesEditRefusal({ revision: 3, status: 'DRAFT' }, 'ACTIVE')).toBeNull()
  })
})

describe('the copy into a new revision', () => {
  const lines = new Map([
    ['line-10', { id: 'new-10', seq: 10, code: 'LEA-100', leather: true }],
    ['line-20', { id: 'new-20', seq: 20, code: 'LIN-200', leather: false }],
  ])
  const grades = new Map([A, B, C, D].map((grade) => [grade.id, grade]))
  let next = 0
  const newId = () => `copy-${++next}`

  it('keeps names, counts and places on the new lines; clears a retired grade and a lost line; leaves out a piece whose sizes all left the range', () => {
    const source = [
      piece({ id: 'p1', seq: 10, name: 'Front left' }),
      piece({ id: 'p2', seq: 20, name: 'Facing', minGradeId: D.id }),
      piece({ id: 'p3', seq: 30, name: 'Pocket', bomLineId: 'line-30', minGradeId: null }),
      piece({ id: 'p4', seq: 40, name: 'Size 48 gusset', sizes: ['48'] }),
      piece({ id: 'p5', seq: 50, name: 'Sleeve', sizes: ['48', '54', '52'] }),
    ]
    const copy = copyPieces(source, lines, grades, RANGE, newId)
    expect(copy.pieces.map((entry) => [entry.seq, entry.name, entry.bomLineId, entry.minGradeId, entry.sizes])).toEqual([
      [10, 'Front left', 'new-10', B.id, []],
      [20, 'Facing', 'new-10', null, []],
      [30, 'Pocket', null, null, []],
      [50, 'Sleeve', 'new-10', B.id, ['52', '54']],
    ])
    expect(copy.pieces.every((entry) => entry.id.startsWith('copy-'))).toBe(true)
    expect(copy).toMatchObject({ leftOut: ['Size 48 gusset'], gradesCleared: ['Facing'], linesCleared: ['Pocket'] })
  })
})

describe('what the list points out', () => {
  it('names a size outside the range, a grade off leather, a retired grade and a leather line no piece names', () => {
    const issues = pieceIssues(
      [piece({ id: 'p1', sizes: ['48'] }), piece({ id: 'p2', name: 'Pocket', bomLineId: LINING.id }), piece({ id: 'p3', name: 'Facing', minGradeId: D.id })],
      { sizes: RANGE, lines: new Map([LEATHER, LINING, { id: 'line-15', seq: 15, code: 'LEA-110', leather: true }].map((line) => [line.id, line])), grades: new Map([A, B, C, D].map((grade) => [grade.id, grade])) },
    )
    expect(issues.map((issue) => [issue.code, issue.pieceId ?? issue.lineId])).toEqual([
      ['SIZE_NOT_IN_RANGE', 'p1'],
      ['GRADE_NOT_LEATHER', 'p2'],
      ['GRADE_RETIRED', 'p3'],
      ['LEATHER_LINE_NO_PIECES', 'line-15'],
    ])
  })
})

describe("the cutting table's question (B-W2b-103)", () => {
  it('says whether a hide of a grade may be cut for a piece', () => {
    expect(gradeVerdict(A, B)).toBe('OK')
    expect(gradeVerdict(B, B)).toBe('OK')
    expect(gradeVerdict(C, B)).toBe('BELOW')
    expect(gradeVerdict(null, B)).toBe('UNKNOWN')
    expect(gradeVerdict(null, null)).toBe('OK')
    expect(gradesAllowed([C, A, B, D], B).map((grade) => grade.code)).toEqual(['A', 'B'])
    expect(gradesAllowed([C, A], null).map((grade) => grade.code)).toEqual(['A', 'C'])
  })
})

describe('the bodies', () => {
  it('fills a new piece with defaults and takes a change of one field', () => {
    expect(addPieceBody.parse({ version: 1, name: 'Collar' })).toEqual({ version: 1, name: 'Collar', quantity: 1, bomLineId: null, minGradeId: null, grain: 'ANY', sizes: [], note: null })
    expect(updatePieceBody.parse({ version: 2, grain: 'BIAS' })).toEqual({ version: 2, grain: 'BIAS' })
    expect(() => updatePieceBody.parse({ version: 2, colour: 'red' })).toThrow()
    expect(changePiecesBody.parse({ version: 3, pieceIds: ['8f3a52f6-6d2e-4bb1-9b41-0b6a3f0f2c11'], minGradeId: null })).toMatchObject({ minGradeId: null })
    expect(sizesInRangeOrder(['54', 'X', '50'], RANGE)).toEqual(['50', '54', 'X'])
  })
})
