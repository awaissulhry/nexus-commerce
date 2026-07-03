import { describe, it, expect } from 'vitest'
import { parseThemeAxes } from './themeAxes'

describe('parseThemeAxes', () => {
  it('splits on forward slash with surrounding spaces', () => {
    expect(parseThemeAxes('Size / Color')).toEqual(['Size', 'Color'])
  })

  it('splits on comma (no spaces)', () => {
    expect(parseThemeAxes('Colore,Taglia')).toEqual(['Colore', 'Taglia'])
  })

  it('returns empty array for empty string', () => {
    expect(parseThemeAxes('')).toEqual([])
  })

  it('returns empty array for null', () => {
    expect(parseThemeAxes(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(parseThemeAxes(undefined)).toEqual([])
  })

  it('trims whitespace around axis names', () => {
    expect(parseThemeAxes('Size , Color')).toEqual(['Size', 'Color'])
  })

  it('handles a single axis (no delimiter)', () => {
    expect(parseThemeAxes('Size')).toEqual(['Size'])
  })

  it('handles mixed delimiters — slash and comma', () => {
    expect(parseThemeAxes('Size/Color,Material')).toEqual(['Size', 'Color', 'Material'])
  })

  it('filters out empty segments from consecutive delimiters', () => {
    expect(parseThemeAxes('Size,,Color')).toEqual(['Size', 'Color'])
  })
})
