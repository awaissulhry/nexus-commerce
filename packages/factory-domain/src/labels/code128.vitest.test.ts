import { describe, expect, it } from 'vitest'
import { code128Bars, code128Values, CODE128_PATTERNS, CODE128_START_B, CODE128_STOP } from './code128'

describe('Code 128 set B', () => {
  it('has the 107 patterns of the standard: 3 bars and 3 spaces of 11 modules each, the stop 13, all different', () => {
    expect(CODE128_PATTERNS).toHaveLength(107)
    for (const [value, pattern] of CODE128_PATTERNS.entries()) {
      const widths = [...pattern].map(Number)
      expect(widths.every((width) => width >= 1 && width <= 4), `symbol ${value}`).toBe(true)
      expect(widths.reduce((sum, width) => sum + width, 0), `symbol ${value}`).toBe(value === CODE128_STOP ? 13 : 11)
      expect(widths, `symbol ${value}`).toHaveLength(value === CODE128_STOP ? 7 : 6)
      // Every symbol's bars take an even number of modules (the standard's parity rule).
      expect((widths[0]! + widths[2]! + widths[4]!) % 2, `symbol ${value}`).toBe(0)
    }
    expect(new Set(CODE128_PATTERNS).size).toBe(107)
    expect(CODE128_PATTERNS[CODE128_START_B]).toBe('211214')
    expect(CODE128_PATTERNS[CODE128_STOP]).toBe('2331112')
  })

  it('encodes start B, the data, the check symbol (start + Σ value × position, mod 103) and stop', () => {
    // P J J 1 2 3 C → 48 42 42 17 18 19 35; 104 + 48 + 84 + 126 + 68 + 90 + 114 + 245 = 879 = 8 × 103 + 55.
    expect(code128Values('PJJ123C')).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106])
    expect(code128Values('HD-6F-000471-X').at(-2)).toBe(
      ([...'HD-6F-000471-X'].reduce((sum, char, index) => sum + (char.charCodeAt(0) - 32) * (index + 1), 104) % 103),
    )
  })

  it('lays the bars out in modules: 11 per symbol and 13 for the stop, starting and ending with a bar', () => {
    const symbol = code128Bars('HD-6F-000471-X')
    expect(symbol.modules).toBe((14 + 2) * 11 + 13)
    expect(symbol.bars[0]).toEqual({ x: 0, width: 2 })
    const last = symbol.bars.at(-1)!
    expect(last.x + last.width).toBe(symbol.modules)
    // Bars never overlap and are separated by spaces.
    for (let index = 1; index < symbol.bars.length; index++) expect(symbol.bars[index]!.x).toBeGreaterThan(symbol.bars[index - 1]!.x + symbol.bars[index - 1]!.width)
    expect(symbol.bars).toHaveLength(16 * 3 + 4)
  })

  it('refuses an empty text and characters outside ASCII 32-126', () => {
    expect(() => code128Values('')).toThrow(RangeError)
    expect(() => code128Values('è')).toThrow(/no "è"/)
    expect(() => code128Values('a\tb')).toThrow(RangeError)
  })
})
