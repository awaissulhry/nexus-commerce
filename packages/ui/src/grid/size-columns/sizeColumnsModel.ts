/**
 * SizeColumns' rules (B-W2b-207, design part SizeColumns), pure: a decimal per size as a person types it, writes it and
 * fills it. Values are decimal STRINGS ("62.5", "1.2000" from the API), never floats: the arithmetic of "fill from base by
 * increment" and of a total is done on scaled integers, so 1.1 + 3 × 0.1 is 1.4, not 1.4000000000000001.
 *
 * A missing value is a fact, not a zero: `null` is "— missing" on screen, a total over a missing size is missing, and a
 * fill never writes 0 for a size it cannot reach.
 *
 * Typing: one decimal separator, a point or a comma (a person in Italy types "62,5", one in England "62.5"), no grouping
 * (the factory's rule for decimals typed into a cell: "1.250" is one point two five). Spaces are ignored; an empty text, a
 * dash or the "missing" words clear the value.
 */

/** A decimal per size: the normalised text ("62.5"), or null for missing. */
export type SizeValue = string | null

export interface ParseSizeOptions {
  /** The most decimals a value may have (default 4: the factory's quantity scale). More is refused, never rounded. */
  scale?: number
  /** A minus sign is accepted (a grade rule's increment can be negative). Default false. */
  negative?: boolean
  /** Words that also mean "no value" (the page's "— missing", pasted back). */
  missingWords?: readonly string[]
}

export type ParsedSizeValue = { ok: true; value: SizeValue } | { ok: false }

const DASHES = new Set(['-', '—', '–', '−'])

/** A typed or pasted text as a decimal per size, or refused (the value is kept and the page says why). */
export function parseSizeValue(text: string | number | null | undefined, options: ParseSizeOptions = {}): ParsedSizeValue {
  if (text === null || text === undefined) return { ok: true, value: null }
  if (typeof text === 'number') return Number.isFinite(text) ? parseSizeValue(String(text), options) : { ok: false }
  const raw = text.trim()
  if (raw === '' || DASHES.has(raw)) return { ok: true, value: null }
  const said = raw.toLowerCase()
  if (options.missingWords?.some((word) => word.trim().toLowerCase() === said)) return { ok: true, value: null }
  const compact = raw.replace(/\s/g, '').replace('−', '-')
  const commas = (compact.match(/,/g) ?? []).length
  const points = (compact.match(/\./g) ?? []).length
  if (commas + points > 1) return { ok: false }
  const normal = compact.replace(',', '.')
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(normal)) return { ok: false }
  if (normal.startsWith('-') && !options.negative) return { ok: false }
  const negative = normal.startsWith('-')
  const [whole = '', fraction = ''] = normal.replace('-', '').split('.')
  if (fraction.length > (options.scale ?? 4)) return { ok: false }
  const cleanWhole = (whole || '0').replace(/^0+(?=\d)/, '')
  const cleanFraction = fraction.replace(/0+$/, '')
  const body = cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole
  return { ok: true, value: negative && /[1-9]/.test(body) ? `-${body}` : body }
}

/** A value from the API or a number as the normalised text ("6.3500" → "6.35"); null stays null; nonsense is null. */
export function sizeValueOf(value: string | number | null | undefined): SizeValue {
  const parsed = parseSizeValue(value, { scale: 12, negative: true })
  return parsed.ok ? parsed.value : null
}

/** How a value is written for reading, in the page's language ("62,5" in Italian); null for missing. */
export function sizeValueText(value: string | number | null | undefined, locale = 'en-GB', maxDecimals = 4): string | null {
  const normal = sizeValueOf(value)
  if (normal === null) return null
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxDecimals }).format(Number(normal))
}

/** How a value is typed back into its cell: the page's decimal separator, no grouping ("6,35" in Italian). */
export function sizeEditText(value: string | number | null | undefined, locale = 'en-GB'): string {
  const normal = sizeValueOf(value)
  if (normal === null) return ''
  return decimalComma(locale) ? normal.replace('.', ',') : normal
}

/** Does this language write the decimal with a comma? */
export function decimalComma(locale: string): boolean {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.5)
  return parts.find((part) => part.type === 'decimal')?.value === ','
}

// ---- decimal arithmetic on scaled integers --------------------------------------------------------------------------

const decimalsOf = (value: string) => (value.split('.')[1] ?? '').length
const scaled = (value: string, scale: number): bigint => {
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
  const digits = BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
  return negative ? -digits : digits
}
const unscaled = (amount: bigint, scale: number): string => {
  const negative = amount < 0n
  const digits = (negative ? -amount : amount).toString().padStart(scale + 1, '0')
  const whole = scale ? digits.slice(0, -scale) : digits
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, '') : ''
  const body = fraction ? `${whole}.${fraction}` : whole
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

/** a + b, exactly. */
export function addSizeValues(a: string, b: string): string {
  const scale = Math.max(decimalsOf(a), decimalsOf(b))
  return unscaled(scaled(a, scale) + scaled(b, scale), scale)
}

/** a × n (n a whole number), exactly. */
export function timesSizeValue(a: string, n: number): string {
  const scale = decimalsOf(a)
  return unscaled(scaled(a, scale) * BigInt(Math.trunc(n)), scale)
}

/** a − b as a number for a delta's sign and size (display only). */
export function compareSizeValues(a: string, b: string): -1 | 0 | 1 {
  const scale = Math.max(decimalsOf(a), decimalsOf(b))
  const d = scaled(a, scale) - scaled(b, scale)
  return d < 0n ? -1 : d > 0n ? 1 : 0
}

/** b − a, exactly ("+0.1" written by the caller). */
export function subtractSizeValues(b: string, a: string): string {
  const scale = Math.max(decimalsOf(a), decimalsOf(b))
  return unscaled(scaled(b, scale) - scaled(a, scale), scale)
}

// ---- fill from base by increment -----------------------------------------------------------------------------------

export interface SizeFillInput {
  /** The sizes in scale order. */
  sizes: readonly string[]
  /** The base size (its value is the start). */
  base: string | null | undefined
  /** The values now, by size. */
  values: Readonly<Record<string, SizeValue | undefined>>
  /** The increment per size step (normalised text; may be negative). */
  increment: string
  /** Sizes whose value was typed by hand and stays (an override); they are left out of the fill. */
  keep?: readonly string[]
}

export interface SizeFillChange {
  size: string
  from: SizeValue
  to: string
}

export type SizeFillResult =
  | { ok: true; changes: SizeFillChange[]; values: Record<string, SizeValue> }
  | { ok: false; problem: 'noBase' | 'baseMissing' | 'belowZero'; size?: string }

/**
 * "Fill from base by increment": each size = the base's value + (its steps from the base) × the increment. The base
 * keeps its value; a kept size (typed by hand) keeps its own; a size whose value would be 0 or below is refused whole
 * (a measurement or a quantity is never 0 or negative), naming the first such size.
 */
export function fillFromBase(input: SizeFillInput): SizeFillResult {
  const at = input.base ? input.sizes.indexOf(input.base) : -1
  if (at < 0 || !input.base) return { ok: false, problem: 'noBase' }
  const start = sizeValueOf(input.values[input.base] ?? null)
  if (start === null) return { ok: false, problem: 'baseMissing', size: input.base }
  const keep = new Set(input.keep ?? [])
  const values: Record<string, SizeValue> = {}
  const changes: SizeFillChange[] = []
  for (const [index, size] of input.sizes.entries()) {
    const now = sizeValueOf(input.values[size] ?? null)
    if (size === input.base || keep.has(size)) {
      values[size] = now
      continue
    }
    const to = addSizeValues(start, timesSizeValue(input.increment, index - at))
    if (compareSizeValues(to, '0') <= 0) return { ok: false, problem: 'belowZero', size }
    values[size] = to
    if (now === null || compareSizeValues(now, to) !== 0) changes.push({ size, from: now, to })
  }
  return { ok: true, changes, values }
}

// ---- totals and paste ----------------------------------------------------------------------------------------------

/** The total per size over rows; a size where any row is missing has no total (null), never a smaller number. */
export function sizeTotals<T>(rows: readonly T[], sizes: readonly string[], value: (row: T, size: string) => string | number | null | undefined): Array<{ size: string; total: SizeValue }> {
  return sizes.map((size) => {
    let total = '0'
    for (const row of rows) {
      const one = sizeValueOf(value(row, size))
      if (one === null) return { size, total: null }
      total = addSizeValues(total, one)
    }
    return { size, total: rows.length ? total : null }
  })
}

export interface SizePasteResult {
  /** The values that land, by size, from the first pasted size on. */
  values: Array<{ size: string; value: SizeValue }>
  /** Pasted texts that are not numbers (left out; the cell keeps its value). */
  refused: Array<{ size: string; text: string }>
  /** Pasted values past the last size (left out). */
  over: number
}

/**
 * A row pasted from a spreadsheet (tab-separated; a line of values separated by `;` or spaces too) across the sizes, from
 * `from` on. A grid with cell selection pastes through `valueParser` by itself; this is the same rule for a form.
 */
export function pasteSizeRow(text: string, sizes: readonly string[], from: string, options: ParseSizeOptions = {}): SizePasteResult {
  const first = sizes.indexOf(from)
  const line = text.replace(/\r?\n$/, '').split(/\r?\n/)[0] ?? ''
  const cells = line.includes('\t') ? line.split('\t') : line.includes(';') ? line.split(';') : line.trim().split(/\s+/)
  const result: SizePasteResult = { values: [], refused: [], over: 0 }
  if (first < 0) return { ...result, over: cells.length }
  cells.forEach((cell, offset) => {
    const size = sizes[first + offset]
    if (size === undefined) {
      result.over += 1
      return
    }
    const parsed = parseSizeValue(cell, options)
    if (parsed.ok) result.values.push({ size, value: parsed.value })
    else result.refused.push({ size, text: cell.trim() })
  })
  return result
}
