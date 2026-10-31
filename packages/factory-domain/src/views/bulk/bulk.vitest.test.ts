import { describe, expect, it } from 'vitest'
import { inRange, isRelativeDay, ME, meOf, relativeRange, RELATIVE_DAYS } from '../quick/relative'
import {
  applyRowsOf,
  askProblems,
  BULK_LIMITS,
  fieldHeld,
  isDay,
  missingRow,
  normaliseValue,
  previewCounts,
  previewRow,
  refusalOfError,
  undoRowsOf,
  valueProblem,
  type BulkFieldSpec,
  type BulkResult,
  type BulkRowFacts,
} from './rules'

/** Bulk edit with preview, inline edit and quick filters (B-W2b-13; PLT-182, PLT-166, PLT-167): the pure rules. */

const FIELDS: Record<string, BulkFieldSpec> = {
  due: { kind: 'date', nullable: true },
  priority: { kind: 'integer', min: -1000, max: 1000 },
  note: { kind: 'text', nullable: true, maxLength: 10 },
  bin: { kind: 'choice', choices: ['A1', 'B2'] },
  price: { kind: 'integer', grain: 'price' },
}

const row = (over: Partial<BulkRowFacts> = {}): BulkRowFacts => ({ id: 'w1', label: 'WO-0001', version: 3, values: { due: '2026-11-10', priority: 0 }, held: {}, ...over })

describe('values', () => {
  it('a day is a real calendar day', () => {
    expect(isDay('2026-02-28')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('28/02/2026')).toBe(false)
  })

  it('normalises: text trimmed, empty → nothing, a numeric text → a number', () => {
    expect(normaliseValue(FIELDS.note!, '  hi  ')).toBe('hi')
    expect(normaliseValue(FIELDS.note!, '   ')).toBeNull()
    expect(normaliseValue(FIELDS.due!, '')).toBeNull()
    expect(normaliseValue(FIELDS.priority!, ' 12 ')).toBe(12)
    expect(normaliseValue(FIELDS.priority!, 'abc')).toBe('abc')
    expect(normaliseValue(FIELDS.priority!, undefined)).toBeNull()
  })

  it('says why a value cannot be written', () => {
    expect(valueProblem(FIELDS.due!, null)).toBeNull()
    expect(valueProblem(FIELDS.priority!, null)).toBe('A value is needed.')
    expect(valueProblem(FIELDS.due!, '2026-13-01')).toMatch(/day/)
    expect(valueProblem(FIELDS.priority!, 1.5)).toMatch(/whole/)
    expect(valueProblem(FIELDS.priority!, 1001)).toBe('At most 1000.')
    expect(valueProblem(FIELDS.priority!, -1001)).toBe('At least -1000.')
    expect(valueProblem(FIELDS.note!, '12345678901')).toBe('At most 10 characters.')
    expect(valueProblem(FIELDS.bin!, 'C3')).toMatch(/choices/)
    expect(valueProblem(FIELDS.bin!, 'A1')).toBeNull()
  })

  it('a money field needs its grain', () => {
    expect(fieldHeld(FIELDS.price!, new Set())).toMatch(/price/)
    expect(fieldHeld(FIELDS.price!, new Set(['price'] as const))).toBeNull()
    expect(fieldHeld(FIELDS.due!, new Set())).toBeNull()
  })
})

describe('the ask', () => {
  it('needs a row, at most the limit, a field the list edits and a value it takes', () => {
    expect(askProblems(FIELDS, { due: '2026-11-12' }, 1)).toEqual([])
    expect(askProblems(FIELDS, { due: '2026-11-12' }, 0).map((issue) => issue.path)).toEqual(['body/ids'])
    expect(askProblems(FIELDS, { due: '2026-11-12' }, BULK_LIMITS.rows + 1)[0]!.message).toBe(`Edit up to ${BULK_LIMITS.rows} rows at once.`)
    expect(askProblems(FIELDS, {}, 2)[0]!.path).toBe('body/changes')
    expect(askProblems(FIELDS, { colour: 'red' }, 2)[0]).toEqual({ path: 'body/changes/colour', message: 'Not a field this list edits.' })
    expect(askProblems(FIELDS, { priority: 5000 }, 2)[0]).toEqual({ path: 'body/changes/priority', message: 'At most 1000.' })
    expect(askProblems(FIELDS, { constructor: 1 } as never, 1)[0]!.message).toBe('Not a field this list edits.')
  })
})

describe('the preview', () => {
  it('old → new for each field that changes; a field at that value is left out', () => {
    const preview = previewRow(row(), { due: '2026-11-20', priority: 0 })
    expect(preview).toEqual({ id: 'w1', label: 'WO-0001', version: 3, changes: [{ field: 'due', now: '2026-11-10', next: '2026-11-20' }], refusal: null })
  })

  it('a row that already holds the values is unchanged, not refused', () => {
    const preview = previewRow(row({ held: { due: { code: 'held', status: 'CLOSED' } } }), { due: '2026-11-10' })
    expect(preview.changes).toEqual([])
    expect(preview.refusal).toBeNull()
  })

  it('a held field refuses the row with the state that holds it; a whole-row hold always does', () => {
    expect(previewRow(row({ held: { due: { code: 'held', status: 'CLOSED' } } }), { due: '2026-11-20' }).refusal).toEqual({ code: 'held', status: 'CLOSED' })
    expect(previewRow(row({ held: { '*': { code: 'forbidden' } } }), { due: '2026-11-10' }).refusal).toEqual({ code: 'forbidden' })
  })

  it('counts what would change, what already holds it, what is refused; applies only the changing rows', () => {
    const rows = [previewRow(row(), { due: '2026-11-20' }), previewRow(row({ id: 'w2' }), { due: '2026-11-10' }), missingRow('w3'), previewRow(row({ id: 'w4', held: { due: { code: 'held', status: 'CANCELLED' } } }), { due: '2026-11-20' })]
    expect(previewCounts(rows)).toEqual({ changing: 1, unchanged: 1, refused: 2 })
    expect(applyRowsOf(rows)).toEqual([{ id: 'w1', version: 3, changes: { due: '2026-11-20' } }])
  })
})

describe('undo', () => {
  const result = (over: Partial<BulkResult>): BulkResult => ({ id: 'w1', label: 'WO-0001', ok: true, refusal: null, before: { due: '2026-11-10', priority: 0 }, after: { due: '2026-11-20', priority: 0 }, version: 4, ...over })

  it('puts back only what changed, from the version the change gave each row; refused rows are left alone', () => {
    expect(undoRowsOf([result({}), result({ id: 'w2', ok: false, refusal: { code: 'stale' }, after: { due: '2026-11-10', priority: 0 }, version: 9 }), result({ id: 'w3', after: { due: '2026-11-10', priority: 0 } })])).toEqual([
      { id: 'w1', version: 4, changes: { due: '2026-11-10' } },
    ])
  })

  it('a refusal of the record’s own command becomes a code', () => {
    expect(refusalOfError('ConflictError')).toEqual({ code: 'stale' })
    expect(refusalOfError('InvalidStateError', null, 'CLOSED')).toEqual({ code: 'held', status: 'CLOSED' })
    expect(refusalOfError('ValidationError', 'due')).toEqual({ code: 'invalid', field: 'due' })
    expect(refusalOfError('NotFoundError').code).toBe('missing')
    expect(refusalOfError('ForbiddenError').code).toBe('forbidden')
    expect(refusalOfError('Error').code).toBe('failed')
  })
})

describe('quick filters: relative days and me', () => {
  // 2026-10-31 is a Saturday.
  const today = '2026-10-31'

  it('every word has a range; weeks start on Monday by default', () => {
    for (const word of RELATIVE_DAYS) expect(relativeRange(word, today)).toBeDefined()
    expect(relativeRange('today', today)).toEqual({ from: today, to: today })
    expect(relativeRange('tomorrow', today)).toEqual({ from: '2026-11-01', to: '2026-11-01' })
    expect(relativeRange('this-week', today)).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    expect(relativeRange('this-week', today, 0)).toEqual({ from: '2026-10-25', to: '2026-10-31' })
    expect(relativeRange('next-week', today)).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    expect(relativeRange('last-week', today)).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    expect(relativeRange('next-7-days', today)).toEqual({ from: today, to: '2026-11-06' })
    expect(relativeRange('last-7-days', today)).toEqual({ from: '2026-10-25', to: today })
    expect(relativeRange('this-month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(relativeRange('this-month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(relativeRange('last-30-days', today)).toEqual({ from: '2026-10-02', to: today })
    expect(relativeRange('overdue', today)).toEqual({ from: null, to: '2026-10-30' })
  })

  it('a week on a Monday starts that day; across a year end', () => {
    expect(relativeRange('this-week', '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-08' })
    expect(relativeRange('this-week', '2026-12-31')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
  })

  it('inside a range; no day is never inside', () => {
    expect(inRange('2026-10-27', relativeRange('this-week', today))).toBe(true)
    expect(inRange('2026-11-02', relativeRange('this-week', today))).toBe(false)
    expect(inRange('2020-01-01', relativeRange('overdue', today))).toBe(true)
    expect(inRange(null, relativeRange('overdue', today))).toBe(false)
  })

  it('"me" is the person asking; a word is known or not', () => {
    expect(meOf(ME, 'u-1')).toBe('u-1')
    expect(meOf('u-2', 'u-1')).toBe('u-2')
    expect(meOf(null, 'u-1')).toBeNull()
    expect(isRelativeDay('this-week')).toBe(true)
    expect(isRelativeDay('2026-10-31')).toBe(false)
  })
})
