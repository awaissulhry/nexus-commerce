import { describe, expect, it } from 'vitest'
import { clearChoiceWords, setColumnWords } from './sheetReset'

/** P1 — the words of the two questions the sheet asks before a bulk change (the Modal is DS; it portals, so SSR shows nothing). */
describe('Delete: clear or reset, asked once', () => {
  it('says what each answer does to how many cells, and keeps the focus on Reset', () => {
    expect(clearChoiceWords({ subject: '3 cells of Material', clearable: 3, resettable: 2 })).toEqual({
      title: 'Delete 3 cells of Material?',
      clear: 'Clear stores an empty value in each cell: the value it inherits no longer shows (3 cells).',
      reset: 'Reset to inherited removes each cell’s own value, so it shows the value it inherits again (2 cells).',
      clearLabel: 'Clear 3 cells', resetLabel: 'Reset 2 cells to inherited', focus: 'reset',
    })
  })
  it('says there is nothing to reset, and focuses Cancel, when no cell holds its own value', () => {
    const words = clearChoiceWords({ subject: '1 cell of Brand', clearable: 1, resettable: 0 })
    expect(words.reset).toBe('No selected cell holds a value of its own, so there is nothing to reset.')
    expect([words.clearLabel, words.focus]).toEqual(['Clear 1 cell', 'cancel'])
  })
})

describe('Set every row…', () => {
  it('names the rows it sets and the locked rows it leaves alone', () => {
    expect(setColumnWords({ label: 'Brand', rows: 38, locked: 3 }, false)).toEqual({ title: 'Set every row · Brand',
      lead: 'One value for Brand on the 38 rows shown, saved together. 3 locked rows keep their value.', confirm: 'Set 38 rows' })
    expect(setColumnWords({ label: 'Brand', rows: 1, locked: 0 }, true).confirm).toBe('Clear 1 row')
  })
})
