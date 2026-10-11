import { describe, expect, it } from 'vitest'

import {
  ackWords, doneSummary, raiseCount, resultVerb, resultWords, reviewColumns, reviewNote, reviewTitle, saveButtonWords, saveHeldReason, saveWords,
  type ReviewState,
} from './reviewChangesModel'

const ready: ReviewState = { phase: 'ready' }
const held = (over: Partial<Parameters<typeof saveHeldReason>[0]>) => saveHeldReason({ state: ready, count: 2, problems: 0, raises: 0, ack: false, ...over })

describe('reviewChangesModel — the counted words', () => {
  it('counts in the title and on the one primary button', () => {
    expect(reviewTitle(1)).toBe('Review 1 change')
    expect(reviewTitle(3)).toBe('Review 3 changes')
    expect(saveWords(3)).toBe('Save 3 changes')
    expect(saveButtonWords(ready, 3)).toBe('Save 3 changes')
    expect(saveButtonWords(ready, 1, 'Create rule at Watch')).toBe('Create rule at Watch')
    expect(saveButtonWords({ phase: 'saving', done: 2 }, 3)).toBe('Saving 2 of 3…')
    expect(saveButtonWords({ phase: 'saving' }, 3)).toBe('Saving…')
  })

  it('asks for one tick for the changes that let automation do more', () => {
    expect(raiseCount([{ raise: true }, {}, { raise: true }])).toBe(2)
    expect(ackWords(1)).toBe('I understand this change lets automation do more, from its next run.')
    expect(ackWords(2)).toBe('I understand these 2 changes let automation do more, from their next run.')
  })
})

describe('reviewChangesModel — Save is held, and says why', () => {
  it('waits for the re-read; a failed read holds it', () => {
    expect(held({ state: { phase: 'reading' } })).toBe("Reading today's values first")
    expect(held({ state: { phase: 'failed', error: 'x' } })).toBe("Today's values could not be read")
  })
  it('holds for nothing to save, a problem, and a raise without the tick — in that order', () => {
    expect(held({ count: 0, problems: 1 })).toBe('Nothing to save')
    expect(held({ problems: 1, raises: 1 })).toBe('Fix the problem first')
    expect(held({ problems: 2 })).toBe('Fix the problems first')
    expect(held({ raises: 1 })).toBe('Tick the box first')
    expect(held({ raises: 1, ack: true })).toBe(null)
    expect(held({})).toBe(null)
  })
  it('is not offered again while saving or once done', () => {
    expect(held({ state: { phase: 'saving' } })).toBe('Saving')
    expect(held({ state: { phase: 'done', results: {} } })).toBe('Already saved')
  })
})

describe('reviewChangesModel — one table', () => {
  it('shows Where only when a change has it, Note only when one has it, Result once done', () => {
    expect(reviewColumns([{ where: 'Rule A', note: 'x' }], false)).toEqual(['Where', 'What', 'Now', 'New', 'Note'])
    expect(reviewColumns([{}], false)).toEqual(['What', 'Now', 'New'])
    expect(reviewColumns([{ raise: true }], false)).toEqual(['What', 'Now', 'New', 'Note'])
    expect(reviewColumns([{ where: 'Rule A' }], true)).toEqual(['Where', 'What', 'Now', 'New', 'Result'])
  })
  it('a raise without a note says so plainly', () => {
    expect(reviewNote({ raise: true })).toBe('Lets automation do more')
    expect(reviewNote({ raise: true, note: 'Mode up' })).toBe('Mode up')
    expect(reviewNote({})).toBe('')
  })
})

describe('reviewChangesModel — the Done line', () => {
  const changes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('all saved, some not, none', () => {
    expect(doneSummary(changes, { a: { ok: true, words: 'Saved' }, b: { ok: true, words: 'Saved' }, c: { ok: true, words: 'Saved' } }))
      .toEqual({ line: '3 saved', tone: 'success' })
    expect(doneSummary(changes, { a: { ok: true, words: 'Saved' }, b: { ok: false, words: 'Refused: the cap is 1 a day' } }))
      .toEqual({ line: '1 saved · 1 not saved', tone: 'warning' })
    expect(doneSummary(changes, { a: { ok: false, words: 'Failed' } })).toEqual({ line: 'Nothing saved · 1 change not saved', tone: 'danger' })
    expect(doneSummary(changes, {})).toEqual({ line: 'Nothing saved', tone: 'danger' })
  })

  it('after Undo says Undone, after an archive Archived — never "1 saved" (audit S2)', () => {
    const one = [{ id: 'a' }]
    expect(doneSummary(one, { a: { ok: true, words: 'Undone: Off' } })).toEqual({ line: '1 undone', tone: 'success' })
    expect(doneSummary(one, { a: { ok: true, words: 'Undone' } }).line).toBe('1 undone')
    expect(doneSummary(one, { a: { ok: true, words: 'Archived · 2 asks expired' } }).line).toBe('1 archived')
    expect(doneSummary(one, { a: { ok: true, words: 'Already archived' } }).line).toBe('1 archived')
    expect(doneSummary(one, { a: { ok: true, words: 'Restored at Off' } }).line).toBe('1 restored')
    expect(doneSummary(one, { a: { ok: true, words: 'Done' } }, 'archived').line).toBe('1 archived')
    expect(doneSummary(one, { a: { ok: false, words: 'No answer', verb: 'undone' } })).toEqual({ line: 'Nothing undone · 1 change not undone', tone: 'danger' })
  })

  it('counts each verb on its own when one Done screen mixes them', () => {
    const two = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(doneSummary(two, { a: { ok: true, words: 'Saved' }, b: { ok: true, words: 'Undone: Watch' }, c: { ok: false, words: 'Refused', verb: 'undone' } }))
      .toEqual({ line: '1 saved · 1 undone · 1 not undone', tone: 'warning' })
  })

  it('takes the verb a result names over its words and the default', () => {
    expect(resultVerb({ words: 'Undone: Off', verb: 'reverted' })).toBe('reverted')
    expect(resultVerb({ words: 'undone' })).toBe('undone')
    expect(resultVerb({ words: 'Saved' }, 'archived')).toBe('archived')
    expect(resultVerb({ words: 'Refused: the cap is 1 a day' })).toBe('saved')
  })
})

describe('reviewChangesModel — the Result cell never repeats the New column', () => {
  it('a success that says what New already says reads "Done"; anything else keeps its own words', () => {
    expect(resultWords({ next: 'Rejected' }, { ok: true, words: 'Rejected' })).toBe('Done')
    expect(resultWords({ next: 'Archived' }, { ok: true, words: 'archived' })).toBe('Done')
    expect(resultWords({ next: '€0.50' }, { ok: true, words: 'Approved' })).toBe('Approved')
    expect(resultWords({ next: 'Rejected' }, { ok: false, words: 'Rejected' })).toBe('Rejected')
    expect(resultWords({ next: 'Rejected' }, { ok: true, words: 'Undone: waiting again' })).toBe('Undone: waiting again')
  })
})
