import { describe, expect, it } from 'vitest'
import { forbiddenKeysIn } from './portal-read'
import {
  BRAND_CHECK_KINDS,
  cellFiguresOf,
  CHECK_KIND_WORDS,
  checkCountWords,
  checkSummariesOf,
  defectTotalsOf,
  FINAL_STATE_WORDS,
  FINAL_STATES,
  finalStateOf,
  photoShown,
  reportVersionOf,
  workOrderAlone,
  type CheckRow,
} from './quality-read'

/**
 * B-PR-19: the quality of a customer's own goods as its portal reads it at the QUALITY level (production plan §2, §4; 06-tree
 * §0.5, P-ORD-quality; L8; WALL-G02, WALL-G07). Pure.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const MARKER = 'ffffffff-ffff-8fff-bfff-ffffffffffff'

describe('a work order is the customer’s alone (L8)', () => {
  it('only at QUALITY, only when its customer is the customer and no cell names another', () => {
    expect(workOrderAlone('QUALITY', { partyId: B, cellParties: [B, B] }, B)).toBe(true)
    // A cell of no customer (a sample) does not make it shared.
    expect(workOrderAlone('QUALITY', { partyId: B, cellParties: [B, null] }, B)).toBe(true)
    // A legacy work order that mixed customers: no customer on it, cells of both.
    expect(workOrderAlone('QUALITY', { partyId: null, cellParties: [A, B] }, B)).toBe(false)
    // Another customer's work order, or a cell of another customer under its name: never.
    expect(workOrderAlone('QUALITY', { partyId: A, cellParties: [A] }, B)).toBe(false)
    expect(workOrderAlone('QUALITY', { partyId: B, cellParties: [B, A] }, B)).toBe(false)
    // Below QUALITY nothing is the customer's to read.
    for (const level of ['STATUS', 'PROGRESS', 'GATES'] as const) expect(workOrderAlone(level, { partyId: B, cellParties: [B] }, B)).toBe(false)
  })
})

describe('final inspections', () => {
  it('reads passed, failed and waiting; a cancelled inspection is never shown', () => {
    expect([finalStateOf('PASSED'), finalStateOf('FAILED'), finalStateOf('OPEN'), finalStateOf('CANCELLED')]).toEqual(['PASSED', 'FAILED', 'WAITING', null])
    for (const state of FINAL_STATES) expect(FINAL_STATE_WORDS[state].it.length > 0 && FINAL_STATE_WORDS[state].en.length > 0).toBe(true)
  })

  it('counts the garments with a defect per class', () => {
    expect(
      defectTotalsOf([
        { defectClass: 'MAJOR', quantity: 2 },
        { defectClass: 'MINOR', quantity: 1 },
        { defectClass: 'MINOR', quantity: 3 },
      ]),
    ).toEqual({ CRITICAL: 0, MAJOR: 2, MINOR: 4 })
  })

  it('opens the newest report in the reader’s language, else the newest of any', () => {
    const versions = [
      { version: 1, language: 'it' },
      { version: 2, language: 'en' },
      { version: 3, language: 'it' },
    ]
    expect(reportVersionOf(versions, 'en')).toEqual({ version: 2, language: 'en' })
    expect(reportVersionOf(versions, 'it')).toEqual({ version: 3, language: 'it' })
    expect(reportVersionOf(versions.slice(0, 1), 'en')).toEqual({ version: 1, language: 'it' })
    expect(reportVersionOf([], 'en')).toBeNull()
  })
})

describe('in-process checks', () => {
  const row = (kind: string, status: string, outcome: string | null, decidedOn: string | null, pieces = 0, defectivePieces = 0): CheckRow => ({ kind, status, outcome, pieces, defectivePieces, decidedOn })

  it('sums first piece, cutting and end of line per kind, in that order; a roving check never reaches a customer', () => {
    expect([...BRAND_CHECK_KINDS]).toEqual(['FIRST_PIECE', 'CUTTING', 'END_OF_LINE'])
    for (const kind of BRAND_CHECK_KINDS) expect(CHECK_KIND_WORDS[kind].en.length > 0).toBe(true)
    const summaries = checkSummariesOf([
      row('END_OF_LINE', 'DECIDED', 'PASS', '2026-11-10', 10, 0),
      row('END_OF_LINE', 'DECIDED', 'FAIL', '2026-11-12', 10, 2),
      row('END_OF_LINE', 'OPEN', null, null),
      row('ROVING', 'DECIDED', 'RED', '2026-11-12', 5, 1),
      row('FIRST_PIECE', 'DECIDED', 'REJECTED', '2026-11-03', 1, 1),
      row('FIRST_PIECE', 'DECIDED', 'APPROVED', '2026-11-04', 1, 0),
      row('CUTTING', 'CANCELLED', null, null),
    ])
    expect(summaries.map((summary) => summary.kind)).toEqual(['FIRST_PIECE', 'END_OF_LINE'])
    expect(summaries[0]).toEqual({ kind: 'FIRST_PIECE', passed: 1, failed: 1, waiting: 0, pieces: 2, defectivePieces: 1, lastOn: '2026-11-04', state: 'PASSED' })
    expect(summaries[1]).toEqual({ kind: 'END_OF_LINE', passed: 1, failed: 1, waiting: 1, pieces: 20, defectivePieces: 2, lastOn: '2026-11-12', state: 'FAILED' })
  })

  it('reads Waiting while only open checks exist, and words the counts that are not 0', () => {
    const [only] = checkSummariesOf([row('FIRST_PIECE', 'OPEN', null, null)])
    expect(only).toMatchObject({ state: 'WAITING', passed: 0, failed: 0, waiting: 1, lastOn: null })
    expect(checkCountWords({ passed: 3, failed: 1, waiting: 0 })).toEqual({ it: '3 superati · 1 non superato', en: '3 passed · 1 failed' })
    expect(checkCountWords({ passed: 1, failed: 0, waiting: 2 })).toEqual({ it: '1 superato · 2 in attesa', en: '1 passed · 2 waiting' })
  })
})

describe('the customer’s own cells', () => {
  const lines = [
    { id: 'line-1', quantity: 10, sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }] },
    { id: 'line-2', quantity: 3, sizes: [] },
  ]

  it('sums released and reversed per line and size over every work order cell, capped at what it ordered', () => {
    const figures = cellFiguresOf(lines, [
      // Size 52 split over its own work order and a legacy shared one (its own cell there).
      { lineId: 'line-1', size: '50', released: 2, reversed: 0 },
      { lineId: 'line-1', size: '52', released: 2, reversed: 1 },
      { lineId: 'line-1', size: '52', released: 9, reversed: 0 },
      // A line without sizes reads one row of its whole quantity.
      { lineId: 'line-2', size: 'U', released: 1, reversed: 2 },
    ])
    expect(figures.get('line-1')).toEqual([
      { size: '50', ordered: 4, released: 2, reversed: 0 },
      { size: '52', ordered: 4, released: 4, reversed: 1 },
      { size: '54', ordered: 2, released: 0, reversed: 0 },
    ])
    // Never more taken back than released.
    expect(figures.get('line-2')).toEqual([{ size: null, ordered: 3, released: 1, reversed: 1 }])
  })

  it('names no work order, lot, line of the floor or note', () => {
    const figures = cellFiguresOf(lines, [{ lineId: 'line-1', size: '50', released: 1, reversed: 0 }])
    expect(forbiddenKeysIn(Object.fromEntries(figures))).toEqual([])
  })
})

describe('photos shared on its order (WALL-G02, WALL-G07)', () => {
  it('draws a photo that is no copy, or a copy of its own record or of one of no customer; never of another’s or a shared one', () => {
    expect(photoShown({ kind: 'none' }, B)).toBe(true)
    expect(photoShown({ kind: 'party', partyId: B }, B)).toBe(true)
    expect(photoShown({ kind: 'party', partyId: null }, B)).toBe(true)
    expect(photoShown({ kind: 'party', partyId: A }, B)).toBe(false)
    // A legacy work order that mixed customers: its wall party is the every-party marker.
    expect(photoShown({ kind: 'party', partyId: MARKER }, B)).toBe(false)
    // A source whose customer cannot be read: fail closed.
    expect(photoShown({ kind: 'unknown' }, B)).toBe(false)
  })
})
