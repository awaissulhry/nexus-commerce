import { isNumberValue, MAX_NUMBER, MAX_YEAR, MIN_YEAR, type NumberReset } from './kinds'

/**
 * The printed form of a document number (feature PLT-122): a pattern of fixed text and tokens.
 *
 *   {N}      the number, as it is (42)
 *   {N:5}    the number with zeros in front up to 5 digits (00042); a longer number is printed in full
 *   {YYYY}   the series' year (2026)
 *   {YY}     its last two digits (26)
 *
 *   FT-{YYYY}-{N:5}  → FT-2026-00042        {N}/{YYYY}  → 42/2026        {N}/A  → 42/A        LOT-{N:6} → LOT-000042
 *
 * Fixed text is letters, digits and `-` `/` `.` `_`. A pattern holds `{N}` exactly once; the year tokens only in a
 * series that resets yearly, so the year printed is always the series' own. With one series row's pattern fixed (the
 * database refuses to change it once a number is issued), the printed number and the value determine each other:
 * `parseNumber` reads a printed number back, and a unique printed number means a unique value.
 */

export const MAX_PATTERN_LENGTH = 40
/** FatturaPA's Numero: at most 20 characters with at least one digit (SDI error 00425). */
export const MAX_FISCAL_NUMBER_LENGTH = 20
const MAX_PAD = 12

type Part = { readonly text: string } | { readonly token: 'N'; readonly pad: number } | { readonly token: 'YYYY' | 'YY' }

export interface Pattern {
  readonly source: string
  readonly parts: readonly Part[]
  readonly usesYear: boolean
}

export class PatternError extends Error {
  override name = 'PatternError'
}

const LITERAL = /^[A-Za-z0-9/._-]+$/
const TOKEN = /\{([^{}]*)\}/g

/** Reads a pattern. Throws a PatternError that says what is wrong, for the person who typed it. */
export function parsePattern(source: string): Pattern {
  if (typeof source !== 'string' || source.length === 0) throw new PatternError('The pattern is empty.')
  if (source.length > MAX_PATTERN_LENGTH) throw new PatternError(`The pattern is longer than ${MAX_PATTERN_LENGTH} characters.`)
  const parts: Part[] = []
  let at = 0
  let numbers = 0
  for (const match of source.matchAll(TOKEN)) {
    if (match.index > at) parts.push(literal(source.slice(at, match.index)))
    const token = match[1] ?? ''
    const padded = /^N:(\d{1,2})$/.exec(token)
    if (token === 'N' || padded) {
      const pad = padded ? Number.parseInt(padded[1]!, 10) : 1
      if (pad < 1 || pad > MAX_PAD) throw new PatternError(`{N:${padded?.[1]}}: the width is 1 to ${MAX_PAD} digits.`)
      parts.push({ token: 'N', pad })
      numbers++
    } else if (token === 'YYYY' || token === 'YY') {
      parts.push({ token })
    } else {
      throw new PatternError(`{${token}} is not a token; use {N}, {N:5}, {YYYY} or {YY}.`)
    }
    at = match.index + match[0].length
  }
  if (at < source.length) parts.push(literal(source.slice(at)))
  if (numbers !== 1) throw new PatternError(numbers === 0 ? 'The pattern needs {N}, the place of the number.' : 'The pattern may hold {N} only once.')
  return Object.freeze({ source, parts: Object.freeze(parts), usesYear: parts.some((part) => 'token' in part && part.token !== 'N') })
}

function literal(text: string): Part {
  if (!LITERAL.test(text)) {
    throw new PatternError(`"${text}": fixed text may hold letters, digits and - / . _ only (and { } only around a token).`)
  }
  return { text }
}

/** What is wrong with a pattern for a series with this reset, or null when it is fine. */
export function patternProblem(source: string, reset: NumberReset, fiscal: boolean): string | null {
  let pattern: Pattern
  try {
    pattern = parsePattern(source)
  } catch (error) {
    if (error instanceof PatternError) return error.message
    throw error
  }
  if (pattern.usesYear && reset !== 'YEARLY') return 'The year tokens fit only a series that starts again every year.'
  if (fiscal) {
    // The shortest number decides whether the pattern can fit at all; each issued number is checked again.
    const first = renderParts(pattern, 1, 2026)
    if (first.length > MAX_FISCAL_NUMBER_LENGTH) return `A fiscal number has at most ${MAX_FISCAL_NUMBER_LENGTH} characters; this pattern prints ${first} (${first.length}).`
  }
  return null
}

function renderParts(pattern: Pattern, value: number, year: number | null): string {
  return pattern.parts
    .map((part) => {
      if ('text' in part) return part.text
      if (part.token === 'N') return String(value).padStart(part.pad, '0')
      if (year === null) throw new PatternError('This pattern prints the year, but the series has none.')
      return part.token === 'YYYY' ? String(year) : String(year % 100).padStart(2, '0')
    })
    .join('')
}

export interface NumberParts {
  /** The number: 1 to 2,147,483,647. */
  readonly value: number
  /** The series' year; required when the pattern prints it. */
  readonly year?: number | null
}

/** The printed number. Throws a RangeError for a value or year out of range, a PatternError for a bad pattern. */
export function formatNumber(pattern: string | Pattern, { value, year = null }: NumberParts): string {
  const parsed = typeof pattern === 'string' ? parsePattern(pattern) : pattern
  if (!isNumberValue(value)) throw new RangeError(`a number is a whole number from 1 to ${MAX_NUMBER}, not ${String(value)}`)
  if (year !== null && (!Number.isSafeInteger(year) || year < MIN_YEAR || year > MAX_YEAR)) throw new RangeError(`not a year: ${String(year)}`)
  return renderParts(parsed, value, year)
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * The value of a printed number of a series with this pattern and year, or null when the text is not one: other fixed
 * text, another year, or a number written another way (missing or extra leading zeros). Letters are compared as typed.
 */
export function parseNumber(pattern: string | Pattern, text: string, year: number | null = null): number | null {
  const parsed = typeof pattern === 'string' ? parsePattern(pattern) : pattern
  if (typeof text !== 'string') return null
  if (parsed.usesYear && year === null) throw new PatternError('This pattern prints the year: name the series\' year.')
  let pad = 1
  const source = parsed.parts
    .map((part) => {
      if ('text' in part) return escape(part.text)
      if (part.token === 'N') {
        pad = part.pad
        return '(\\d+)'
      }
      return escape(part.token === 'YYYY' ? String(year) : String((year as number) % 100).padStart(2, '0'))
    })
    .join('')
  const match = new RegExp(`^${source}$`).exec(text)
  if (!match) return null
  const digits = match[1]!
  const value = Number.parseInt(digits, 10)
  if (!isNumberValue(value)) return null
  // Only the form formatNumber prints: "00042" for {N:5}, never "042" or "000042".
  return String(value).padStart(pad, '0') === digits ? value : null
}
