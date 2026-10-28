/**
 * Code 128, code set B (ISO/IEC 15417), for labels printed as PDF on any printer (plan A1 §3.9: hide labels and bundle
 * tickets "on any printer"). A ZPL printer draws its own Code 128 (`^BC`, ./zpl.ts); a PDF label draws the bars this
 * file computes. Code set B carries ASCII 32-126, which covers every scannable id (`HD-7K-0003RJ-M`: capitals, digits,
 * hyphens).
 *
 * A symbol is: start B (104), one symbol per character (its code minus 32), the check symbol (start + Σ value × position,
 * modulo 103), stop (106). Each symbol is 3 bars and 3 spaces, 11 modules wide; the stop is 13 (a final 2-module bar).
 * A reader needs a quiet zone of at least 10 modules on each side, which the painter leaves.
 */

/** The bar and space widths of symbols 0-106 (the public table of the standard), bar first. */
export const CODE128_PATTERNS: readonly string[] = Object.freeze([
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
])

export const CODE128_START_B = 104
export const CODE128_STOP = 106
/** The quiet zone a reader needs on each side, in modules. */
export const CODE128_QUIET_MODULES = 10

/** The symbol values of a text in code set B: start, data, check, stop. Throws a RangeError for an empty text or a character outside ASCII 32-126. */
export function code128Values(text: string): number[] {
  if (typeof text !== 'string' || text.length === 0) throw new RangeError('Code 128 needs at least one character.')
  const data = [...text].map((char) => {
    const code = char.charCodeAt(0)
    if (char.length !== 1 || code < 32 || code > 126) throw new RangeError(`Code 128 set B has no ${JSON.stringify(char)}.`)
    return code - 32
  })
  const check = data.reduce((sum, value, index) => sum + value * (index + 1), CODE128_START_B) % 103
  return [CODE128_START_B, ...data, check, CODE128_STOP]
}

export interface Code128Bars {
  /** The symbol's width in modules, quiet zones not included. */
  readonly modules: number
  /** Each dark bar: its left edge and width, in modules from the symbol's start. */
  readonly bars: readonly { readonly x: number; readonly width: number }[]
}

/** The dark bars of a text's Code 128 symbol, in modules (the painter scales them). */
export function code128Bars(text: string): Code128Bars {
  const bars: { x: number; width: number }[] = []
  let cursor = 0
  for (const value of code128Values(text)) {
    const pattern = CODE128_PATTERNS[value]!
    for (let index = 0; index < pattern.length; index++) {
      const width = pattern.charCodeAt(index) - 48
      if (index % 2 === 0) bars.push({ x: cursor, width })
      cursor += width
    }
  }
  return { modules: cursor, bars }
}
