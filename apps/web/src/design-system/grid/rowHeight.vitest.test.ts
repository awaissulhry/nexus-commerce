import { describe, expect, it } from 'vitest'
import { rowHeightFor } from './rowHeight'

describe('rowHeightFor', () => {
  it('two-line: 40 · 43 · 49 — a muted second line fits at every density', () => {
    expect([rowHeightFor('two-line', 'compact'), rowHeightFor('two-line', 'cozy'), rowHeightFor('two-line', 'spacious')]).toEqual([40, 43, 49])
  })
  it('the other kinds keep their heights', () => {
    expect(['text', 'media', 'media-line'].map((k) => rowHeightFor(k as 'text', 'compact'))).toEqual([28, 52, 36])
    expect(['text', 'media', 'media-line'].map((k) => rowHeightFor(k as 'text', 'spacious'))).toEqual([49, 85, 60])
  })
})
