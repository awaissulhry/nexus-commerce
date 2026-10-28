/**
 * Code 128 — a small, pure encoder for the label preview (gap G11): a value in, the bar and space widths out. No
 * dependency, no DOM; the SVG is `Code128.tsx`.
 *
 * The idea is the legacy `apps/web/src/components/ui/Barcode128.tsx` (the public symbol table, the weighted
 * modulo-103 check), rebuilt to encode more than set B:
 *
 * - **Characters**: printable ASCII, space to `~` (32–126) — every code a ticket, tag or badge carries. Anything else
 *   (an accented letter, a control character) cannot be encoded: `encodeCode128` returns null and the preview says
 *   so instead of drawing a barcode that scans as something else. No FNC1 / GS1-128 (a carrier's own label carries its
 *   own barcode).
 * - **Code sets B and C**, switched the usual way so number runs take half the width: start in C when the value opens
 *   with 4 or more digits (or is exactly 2); in B, move to C for a run of 6 or more digits (4 or more at the end), an
 *   odd run first spending one digit in B; leave C when fewer than 2 digits are left in the run.
 * - **Check symbol**: (start + Σ position × value) mod 103, positions from 1 over every symbol after the start,
 *   code-set switches included.
 * - **Widths**: each symbol is 3 bars and 3 spaces over 11 modules; the stop is 13 (a final 2-module bar). The quiet
 *   zone (10 modules a side) is the drawing's, not part of these widths.
 *
 * Verified by decoding with ZXing's Code 128 reader, which also checks the check symbol (vectors in
 * `code128Model.vitest.test.ts`).
 */

/** Bar/space widths of symbols 0–106, bar first. 106 is STOP (seven widths). Public symbol table. */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

export const CODE128_START_B = 104
export const CODE128_START_C = 105
/** In set B: switch to C. */
export const CODE128_CODE_C = 99
/** In set C: switch to B. */
export const CODE128_CODE_B = 100
export const CODE128_STOP = 106
/** Modules of blank space each side of the bars. */
export const CODE128_QUIET_MODULES = 10

export interface Code128Encoding {
  /** The value encoded. */
  value: string
  /** Every symbol in order: start, data and switches, check, stop. */
  symbols: number[]
  /** The check symbol's value (0–102). */
  check: number
  /** Bar and space widths in modules, bar first, from the start symbol through the stop (no quiet zone). */
  widths: number[]
  /** Sum of `widths`. */
  modules: number
}

/** Printable ASCII, space to tilde: what set B holds. */
export const isCode128Text = (value: string): boolean => value.length > 0 && /^[\x20-\x7e]+$/.test(value)

const isDigit = (c: string) => c >= '0' && c <= '9'

function digitRun(value: string, from: number): number {
  let i = from
  while (i < value.length && isDigit(value[i])) i++
  return i - from
}

/** The symbol values for `value` (start and data, no check or stop). */
function dataSymbols(value: string): number[] {
  const out: number[] = []
  const lead = digitRun(value, 0)
  let set: 'B' | 'C' = lead >= 4 || (lead === 2 && value.length === 2) ? 'C' : 'B'
  out.push(set === 'C' ? CODE128_START_C : CODE128_START_B)
  let i = 0
  while (i < value.length) {
    if (set === 'C') {
      if (digitRun(value, i) >= 2) {
        out.push(Number(value.slice(i, i + 2)))
        i += 2
      } else {
        out.push(CODE128_CODE_B)
        set = 'B'
      }
      continue
    }
    const run = digitRun(value, i)
    if (run >= 6 || (run >= 4 && i + run === value.length)) {
      if (run % 2 === 1) {
        out.push(value.charCodeAt(i) - 32)
        i++
      }
      out.push(CODE128_CODE_C)
      set = 'C'
      continue
    }
    out.push(value.charCodeAt(i) - 32)
    i++
  }
  return out
}

/** The check symbol for a start-and-data sequence. */
export function code128Check(startAndData: readonly number[]): number {
  return startAndData.reduce((sum, v, i) => sum + v * Math.max(1, i), 0) % 103
}

/** Encodes `value`, or returns null when it holds a character Code 128 B/C cannot carry (or is empty). */
export function encodeCode128(value: string): Code128Encoding | null {
  if (!isCode128Text(value)) return null
  const data = dataSymbols(value)
  const check = code128Check(data)
  const symbols = [...data, check, CODE128_STOP]
  const widths = symbols.flatMap((s) => [...CODE128_PATTERNS[s]].map(Number))
  return { value, symbols, check, widths, modules: widths.reduce((a, b) => a + b, 0) }
}

/** The bars as [x, width] in modules, after a quiet zone of `quiet` modules. */
export function code128Bars(encoding: Pick<Code128Encoding, 'widths'>, quiet = CODE128_QUIET_MODULES): Array<[number, number]> {
  const bars: Array<[number, number]> = []
  let x = quiet
  encoding.widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push([x, w])
    x += w
  })
  return bars
}

/** The modules as 1 (bar) and 0 (space), quiet zone excluded — for a test or a printer. */
export function code128ModuleString(encoding: Pick<Code128Encoding, 'widths'>): string {
  return encoding.widths.map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w)).join('')
}
