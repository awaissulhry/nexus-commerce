import { describe, expect, it } from 'vitest'
import { formatBytes, formatElapsed, inlineValue, plainValue } from './format'

describe('formatBytes', () => {
  it('reads a file size the way an operator does', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(673 * 1024)).toBe('673 KB')
    expect(formatBytes(1.8 * 1024 * 1024)).toBe('1.8 MB')
  })

  it('keeps one decimal below 10 and whole numbers above', () => {
    expect(formatBytes(9.96 * 1024)).toBe('10 KB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('never shows four digits: from 1000 of a unit it reads in the next one', () => {
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(1023)).toBe('1.0 KB')
    expect(formatBytes(999 * 1024)).toBe('999 KB')
    expect(formatBytes(999.6 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1000 * 1024)).toBe('1.0 MB')
  })

  it('never invents a size', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatElapsed', () => {
  it('reads seconds, then minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0 s')
    expect(formatElapsed(59_000)).toBe('59 s')
    expect(formatElapsed(61_000)).toBe('1 min 1 s')
    expect(formatElapsed(60_000)).toBe('1 min 0 s')
    expect(formatElapsed(3_723_000)).toBe('1 h 2 min')
  })

  it('floors, so a ticking clock never runs ahead', () => {
    expect(formatElapsed(59_999)).toBe('59 s')
    expect(formatElapsed(999)).toBe('0 s')
  })

  it('reads a start time from a clock ahead of this one as 0 s', () => {
    expect(formatElapsed(-4_000)).toBe('0 s')
    expect(formatElapsed(null)).toBe('—')
  })
})

describe('plainValue — any stored value as plain words, whole', () => {
  it('reads text as it is, a list one item per line, an object one key per line', () => {
    expect(plainValue('Giacca nera')).toBe('Giacca nera')
    expect(plainValue(['Breathable', 'CE level 2'])).toBe('• Breathable\n• CE level 2')
    expect(plainValue({ unit: 'cm', value: 40 })).toBe('unit: cm\nvalue: 40')
    expect(plainValue([{ language: 'it', value: 'Giacca' }])).toBe('• language: it; value: Giacca')
  })
  it('names what is empty instead of printing JSON', () => {
    expect(plainValue(null)).toBe('Empty')
    expect(plainValue('')).toBe('(empty text)')
    expect(plainValue([])).toBe('Empty list')
    expect(plainValue({})).toBe('Empty')
    expect(plainValue(0)).toBe('0')
    expect(plainValue(false)).toBe('false')
  })
  it('puts a value on one line when asked', () => {
    expect(inlineValue({ accountId: 'a1', categories: ['JACKET', 'COAT'] })).toBe('accountId: a1; categories: JACKET, COAT')
  })
})
