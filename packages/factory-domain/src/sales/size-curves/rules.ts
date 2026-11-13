import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { decimalText } from '../../product/units/units'
import { Dec, HUNDRED, ZERO, parseDecimal, sum, type Decimal } from '../../tax/decimal'
import { MAX_SIZE_QUANTITY } from '../quotes/quotes'

/**
 * Size curves and filling a size run (B-W2b-302; SAL-269 "Size curve fill speeds daily brand orders", follow-up QT2:01 "Fill a
 * line from a prepack"; design sales.settings ssettings.curves, sales.quotes quote.lines.blocks "Fill by curve"), pure.
 *
 * A size curve (factory-db SizeCurve) is the shares of a size scale's sizes in percent, totalling exactly 100 (a curve of a
 * company, or of every company: null). A fill makes a line's size quantities from a curve and a total in WHOLE pieces: each
 * size gets floor(total × share ÷ 100), and what rounding leaves goes on the base size (the style's base size when the line
 * takes it, else the size with the largest share, the first of them in the scale's order). A curve over the whole scale is
 * used on a style made in part of it: the sizes the line cannot take (outside the style's range, or not an ACTIVE SKU of the
 * colourway) are left out and the rest share the total in their own proportion — said in words (`leftOut`). A prepack fills a
 * line with its pieces per size × the packs (a pack by colourway gives the line its own colourway's pieces and the pieces
 * without a colourway).
 */

export const SIZE_CURVE_LIMITS = { name: 120, sizes: 100, total: 1_000_000, packs: 10_000 } as const

export const SIZE_CURVE_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const
export type SizeCurveChange = (typeof SIZE_CURVE_CHANGES)[number]

const SHARE = /^\d{1,3}(\.\d{1,4})?$/

/** A share as stored: 4 decimals ("40.0000"). */
export const shareText = (value: Decimal | string): string => new Dec(value).toFixed(4)

/** A curve's name: one line, 1 to 120 characters. */
export function curveNameProblems(name: string | undefined, at = 'body/name'): Issue[] {
  if (name === undefined) return []
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > SIZE_CURVE_LIMITS.name || /[\r\n]/.test(trimmed)) return [{ path: at, message: `A name of one line, 1 to ${SIZE_CURVE_LIMITS.name} characters.` }]
  return []
}

/**
 * The shares typed: 1 to 100 sizes of the scale, each a percent above 0 and at most 100 with at most 4 decimals, totalling
 * exactly 100 (the database checks the same; the screen holds Save until 100 %).
 */
export function sharesProblems(shares: Readonly<Record<string, string>>, scaleSizes: readonly string[], at = 'body/shares'): Issue[] {
  const issues: Issue[] = []
  const entries = Object.entries(shares)
  if (entries.length === 0 || entries.length > SIZE_CURVE_LIMITS.sizes) return [{ path: at, message: `A curve shares 1 to ${SIZE_CURVE_LIMITS.sizes} sizes of its scale.` }]
  let total: Decimal = ZERO
  for (const [size, share] of entries) {
    if (!scaleSizes.includes(size)) issues.push({ path: `${at}/${size}`, message: `Size ${size} is not a size of the scale (${scaleSizes.join(', ')}).` })
    const value = SHARE.test(share.trim()) ? parseDecimal(share.trim()) : null
    if (value === null || value.lte(0) || value.gt(100) || !fitsDecimal(share.trim(), 7, 4)) {
      issues.push({ path: `${at}/${size}`, message: `Size ${size}: a share above 0 and at most 100 percent, at most 4 decimals.` })
      continue
    }
    total = total.plus(value)
  }
  if (issues.length === 0 && !total.eq(HUNDRED)) issues.push({ path: at, message: `The shares total ${decimalText(total)} %: a curve totals exactly 100 %.` })
  return issues
}

/** The shares as stored ({size: "40.0000"}), in the scale's order. */
export function sharesOf(shares: Readonly<Record<string, string>>, scaleSizes: readonly string[]): Record<string, string> {
  const rank = (size: string) => (scaleSizes.includes(size) ? scaleSizes.indexOf(size) : Number.MAX_SAFE_INTEGER)
  return Object.fromEntries(
    Object.entries(shares)
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([size, share]) => [size, shareText(share.trim())]),
  )
}

/** A stored shares value read back ({size: "pct"}); anything else is none. */
export function storedShares(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** "50 20 % · 52 40 % · 54 25 %". */
export const curveWords = (shares: Readonly<Record<string, string>>): string =>
  Object.entries(shares)
    .map(([size, share]) => `${size} ${decimalText(share)} %`)
    .join(' · ')

// ---- a fill ------------------------------------------------------------------------------------------------------------

export interface FillResult {
  /** The pieces per size, in the line's size order (sizes at 0 left out). */
  readonly sizes: { readonly size: string; readonly quantity: number }[]
  /** The curve's (or pack's) sizes the line cannot take. */
  readonly leftOut: string[]
  /** What rounding left, put on one size. */
  readonly remainder: { readonly size: string; readonly pieces: number } | null
  readonly words: string
}

/**
 * A curve and a total in whole pieces over the sizes the line takes (`offered`, in the style's range order). Problems in
 * words: a total that is not a whole number from 1, a curve that shares none of the line's sizes, a size above the most a
 * line takes.
 */
export function curveFill(input: { readonly shares: Readonly<Record<string, string>>; readonly total: number; readonly offered: readonly string[]; readonly baseSize: string | null }, at = 'body'): FillResult | Issue[] {
  if (!Number.isInteger(input.total) || input.total < 1 || input.total > SIZE_CURVE_LIMITS.total) return [{ path: `${at}/total`, message: `A total of whole pieces from 1 to ${SIZE_CURVE_LIMITS.total}.` }]
  const kept = input.offered.filter((size) => input.shares[size] !== undefined && new Dec(input.shares[size]!).gt(0))
  const leftOut = Object.keys(input.shares).filter((size) => !kept.includes(size))
  if (kept.length === 0) return [{ path: `${at}/curveId`, message: `The curve shares none of the sizes this line takes (${input.offered.join(', ')}).` }]
  const shares = kept.map((size) => new Dec(input.shares[size]!))
  const weight = sum(shares)
  const total = new Dec(input.total)
  const pieces = shares.map((share) => Number.parseInt(total.times(share).dividedBy(weight).floor().toFixed(0), 10))
  const left = input.total - pieces.reduce((a, b) => a + b, 0)
  // The base size takes what rounding leaves: the style's, else the largest share (the first of them).
  let baseIndex = input.baseSize === null ? -1 : kept.indexOf(input.baseSize)
  if (baseIndex < 0) baseIndex = shares.reduce((best, share, index) => (share.gt(shares[best]!) ? index : best), 0)
  pieces[baseIndex] = pieces[baseIndex]! + left
  const issues: Issue[] = []
  kept.forEach((size, index) => {
    if (pieces[index]! > MAX_SIZE_QUANTITY) issues.push({ path: `${at}/total`, message: `Size ${size} would take ${pieces[index]} pieces: at most ${MAX_SIZE_QUANTITY} a size.` })
  })
  if (issues.length > 0) return issues
  const sizes = kept.map((size, index) => ({ size, quantity: pieces[index]! })).filter((row) => row.quantity > 0)
  const remainder = left > 0 ? { size: kept[baseIndex]!, pieces: left } : null
  const parts = [
    `${input.total} pieces: ${sizes.map((row) => `${row.size} × ${row.quantity}`).join(', ')}`,
    remainder ? `${remainder.pieces} left by rounding on size ${remainder.size}` : null,
    leftOut.length > 0 ? `the curve's sizes ${leftOut.join(', ')} are not on this line: the rest share the total` : null,
  ].filter((part): part is string => part !== null)
  return { sizes, leftOut, remainder, words: parts.join(' · ') }
}

/** A prepack's line as the fill reads it (factory-db PrepackLine). */
export interface PackLine {
  readonly size: string
  readonly colourwayId: string | null
  readonly quantity: number
}

/**
 * A prepack × packs for a line of one colourway: the pack's lines without a colourway and those of the line's colourway,
 * × packs, over the sizes the line takes. Problems in words: packs not a whole number from 1, a pack with nothing for this
 * colourway, a size the line cannot take (a usable pack of the style never has one: the caller checked `usable`).
 */
export function packFill(input: { readonly lines: readonly PackLine[]; readonly packs: number; readonly colourwayId: string; readonly offered: readonly string[] }, at = 'body'): FillResult | Issue[] {
  if (!Number.isInteger(input.packs) || input.packs < 1 || input.packs > SIZE_CURVE_LIMITS.packs) return [{ path: `${at}/packs`, message: `Whole packs from 1 to ${SIZE_CURVE_LIMITS.packs}.` }]
  const mine = input.lines.filter((line) => line.colourwayId === null || line.colourwayId === input.colourwayId)
  if (mine.length === 0) return [{ path: `${at}/prepackId`, message: 'The prepack has no pieces for this colourway: it names other colourways.' }]
  const perSize = new Map<string, number>()
  for (const line of mine) perSize.set(line.size, (perSize.get(line.size) ?? 0) + line.quantity)
  const leftOut = [...perSize.keys()].filter((size) => !input.offered.includes(size))
  if (leftOut.length > 0) return [{ path: `${at}/prepackId`, message: `The prepack has sizes this line does not take (${leftOut.join(', ')}): choose a pack of the style's range.` }]
  const issues: Issue[] = []
  const sizes = input.offered.filter((size) => perSize.has(size)).map((size) => ({ size, quantity: perSize.get(size)! * input.packs }))
  for (const row of sizes) if (row.quantity > MAX_SIZE_QUANTITY) issues.push({ path: `${at}/packs`, message: `Size ${row.size} would take ${row.quantity} pieces: at most ${MAX_SIZE_QUANTITY} a size.` })
  if (issues.length > 0) return issues
  const pieces = sizes.reduce((total, row) => total + row.quantity, 0)
  return { sizes, leftOut: [], remainder: null, words: `${input.packs} pack(s): ${sizes.map((row) => `${row.size} × ${row.quantity}`).join(', ')} (${pieces} pieces)` }
}
