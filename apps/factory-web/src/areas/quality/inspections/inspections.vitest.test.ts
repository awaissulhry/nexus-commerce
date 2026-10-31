import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import {
  DUE_LIMIT,
  dueBulkHeld,
  dueDialogHeld,
  dueProblemKey,
  dueRowHeld,
  dueState,
  fromLocalInput,
  ncrFromDefectsAddress,
  ncrFromDefectsHeld,
  pickedDefectIds,
  toLocalInput,
} from './model'

/**
 * B-W2b-17 on the Inspections screens: by when an inspection is due (the Due column, the Set due date dialog, the band)
 * and "Create NCR from N defects" on the Defects tab. Pure parts; the screens render every design case in both languages
 * in ../quality.vitest.test.ts.
 */

const now = new Date('2026-11-20T10:00:00.000Z')
const can = { inspectionsRecord: true }

describe('the due time', () => {
  it('later than now and at most a year ahead; cleared is fine', () => {
    expect(dueProblemKey(null, now)).toBeNull()
    expect(dueProblemKey('2026-11-21T10:00:00.000Z', now)).toBeNull()
    expect(dueProblemKey('2026-11-20T09:00:00.000Z', now)).toBe('due.problem.past')
    expect(dueProblemKey('2028-01-01T00:00:00.000Z', now)).toBe('due.problem.far')
    expect(dueProblemKey('nonsense', now)).toBe('due.problem.invalid')
    expect(dueDialogHeld({ value: '', busy: true }, now)).toBe('common.working')
    expect(dueDialogHeld({ value: '2026-11-20T09:00:00.000Z', busy: false }, now)).toBe('due.problem.past')
  })

  it('a datetime-local value round-trips to the same instant; empty clears', () => {
    const iso = '2026-11-21T15:30:00.000Z'
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso)
    expect(toLocalInput(null)).toBe('')
    expect(fromLocalInput('  ')).toBeNull()
  })

  it('held with the reason: no right, not open, nothing or too much picked', () => {
    expect(dueRowHeld({ status: 'OPEN' }, can)).toBeNull()
    expect(dueRowHeld({ status: 'PASSED' }, can)).toBe('due.held.notOpen')
    expect(dueRowHeld({ status: 'OPEN' }, { inspectionsRecord: false })).toBe('due.held.noRight')
    expect(dueBulkHeld([], can)).toBe('due.held.none')
    expect(dueBulkHeld([{ status: 'OPEN' }, { status: 'FAILED' }], can)).toBe('due.held.notOpenSome')
    expect(dueBulkHeld(Array.from({ length: DUE_LIMIT + 1 }, () => ({ status: 'OPEN' })), can)).toBe('due.held.tooMany')
    expect(dueBulkHeld([{ status: 'OPEN' }], can)).toBeNull()
  })

  it('says none, due or overdue — overdue in words and the danger tone, only while open', () => {
    expect(dueState({ dueAt: null, overdue: false, status: 'OPEN' })).toEqual({ key: 'due.none', tone: 'neutral' })
    expect(dueState({ dueAt: '2026-11-20T09:00:00.000Z', overdue: true, status: 'OPEN' })).toEqual({ key: 'due.overdue', tone: 'danger' })
    expect(dueState({ dueAt: '2026-11-20T09:00:00.000Z', overdue: true, status: 'PASSED' })).toEqual({ key: 'due.at', tone: 'info' })
  })
})

describe('Create NCR from N defects', () => {
  const saved = { 'MAJOR|SEAM-OPEN': 'd1', 'MINOR|STITCH-SKIP': 'd2' }

  it('takes the picked lines that are saved, in order; holds without the right, without a pick, or with an unsaved line', () => {
    expect(pickedDefectIds(['MINOR|STITCH-SKIP', 'MAJOR|SEAM-OPEN'], saved)).toEqual(['d2', 'd1'])
    expect(ncrFromDefectsHeld(['MAJOR|SEAM-OPEN'], saved, false)).toBe('raiseNcr.held.noRight')
    expect(ncrFromDefectsHeld([], saved, true)).toBe('defects.ncr.held.none')
    expect(ncrFromDefectsHeld(['MAJOR|NEW-LINE'], saved, true)).toBe('defects.ncr.held.unsaved')
    expect(ncrFromDefectsHeld(['MAJOR|SEAM-OPEN', 'MINOR|STITCH-SKIP'], saved, true)).toBeNull()
  })

  it("adds the picked lines to New NCR's address", () => {
    expect(ncrFromDefectsAddress('/w/A/quality/ncr?new=1&from=Inspection&id=i1', ['d1', 'd2'])).toBe('/w/A/quality/ncr?new=1&from=Inspection&id=i1&defects=d1,d2')
    expect(ncrFromDefectsAddress('/w/A/quality/ncr?new=1&from=Inspection&id=i1', [])).toBe('/w/A/quality/ncr?new=1&from=Inspection&id=i1')
  })

  it('every key these parts return is in both languages', () => {
    const keys = ['due.problem.past', 'due.problem.far', 'due.problem.invalid', 'due.held.noRight', 'due.held.notOpen', 'due.held.none', 'due.held.tooMany', 'due.held.notOpenSome', 'due.none', 'due.overdue', 'due.at', 'defects.ncr.held.none', 'defects.ncr.held.unsaved', 'raiseNcr.held.noRight']
    for (const locale of ['en', 'it'] as const) {
      const quality = CATALOGUE[locale].quality!
      expect(keys.filter((key) => quality[key] === undefined && quality[`${key}_other`] === undefined)).toEqual([])
    }
  })
})
