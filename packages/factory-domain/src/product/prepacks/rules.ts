import type { Issue } from '../../core/errors'

/**
 * Prepacks (B-W2b-233; PRD-055; design products.styles › Sizes & measurements › Prepacks: "fixed size mixes for B2B",
 * Prepack · Ratio per size (1-2-3-2-1) · Pieces per pack; factory-db `Prepack`, `PrepackLine`, B-W2b-210): a pack a dealer
 * orders as one unit — so many pieces of each size, and on a style's prepack optionally of each colourway. Prepacks are a
 * commercial assortment, not a part of a revision (B-W2b-210's decision 1): a new revision keeps them.
 *
 *   scope STYLE   a prepack of one style: its sizes are the style's range now; a line may name one of its colourways.
 *   scope SCALE   a prepack of every style of a size scale: its sizes are the scale's; no colourway. A style can sell it
 *                 only when every size of the pack is in the style's range (`outsideRange`).
 *
 * Lines: one per size, or one per size and colourway (never both for one size), 1 to 10 000 pieces each; "pieces per
 * pack" is their sum. The database checks a line's shape and that an ARCHIVED prepack's lines never change; the size
 * belonging to the range or the scale, a colourway being the style's, and the "never both" rule are these rules (the
 * API's, in words). W2b-5 (an order line taking a prepack) copies `bySize` / the lines.
 */

export const PREPACK_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type PrepackStatus = (typeof PREPACK_STATUSES)[number]

export const PREPACK_SCOPES = ['STYLE', 'SCALE'] as const
export type PrepackScope = (typeof PREPACK_SCOPES)[number]

export const PREPACK_LIMITS = Object.freeze({ code: 40, name: 200, quantity: 10_000, lines: 400 })

export interface PrepackLineInput {
  readonly size: string
  /** A colourway of the prepack's style; null: any colourway. */
  readonly colourwayId: string | null
  readonly quantity: number
}

export interface PrepackColourway {
  readonly id: string
  readonly code: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

export interface PrepackContext {
  readonly scope: PrepackScope
  /** The sizes a line may name, in order: the style's range (STYLE) or the scale's sizes (SCALE). */
  readonly sizes: readonly string[]
  /** What the sizes are, for the words: "the style's sizes" or "the sizes of scale SEED-EU-JKT". */
  readonly sizesOf: string
  /** The style's colourways (STYLE): a new line names an ACTIVE one; a kept line may keep an archived one. */
  readonly colourways: readonly PrepackColourway[]
  /** The lines the prepack has now (an update): a line kept as it is may keep a size or colourway that left. */
  readonly existing?: readonly PrepackLineInput[]
}

/** A line's key: its size and colourway (the database's unique key). */
export const lineKey = (line: Pick<PrepackLineInput, 'size' | 'colourwayId'>): string => `${line.size}|${line.colourwayId ?? ''}`

const CODE = /^[^\s]{1,40}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export function codeProblems(code: string): Issue[] {
  if (!CODE.test(code)) return [{ path: 'code', message: `The prepack code is 1 to ${PREPACK_LIMITS.code} characters without spaces.` }]
  return []
}

export function nameProblems(name: string): Issue[] {
  if (name.trim().length === 0 || name.length > PREPACK_LIMITS.name || CONTROL.test(name)) return [{ path: 'name', message: `The prepack's name says what it is, in at most ${PREPACK_LIMITS.name} characters.` }]
  return []
}

/**
 * What is wrong with the lines a prepack would have, each at `lines/<n>/<field>`: at least one line; a size of the range
 * (or the scale); 1 to 10 000 pieces, whole; a colourway only on a style's prepack, the style's and active (when new); a
 * size and colourway once; a size either for any colourway or per colourway, never both.
 */
export function linesProblems(lines: readonly PrepackLineInput[], context: PrepackContext): Issue[] {
  const problems: Issue[] = []
  if (lines.length === 0) return [{ path: 'lines', message: 'A prepack has at least one size with its pieces.' }]
  if (lines.length > PREPACK_LIMITS.lines) return [{ path: 'lines', message: `A prepack has at most ${PREPACK_LIMITS.lines} lines.` }]
  const kept = new Set((context.existing ?? []).map(lineKey))
  const colourways = new Map(context.colourways.map((colourway) => [colourway.id, colourway]))
  const seen = new Set<string>()
  const anyColour = new Set<string>()
  const perColour = new Set<string>()
  lines.forEach((line, index) => {
    const at = `lines/${index}`
    const isKept = kept.has(lineKey(line))
    if (!context.sizes.includes(line.size) && !isKept) problems.push({ path: `${at}/size`, message: `Size ${line.size} is not one of ${context.sizesOf} (${context.sizes.join(', ')}).` })
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > PREPACK_LIMITS.quantity) {
      problems.push({ path: `${at}/quantity`, message: `Size ${line.size} has 1 to ${PREPACK_LIMITS.quantity.toLocaleString('en-GB')} pieces, a whole number.` })
    }
    if (line.colourwayId !== null) {
      const colourway = colourways.get(line.colourwayId)
      if (context.scope === 'SCALE') problems.push({ path: `${at}/colourwayId`, message: 'A prepack of every style of a size scale names no colourway: give a style its own prepack for colours.' })
      else if (!colourway) problems.push({ path: `${at}/colourwayId`, message: `The colourway of size ${line.size} is not one of the style's.` })
      else if (colourway.status !== 'ACTIVE' && !isKept) problems.push({ path: `${at}/colourwayId`, message: `Colourway ${colourway.code} is archived: a new line names an active colourway.` })
    }
    const key = lineKey(line)
    if (seen.has(key)) problems.push({ path: `${at}/size`, message: `Size ${line.size}${line.colourwayId ? ` in colourway ${colourways.get(line.colourwayId)?.code ?? ''}` : ''} is given twice.` })
    seen.add(key)
    ;(line.colourwayId === null ? anyColour : perColour).add(line.size)
  })
  for (const size of anyColour) {
    if (perColour.has(size)) {
      const index = lines.findIndex((line) => line.size === size && line.colourwayId !== null)
      problems.push({ path: `lines/${index}/colourwayId`, message: `Size ${size} is given both for any colourway and per colourway: give it one way.` })
    }
  }
  return problems
}

/** Pieces per pack: the sum of the lines. */
export const piecesOf = (lines: readonly Pick<PrepackLineInput, 'quantity'>[]): number => lines.reduce((sum, line) => sum + line.quantity, 0)

/** Pieces per size (every colourway together), the sizes in `order` first, then any other size the lines name. */
export function bySize(lines: readonly Pick<PrepackLineInput, 'size' | 'quantity'>[], order: readonly string[]): { size: string; quantity: number }[] {
  const totals = new Map<string, number>()
  for (const line of lines) totals.set(line.size, (totals.get(line.size) ?? 0) + line.quantity)
  const sizes = [...order.filter((size) => totals.has(size)), ...[...totals.keys()].filter((size) => !order.includes(size))]
  return sizes.map((size) => ({ size, quantity: totals.get(size) ?? 0 }))
}

/**
 * The ratio as the design writes it ("1-2-3-2-1"): the pieces of each size from the first size with pieces to the last, in
 * the scale's order, a size in between with none as 0 ("2-0-2"). Sizes outside `order` follow at the end.
 */
export function ratioText(lines: readonly Pick<PrepackLineInput, 'size' | 'quantity'>[], order: readonly string[]): string {
  const totals = bySize(lines, order)
  if (totals.length === 0) return ''
  const inOrder = totals.filter((entry) => order.includes(entry.size))
  const outside = totals.filter((entry) => !order.includes(entry.size))
  if (inOrder.length === 0) return outside.map((entry) => entry.quantity).join('-')
  const first = order.indexOf(inOrder[0]!.size)
  const last = order.indexOf(inOrder[inOrder.length - 1]!.size)
  const run = order.slice(first, last + 1).map((size) => totals.find((entry) => entry.size === size)?.quantity ?? 0)
  return [...run, ...outside.map((entry) => entry.quantity)].join('-')
}

/** The sizes of the pack the style is not made in: a scale's prepack the style cannot sell while any is left. */
export const outsideRange = (lines: readonly Pick<PrepackLineInput, 'size'>[], range: readonly string[]): string[] => [...new Set(lines.map((line) => line.size))].filter((size) => !range.includes(size))

/** A whole new list of lines against the old one: the kept ones (a new quantity), the added and the removed (by key). */
export function linePlan<T extends PrepackLineInput>(existing: readonly T[], wanted: readonly PrepackLineInput[]): { changed: { from: T; quantity: number }[]; added: PrepackLineInput[]; removed: T[] } {
  const byKey = new Map(existing.map((line) => [lineKey(line), line]))
  const wantedKeys = new Set(wanted.map(lineKey))
  const changed: { from: T; quantity: number }[] = []
  const added: PrepackLineInput[] = []
  for (const line of wanted) {
    const from = byKey.get(lineKey(line))
    if (!from) added.push(line)
    else if (from.quantity !== line.quantity) changed.push({ from, quantity: line.quantity })
  }
  return { changed, added, removed: existing.filter((line) => !wantedKeys.has(lineKey(line))) }
}

/** The pack in a sentence, for the API's `words` and an audit reader: "7 pieces per pack: 50 ×2, 52 ×3, 54 ×2". */
export function prepackWords(lines: readonly (Pick<PrepackLineInput, 'size' | 'quantity'> & { colourway?: string | null })[], order: readonly string[], outside: readonly string[] = []): string {
  const pieces = piecesOf(lines)
  const sorted = [...lines].sort((a, b) => {
    const ia = order.indexOf(a.size)
    const ib = order.indexOf(b.size)
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib) || (a.colourway ?? '').localeCompare(b.colourway ?? '')
  })
  const parts = sorted.map((line) => `${line.size}${line.colourway ? ` ${line.colourway}` : ''} ×${line.quantity}`)
  const base = `${pieces} piece${pieces === 1 ? '' : 's'} per pack: ${parts.join(', ')}`
  return outside.length > 0 ? `${base} · not for this style: it is not made in ${outside.join(', ')}` : base
}
