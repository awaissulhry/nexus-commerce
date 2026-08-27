import { describe, expect, it } from 'vitest'
import { collectEdits, draftValue, type EditDrafts, type EditField } from './editDrafts'

type Row = { id: string; name: string; budget: string }
const ROWS: Row[] = [
  { id: 'r1', name: 'Alpha', budget: '10' },
  { id: 'r2', name: 'Beta', budget: '20' },
]
const rowId = (r: Row) => r.id
const FIELDS: EditField<Row>[] = [
  { key: 'name', initial: (r) => r.name },
  { key: 'budget', initial: (r) => r.budget },
]
const collect = (drafts: EditDrafts) => collectEdits(ROWS, rowId, FIELDS, drafts)

describe('collectEdits — only what actually changed', () => {
  it('returns nothing when there are no drafts', () => {
    expect(collect({})).toEqual([])
  })

  it('skips a row whose draft object exists but holds no changes', () => {
    expect(collect({ r1: {} })).toEqual([])
  })

  it('reports only the fields that differ, not the whole draft', () => {
    expect(collect({ r1: { name: 'Alpha renamed', budget: '10' } })).toEqual([
      { id: 'r1', values: { name: 'Alpha renamed' } },
    ])
  })

  it('reports each dirty row independently', () => {
    expect(collect({ r1: { budget: '11' }, r2: { name: 'Beta 2' } })).toEqual([
      { id: 'r1', values: { budget: '11' } },
      { id: 'r2', values: { name: 'Beta 2' } },
    ])
  })
})

describe('collectEdits — a value typed back to its original is CLEAN', () => {
  // Apply is gated on this being empty. A row that reports dirty but is unchanged makes the
  // button live for a no-op write, and a write that reports work it did not do is a defect.
  it('drops a field whose draft equals its initial', () => {
    expect(collect({ r1: { name: 'Alpha' } })).toEqual([])
  })

  it('drops only the reverted field, keeping a genuinely changed sibling', () => {
    expect(collect({ r1: { name: 'Alpha', budget: '99' } })).toEqual([
      { id: 'r1', values: { budget: '99' } },
    ])
  })
})

describe('collectEdits — an empty string is a deliberate clearing, not an absence', () => {
  it("includes '' so a cleared field reaches onApply", () => {
    expect(collect({ r1: { name: '' } })).toEqual([{ id: 'r1', values: { name: '' } }])
  })

  it('excludes undefined, which means the field was never edited', () => {
    expect(collect({ r1: { name: undefined as unknown as string, budget: '12' } })).toEqual([
      { id: 'r1', values: { budget: '12' } },
    ])
  })
})

describe('collectEdits — a draft for a field that is not editable is ignored', () => {
  it('only considers the declared fields', () => {
    expect(collect({ r1: { somethingElse: 'x' } })).toEqual([])
  })
})

describe('draftValue', () => {
  it('falls back to the row initial when there is no draft', () => {
    expect(draftValue({}, 'r1', FIELDS[0], ROWS[0])).toBe('Alpha')
  })

  it('prefers the draft once one exists', () => {
    expect(draftValue({ r1: { name: 'typed' } }, 'r1', FIELDS[0], ROWS[0])).toBe('typed')
  })

  it("returns '' rather than the initial when the field was cleared", () => {
    expect(draftValue({ r1: { name: '' } }, 'r1', FIELDS[0], ROWS[0])).toBe('')
  })
})
