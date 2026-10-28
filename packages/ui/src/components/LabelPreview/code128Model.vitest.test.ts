import { describe, expect, it } from 'vitest'

import {
  CODE128_CODE_B,
  CODE128_CODE_C,
  CODE128_PATTERNS,
  CODE128_QUIET_MODULES,
  CODE128_START_B,
  CODE128_START_C,
  CODE128_STOP,
  code128Bars,
  code128Check,
  code128ModuleString,
  encodeCode128,
  isCode128Text,
} from './code128Model'

/**
 * Known vectors. Each symbol list and module string below was decoded back to its value by ZXing's own Code 128 reader
 * (`@zxing/library` `Code128Reader.decodeRow`, which also checks the check symbol) when this encoder was written; the
 * reader is not a dependency of the design system, so the vectors are kept here as data. The check symbols can be
 * worked by hand: (start + Σ position × value) mod 103.
 */
const VECTORS: ReadonlyArray<{ value: string; symbols: number[]; check: number; modules: number }> = [
  // Set B only — the textbook example: 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879; 879 mod 103 = 55.
  { value: 'PJJ123C', symbols: [104, 48, 42, 42, 17, 18, 19, 35, 55, 106], check: 55, modules: 112 },
  // Set C only: 105 + 12·1 + 34·2 + 56·3 + 78·4 + 90·5 = 1115; mod 103 = 85.
  { value: '1234567890', symbols: [105, 12, 34, 56, 78, 90, 85, 106], check: 85, modules: 90 },
  { value: '12', symbols: [105, 12, 14, 106], check: 14, modules: 46 },
  // Three digits: no gain from C.
  { value: '123', symbols: [104, 17, 18, 19, 8, 106], check: 8, modules: 68 },
  // A bundle id: B, then C for the 6-digit run (Code C = 99), back to B (Code B = 100).
  { value: 'B-000123-04', symbols: [104, 34, 13, 99, 0, 1, 23, 100, 13, 16, 20, 1, 106], check: 1, modules: 145 },
  // A run of 4 at the end goes to C.
  { value: 'BDG-0007', symbols: [104, 34, 36, 39, 13, 99, 0, 7, 99, 106], check: 99, modules: 112 },
  // An odd run at the end spends its first digit in B.
  { value: 'X1234', symbols: [104, 56, 99, 12, 34, 15, 106], check: 15, modules: 79 },
  { value: 'SER2026000123', symbols: [104, 51, 37, 50, 99, 20, 26, 0, 1, 23, 10, 106], check: 10, modules: 134 },
  // Starts in C (4+ digits), odd run: back to B for the last digit and the letters.
  { value: '12345AB', symbols: [105, 12, 34, 100, 21, 33, 34, 11, 106], check: 11, modules: 101 },
  { value: '987654321', symbols: [105, 98, 76, 54, 32, 100, 17, 11, 106], check: 11, modules: 101 },
  // Space, tilde and punctuation stay in B.
  { value: ' ~!', symbols: [104, 0, 94, 1, 89, 106], check: 89, modules: 68 },
  { value: 'LOT 77/12', symbols: [104, 44, 47, 52, 0, 23, 23, 15, 17, 18, 24, 106], check: 24, modules: 134 },
]

/** Reads bar/space widths back into symbols with the same table — a round trip independent of the encoder's choices. */
function decodeWidths(widths: readonly number[]): number[] {
  const table = new Map(CODE128_PATTERNS.map((p, i) => [p, i]))
  const out: number[] = []
  let i = 0
  while (i < widths.length) {
    const take = widths.length - i === 7 ? 7 : 6
    const symbol = table.get(widths.slice(i, i + take).join(''))
    if (symbol == null) throw new Error(`no symbol at ${i}`)
    out.push(symbol)
    i += take
  }
  return out
}

/** Symbols back to text, following the code-set switches. */
function decodeText(symbols: readonly number[]): string {
  let set = symbols[0] === CODE128_START_C ? 'C' : 'B'
  let text = ''
  for (const s of symbols.slice(1, -2)) {
    if (set === 'B' && s === CODE128_CODE_C) set = 'C'
    else if (set === 'C' && s === CODE128_CODE_B) set = 'B'
    else text += set === 'C' ? String(s).padStart(2, '0') : String.fromCharCode(s + 32)
  }
  return text
}

describe('Code 128 encoding (G11)', () => {
  it('the symbol table: 107 symbols, 11 modules each, STOP 13; 3 bars + 3 spaces', () => {
    expect(CODE128_PATTERNS).toHaveLength(107)
    CODE128_PATTERNS.forEach((p, i) => {
      const sum = [...p].reduce((a, c) => a + Number(c), 0)
      expect(sum, `symbol ${i}`).toBe(i === CODE128_STOP ? 13 : 11)
      expect(p.length, `symbol ${i}`).toBe(i === CODE128_STOP ? 7 : 6)
    })
    expect(new Set(CODE128_PATTERNS).size).toBe(107)
    expect([CODE128_START_B, CODE128_START_C, CODE128_CODE_B, CODE128_CODE_C, CODE128_STOP]).toEqual([104, 105, 100, 99, 106])
  })

  it.each(VECTORS)('$value → known symbols and check symbol', ({ value, symbols, check, modules }) => {
    const enc = encodeCode128(value)
    expect(enc).not.toBeNull()
    expect(enc!.symbols).toEqual(symbols)
    expect(enc!.check).toBe(check)
    expect(enc!.modules).toBe(modules)
    // 11 modules a symbol, 13 for STOP.
    expect(enc!.modules).toBe((symbols.length - 1) * 11 + 13)
    // The check symbol is the weighted sum of start and data, mod 103.
    expect(code128Check(symbols.slice(0, -2))).toBe(check)
  })

  it.each(VECTORS)('$value round-trips through the widths', ({ value }) => {
    const enc = encodeCode128(value)!
    const symbols = decodeWidths(enc.widths)
    expect(symbols).toEqual(enc.symbols)
    expect(decodeText(symbols)).toBe(value)
  })

  it('the exact modules of two vectors (ZXing-decoded), bar first, starting and ending with a bar', () => {
    expect(code128ModuleString(encodeCode128('12')!)).toBe('1101001110010110011100100110011101100011101011')
    expect(code128ModuleString(encodeCode128('PJJ123C')!)).toBe(
      '1101001000011101110110101101110001011011100010011100110110011100101100101110010001000110111010001101100011101011',
    )
  })

  it('refuses what Code 128 B/C cannot carry: empty, accents, control characters', () => {
    expect(encodeCode128('')).toBeNull()
    expect(encodeCode128('Città')).toBeNull()
    expect(encodeCode128('A\tB')).toBeNull()
    expect(isCode128Text('B-000123-04')).toBe(true)
    expect(isCode128Text('€5')).toBe(false)
  })

  it('bars sit after the quiet zone and cover the bar widths only', () => {
    const enc = encodeCode128('12')!
    const bars = code128Bars(enc)
    expect(bars[0]).toEqual([CODE128_QUIET_MODULES, 2])
    const ink = bars.reduce((a, [, w]) => a + w, 0)
    expect(ink).toBe([...code128ModuleString(enc)].filter((c) => c === '1').length)
    const [x, w] = bars[bars.length - 1]
    expect(x + w).toBe(CODE128_QUIET_MODULES + enc.modules)
  })
})
