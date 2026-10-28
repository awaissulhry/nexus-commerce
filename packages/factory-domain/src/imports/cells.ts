import { z } from 'zod'
import { INT_MAX, INT_MIN } from '../core/money'
import { isBusinessDate } from '../core/time'
import { Dec, type Decimal } from '../tax/decimal'

/**
 * Reading one cell of an imported sheet (plan A1 W0-22; feature PLT-176), pure. A column of an importer says its type
 * with one of the `cell.*` builders below: each is a zod schema that takes the raw cell a sheet reader gives (text from
 * a CSV, a number, boolean or date from Excel) and returns a plain JSON value, or fails with a message a person can
 * act on. Messages never repeat the cell's value: a money cell must not reach someone without its grain through an
 * error, and an error file is shared more widely than the sheet.
 *
 *   cell.text({ max })            trimmed text (inner runs of spaces kept)
 *   cell.code({ max, upper })     a code: trimmed, no spaces inside; upper-cased when `upper`
 *   cell.integer({ min, max })    a whole number (PostgreSQL Int range unless narrower)
 *   cell.decimal({ precision, scale })   a decimal string ("1234.56"), never a float: Decimal(precision, scale)
 *   cell.minorUnits({ places })   an amount in major units ("1.234,56") → integer minor units (123456)
 *   cell.date()                   a calendar day YYYY-MM-DD: 31/12/2026, 31.12.2026, 2026-12-31, an Excel date
 *   cell.boolean()                sì/si/no, yes/no, vero/falso, true/false, x, 1/0
 *   cell.oneOf(values, aliases)   one of the values, matched without case or accents (and by alias)
 *   cell.email()                  an email address, lower-cased
 *
 * Numbers follow the job's number format (`NumberFormat`), Italian by default: `1.234,56` (dot for thousands, comma
 * for decimals). With `it`, a lone dot followed by exactly three digits is a thousands dot (1.234 = 1234); any other
 * lone dot is a decimal point (12.5). With `en` the roles of dot and comma swap (1,234.56; 1,234 = 1234; 12,5 = 12.5).
 * Excel number cells are read as their shortest decimal text, which is what Excel shows at full precision. Dates are
 * day first (31/12/2026), or ISO; a two-digit year is 20yy.
 *
 * A blank cell (nothing, or only spaces) is never parsed here: the row parser treats it as "not given" (plan.ts).
 */

/** A cell as a sheet reader gives it. */
export type RawCell = string | number | boolean | Date | null | undefined

/** A parsed cell: plain JSON. Decimals and dates are strings. */
export type CellValue = string | number | boolean

export const NUMBER_FORMATS = ['it', 'en'] as const
export type NumberFormat = (typeof NUMBER_FORMATS)[number]

/** What the parsers need besides the cell: the job's number format. */
export interface CellContext {
  readonly numberFormat: NumberFormat
}

/** The longest text a cell may hold (a whole page of notes). */
export const MAX_CELL_TEXT = 32_000

export function isBlank(raw: RawCell): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')
}

/** What kind of value a column holds: how values are compared in the dry run, and how a template describes it. */
export type CellKind = 'text' | 'code' | 'integer' | 'decimal' | 'minorUnits' | 'date' | 'boolean' | 'oneOf' | 'email'

export interface CellMeta {
  readonly kind: CellKind
  /** A short description for the import screen and the template ("a number with up to 6 decimals"). */
  readonly describe: string
  /** For oneOf: the values. */
  readonly values?: readonly string[]
}

/** The cell builders' metadata, by schema (a column whose type is any other zod schema compares with ===). */
export const CELL_META = z.registry<CellMeta>()

/** A raw cell together with the job's number format: what a column's schema parses. */
export interface CellInput {
  readonly raw: RawCell
  readonly context: CellContext
}

type Ctx = z.core.$RefinementCtx<unknown>

const fail = (ctx: Ctx, input: unknown, message: string): never => {
  ctx.issues.push({ code: 'custom', message, input })
  return z.NEVER as never
}

/** The text of a cell: strings trimmed; Excel numbers as their shortest decimal text; booleans and dates refused. */
function textOf(raw: RawCell): string | null {
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

/** Builds a column type: a schema over { raw, context } with its metadata. */
function builder<T extends CellValue>(meta: CellMeta, read: (input: CellInput, ctx: Ctx) => T): z.ZodType<T, CellInput> {
  const schema = z
    .custom<CellInput>((value) => value !== null && typeof value === 'object' && 'context' in (value as object))
    .transform((input, ctx) => read(input, ctx as Ctx)) as unknown as z.ZodType<T, CellInput>
  schema.register(CELL_META, meta)
  return schema
}

// ---- numbers ----------------------------------------------------------------------------------------------------------

const SPACES = /[\s  ]/g

/**
 * A number written by a person, as a plain decimal string ("-1234.56"), or null when it is not one. No exponent, no
 * currency other than a leading or trailing €, no percent sign.
 */
export function readNumberText(text: string, format: NumberFormat): string | null {
  let value = text.replace(SPACES, '')
  if (value.startsWith('€')) value = value.slice(1)
  else if (value.endsWith('€')) value = value.slice(0, -1)
  let sign = ''
  if (value.startsWith('-') || value.startsWith('+')) {
    sign = value.startsWith('-') ? '-' : ''
    value = value.slice(1)
  }
  if (!/^[\d.,]+$/.test(value) || !/\d/.test(value)) return null
  const thousands = format === 'it' ? '.' : ','
  const decimals = format === 'it' ? ',' : '.'
  const hasThousands = value.includes(thousands)
  const hasDecimals = value.includes(decimals)
  let integer: string
  let fraction = ''
  if (hasThousands && hasDecimals) {
    const at = value.lastIndexOf(decimals)
    if (value.indexOf(decimals) !== at || value.indexOf(thousands) > at) return null
    integer = value.slice(0, at)
    fraction = value.slice(at + 1)
    if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(integer) || integer.includes(decimals)) return null
    integer = integer.split(thousands).join('')
  } else if (hasThousands) {
    // Only the thousands mark: groups of three (1.234, 1.234.567), or a lone mark that cannot be one: a decimal point.
    const parts = value.split(thousands)
    if (/^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((part) => /^\d{3}$/.test(part))) integer = parts.join('')
    else if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') [integer, fraction] = parts as [string, string]
    else return null
  } else if (hasDecimals) {
    const parts = value.split(decimals)
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null
    ;[integer, fraction] = parts as [string, string]
  } else {
    integer = value
  }
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction)) return null
  const plain = `${sign}${integer}${fraction ? `.${fraction}` : ''}`
  return plain === '-0' ? '0' : plain
}

/** The cell as a decimal, or null. Excel numbers are exact as text (String(n) is the shortest round-trip form). */
function decimalOf(raw: RawCell, format: NumberFormat): Decimal | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Dec(String(raw)) : null
  if (typeof raw !== 'string') return null
  const text = readNumberText(raw, format)
  return text === null ? null : new Dec(text)
}

const numberHint = (format: NumberFormat): string => (format === 'it' ? 'like 1.234,56 or 1234,56' : 'like 1,234.56 or 1234.56')

/** A decimal as a plain string without exponent or trailing zeros: "12.5", "-3", "0.000001". */
export function plainDecimal(value: Decimal): string {
  const text = value.toFixed()
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

// ---- dates ------------------------------------------------------------------------------------------------------------

const pad = (value: number, size = 2): string => String(value).padStart(size, '0')

/** Excel's serial day (1900 date system, days since 1899-12-30) as YYYY-MM-DD. */
function excelSerialDate(serial: number): string | null {
  if (!Number.isInteger(serial) || serial < 1 || serial > 2_958_465) return null
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** A date written by a person (day first, or ISO) or given by Excel, as YYYY-MM-DD; null when it is not one. */
export function readDate(raw: RawCell): string | null {
  if (raw instanceof Date) {
    if (!Number.isFinite(raw.getTime())) return null
    // Excel date cells come as the day's UTC midnight (with the time of day for a date-time cell).
    return `${pad(raw.getUTCFullYear(), 4)}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`
  }
  if (typeof raw === 'number') return excelSerialDate(raw)
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  let iso: string | null = null
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(text)
  if (isoMatch) iso = `${isoMatch[1]}-${pad(Number.parseInt(isoMatch[2]!, 10))}-${pad(Number.parseInt(isoMatch[3]!, 10))}`
  else if (dayFirst) {
    const year = dayFirst[3]!.length === 2 ? 2000 + Number.parseInt(dayFirst[3]!, 10) : Number.parseInt(dayFirst[3]!, 10)
    iso = `${pad(year, 4)}-${pad(Number.parseInt(dayFirst[2]!, 10))}-${pad(Number.parseInt(dayFirst[1]!, 10))}`
  }
  return iso !== null && isBusinessDate(iso) ? iso : null
}

// ---- words ------------------------------------------------------------------------------------------------------------

/** Lower case, accents removed, spaces collapsed: how words are compared (headers, enum values, booleans). */
export function foldWord(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const TRUE_WORDS = new Set(['si', 'sì', 'yes', 'y', 's', 'true', 'vero', 'x', '1'].map(foldWord))
const FALSE_WORDS = new Set(['no', 'n', 'false', 'falso', '0'].map(foldWord))

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ---- the builders -----------------------------------------------------------------------------------------------------

export interface TextOptions {
  /** Default 200. At most MAX_CELL_TEXT. */
  readonly max?: number
  readonly min?: number
}

export const cell = {
  text(options: TextOptions = {}) {
    const max = Math.min(options.max ?? 200, MAX_CELL_TEXT)
    const min = options.min ?? 1
    return builder({ kind: 'text', describe: `text, up to ${max} characters` }, ({ raw }, ctx) => {
      const text = textOf(raw)
      if (text === null) return fail(ctx, raw, 'Expected text.')
      if (text.length > max) return fail(ctx, raw, `At most ${max} characters.`)
      if (text.length < min) return fail(ctx, raw, `At least ${min} characters.`)
      return text
    })
  },

  code(options: { readonly max?: number; readonly upper?: boolean } = {}) {
    const max = options.max ?? 64
    return builder({ kind: 'code', describe: `a code without spaces, up to ${max} characters` }, ({ raw }, ctx) => {
      const text = textOf(raw)
      if (text === null || text === '') return fail(ctx, raw, 'Expected a code.')
      if (/\s/.test(text)) return fail(ctx, raw, 'A code has no spaces.')
      if (text.length > max) return fail(ctx, raw, `At most ${max} characters.`)
      return options.upper ? text.toUpperCase() : text
    })
  },

  integer(options: { readonly min?: number; readonly max?: number } = {}) {
    const min = Math.max(options.min ?? INT_MIN, INT_MIN)
    const max = Math.min(options.max ?? INT_MAX, INT_MAX)
    return builder({ kind: 'integer', describe: `a whole number from ${min} to ${max}` }, ({ raw, context }, ctx) => {
      const value = decimalOf(raw, context.numberFormat)
      if (value === null) return fail(ctx, raw, `Expected a whole number like ${context.numberFormat === 'it' ? '1.234' : '1,234'} or 1234.`)
      if (!value.isInteger()) return fail(ctx, raw, 'Expected a whole number, without decimals.')
      if (value.lessThan(min) || value.greaterThan(max)) return fail(ctx, raw, `Expected a whole number from ${min} to ${max}.`)
      return Number.parseInt(value.toFixed(0), 10)
    })
  },

  decimal(options: { readonly precision?: number; readonly scale?: number; readonly min?: string } = {}) {
    const precision = options.precision ?? 18
    const scale = options.scale ?? 6
    const min = options.min === undefined ? null : new Dec(options.min)
    return builder({ kind: 'decimal', describe: `a number with up to ${scale} decimals` }, ({ raw, context }, ctx) => {
      const value = decimalOf(raw, context.numberFormat)
      if (value === null) return fail(ctx, raw, `Expected a number ${numberHint(context.numberFormat)}.`)
      if (value.decimalPlaces() > scale) return fail(ctx, raw, `At most ${scale} decimals.`)
      if (value.abs().greaterThanOrEqualTo(new Dec(10).pow(precision - scale))) return fail(ctx, raw, `At most ${precision - scale} digits before the decimals.`)
      if (min !== null && value.lessThan(min)) return fail(ctx, raw, `At least ${plainDecimal(min)}.`)
      return plainDecimal(value)
    })
  },

  minorUnits(options: { readonly places?: number; readonly min?: number } = {}) {
    const places = options.places ?? 2
    return builder({ kind: 'minorUnits', describe: `an amount with up to ${places} decimals` }, ({ raw, context }, ctx) => {
      const value = decimalOf(raw, context.numberFormat)
      if (value === null) return fail(ctx, raw, `Expected an amount ${numberHint(context.numberFormat)}.`)
      if (value.decimalPlaces() > places) return fail(ctx, raw, `At most ${places} decimals.`)
      const minor = value.times(new Dec(10).pow(places))
      if (minor.lessThan(INT_MIN) || minor.greaterThan(INT_MAX)) return fail(ctx, raw, 'The amount is too large.')
      const result = Number.parseInt(minor.toFixed(0), 10)
      if (options.min !== undefined && result < options.min) return fail(ctx, raw, 'The amount is too small.')
      return result
    })
  },

  date() {
    return builder({ kind: 'date', describe: 'a date like 31/12/2026 or 2026-12-31' }, ({ raw }, ctx) => {
      const value = readDate(raw)
      return value ?? fail(ctx, raw, 'Expected a date like 31/12/2026 or 2026-12-31.')
    })
  },

  boolean() {
    return builder({ kind: 'boolean', describe: 'sì or no (yes or no)' }, ({ raw }, ctx) => {
      if (typeof raw === 'boolean') return raw
      const text = textOf(raw)
      const word = text === null ? '' : foldWord(text)
      if (TRUE_WORDS.has(word)) return true
      if (FALSE_WORDS.has(word)) return false
      return fail(ctx, raw, 'Expected sì or no (yes or no).')
    })
  },

  oneOf<const V extends string>(values: readonly V[], aliases: Readonly<Record<string, V>> = {}) {
    const lookup = new Map<string, V>()
    for (const value of values) lookup.set(foldWord(value), value)
    for (const [alias, value] of Object.entries(aliases)) lookup.set(foldWord(alias), value)
    const shown = values.join(', ')
    return builder<V>({ kind: 'oneOf', describe: `one of ${shown}`, values }, ({ raw }, ctx) => {
      const text = textOf(raw)
      const found = text === null ? undefined : lookup.get(foldWord(text))
      return found ?? fail(ctx, raw, `Expected one of ${shown}.`)
    })
  },

  email() {
    return builder({ kind: 'email', describe: 'an email address' }, ({ raw }, ctx) => {
      const text = textOf(raw)
      if (text === null || !EMAIL.test(text) || text.length > 254) return fail(ctx, raw, 'Expected an email address.')
      return text.toLowerCase()
    })
  },
} as const

/** The metadata of a column type made by a `cell.*` builder, if it is one. */
export function cellMetaOf(schema: z.ZodType): CellMeta | undefined {
  return CELL_META.get(schema)
}

/** Two parsed values of one column are the same value (decimals by value: "12.50" = "12.5"). */
export function sameValue(meta: CellMeta | undefined, a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (meta?.kind === 'decimal' && typeof a === 'string' && typeof b === 'string') {
    try {
      return new Dec(a).equals(new Dec(b))
    } catch {
      return false
    }
  }
  return false
}
