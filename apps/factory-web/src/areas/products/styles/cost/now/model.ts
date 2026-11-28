import type { ComponentsView } from '../versions/api'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh; prototype cost.js costParts, workOf, otherOf, stdCostOf, marginPct, floorPrice) — the Cost
 * tab's pure side: the 9 categories of the live cost (the revision's components, B-W2b-418) in the 4 parts the Owner reads — Materials
 * (MATERIAL + LEATHER) · Work (LABOUR) · Overhead (OVERHEAD) · Other costs (SUBCONTRACT, FREIGHT, DUTY, PACKAGING, COMMISSION) —, the
 * top line, the Keep window's rules, the price-against-cost flags and the margin bar, and who opens the tab at all (the cost grain).
 * "Known so far" stays honest: a size that misses an input has no total, only what is known. EUR only. No React, no API.
 */

/** Words of the `products-cost` catalogue: a key and its parameters. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export type ComponentLine = ComponentsView['lines'][number]

export const COST_PARTS = ['materials', 'work', 'overhead', 'other'] as const
export type CostPart = (typeof COST_PARTS)[number]

/** The 9 categories → the 4 parts. */
export const PART_OF: Readonly<Record<string, CostPart>> = Object.freeze({
  MATERIAL: 'materials',
  LEATHER: 'materials',
  LABOUR: 'work',
  OVERHEAD: 'overhead',
  SUBCONTRACT: 'other',
  FREIGHT: 'other',
  DUTY: 'other',
  PACKAGING: 'other',
  COMMISSION: 'other',
})

/** A category's part; a category this web does not know yet counts as Other costs. */
export const partOf = (category: string): CostPart => (Object.hasOwn(PART_OF, category) ? PART_OF[category]! : 'other')

/** The Cost tab opens only with the cost grain (design § 5zh: "Only the owner sees this tab"): costing.view AND money.cost. */
export const costTabOpen = (can: { readonly costView: boolean }, grains: { readonly cost: boolean }): boolean => can.costView && grains.cost

const num = (value: string | null | undefined): number => (value === null || value === undefined || value === '' ? 0 : Number(value))
/** Two decimals, as every money column shows it. */
export const cents = (value: number): string => (Math.round(value * 100) / 100).toFixed(2)

export interface PartAmount {
  readonly part: CostPart
  /** For one piece, two decimals. */
  readonly amount: string
  /** Its share of what is known, in whole percent. */
  readonly share: number
}

export interface CostOfOne {
  readonly size: string
  readonly parts: readonly PartAmount[]
  /** What is known so far (always). */
  readonly knownTotal: string
  /** The cost of one piece; null while an input is missing. */
  readonly total: string | null
  readonly complete: boolean
}

/** The cost of one piece in a size, in its 4 parts; null: the components have no split for that size (or no figure: no grain). */
export function costOfOne(view: Pick<ComponentsView, 'split'>, size: string): CostOfOne | null {
  const cell = view.split.find((entry) => entry.size === size)
  if (!cell || cell.knownTotal === undefined) return null
  const sums = new Map<CostPart, number>(COST_PARTS.map((part): [CostPart, number] => [part, 0]))
  for (const category of cell.categories) sums.set(partOf(category.category), (sums.get(partOf(category.category)) ?? 0) + num(category.amount))
  const known = COST_PARTS.reduce((sum, part) => sum + (sums.get(part) ?? 0), 0)
  return {
    size,
    parts: COST_PARTS.map((part) => ({ part, amount: cents(sums.get(part) ?? 0), share: known > 0 ? Math.round(((sums.get(part) ?? 0) / known) * 100) : 0 })),
    knownTotal: cents(num(cell.knownTotal)),
    total: cell.complete && cell.total !== null && cell.total !== undefined ? cents(num(cell.total)) : null,
    complete: cell.complete,
  }
}

/** The size the cost is shown in: the asked one when costed, else the style's base size, else the first one. */
export function costSizeOf(view: Pick<ComponentsView, 'sizes'>, asked: string | null, baseSize: string | null): string | null {
  if (asked && view.sizes.includes(asked)) return asked
  if (baseSize && view.sizes.includes(baseSize)) return baseSize
  return view.sizes[0] ?? null
}

/** A part's lines in a size (every-size lines and the size's own), the biggest first. */
export function linesOfPart(view: Pick<ComponentsView, 'lines'>, size: string, part: CostPart): ComponentLine[] {
  return view.lines.filter((line) => (line.size === null || line.size === size) && partOf(line.category) === part).sort((a, b) => num(b.cost) - num(a.cost))
}

/** The minutes of the route in a size (the LABOUR lines costed by time: their quantity is minutes). */
export function minutesOf(view: Pick<ComponentsView, 'lines'>, size: string): number {
  return linesOfPart(view, size, 'work').reduce((sum, line) => sum + (line.uom === null ? num(line.quantity) : 0), 0)
}

/** How a part is worked out, in words (the table's second column). */
export function howOf(view: Pick<ComponentsView, 'lines'>, size: string, part: CostPart): Words {
  const lines = linesOfPart(view, size, part)
  switch (part) {
    case 'materials':
      return { key: 'now.how.materials', params: { count: lines.length } }
    case 'work':
      return { key: 'now.how.work', params: { minutes: Math.round(minutesOf(view, size) * 10) / 10 } }
    case 'overhead': {
      const pct = lines.find((line) => line.pct !== null && line.pct !== undefined)?.pct
      return pct ? { key: 'now.how.overheadPct', params: { pct: Number(pct) } } : { key: 'now.how.overhead' }
    }
    case 'other':
      return lines.length > 0 ? { key: 'now.how.other', params: { count: lines.length } } : { key: 'now.how.otherNone' }
  }
}

// ---- the top line --------------------------------------------------------------------------------------------------------

export interface Kept {
  readonly amount: string
  readonly version: number
  readonly keptAt: string
}

/** One agreed price against the cost (`GET …/price-against-cost`). */
export interface PriceRow {
  readonly flag: 'OK' | 'UNDER_TARGET' | 'UNDER_COST' | null
}

/**
 * The line on top (design § 5zh): "Standard cost € 190 for one piece · version 1" (or the rough standard of its kind) · "Cost now
 * € 185.60: € 4.40 lower" · "n of m agreed prices are under the target of t %". `money` writes an amount in the page's language.
 */
export function topLineOf(
  input: {
    /** undefined: not read (the price against cost could not be read: the sentence is left out). */
    readonly kept: Kept | null | undefined
    readonly costNow: string | null
    /** null: not read (the sentence of the agreed prices is left out). */
    readonly rows: readonly PriceRow[] | null
    readonly targetPct: string
  },
  money: (amount: string) => string,
): Words[] {
  const words: Words[] = []
  if (input.kept !== undefined) words.push(input.kept ? { key: 'top.kept', params: { amount: money(input.kept.amount), version: input.kept.version } } : { key: 'top.rough' })
  if (input.costNow === null) words.push({ key: 'top.nowUnknown' })
  else if (!input.kept) words.push({ key: 'top.now', params: { amount: money(input.costNow) } })
  else {
    const diff = Math.round((Number(input.costNow) - Number(input.kept.amount)) * 100) / 100
    words.push(diff === 0 ? { key: 'top.nowSame', params: { amount: money(input.costNow) } } : { key: diff > 0 ? 'top.nowHigher' : 'top.nowLower', params: { amount: money(input.costNow), diff: money(cents(Math.abs(diff))) } })
  }
  if (input.rows === null) return words
  const target = Number(input.targetPct)
  const under = input.rows.filter((row) => row.flag === 'UNDER_TARGET' || row.flag === 'UNDER_COST').length
  if (input.rows.length === 0) words.push({ key: 'top.noPrices' })
  else if (under > 0) words.push({ key: 'top.under', params: { count: under, total: input.rows.length, target } })
  else words.push({ key: 'top.allKeep', params: { count: input.rows.length, target } })
  return words
}

// ---- price against cost ----------------------------------------------------------------------------------------------------

/** A row's flag in words and tone (never colour alone: the words say it). */
export function flagOf(flag: PriceRow['flag']): { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (flag) {
    case 'OK':
      return { key: 'price.flag.OK', tone: 'success' }
    case 'UNDER_TARGET':
      return { key: 'price.flag.UNDER_TARGET', tone: 'warning' }
    case 'UNDER_COST':
      return { key: 'price.flag.UNDER_COST', tone: 'danger' }
    default:
      return { key: 'price.flag.none', tone: 'neutral' }
  }
}

/** The margin bar: its fill (0–100 %) and where the target mark stands. */
export function marginBarOf(marginPct: string | null, targetPct: string): { readonly fill: number; readonly mark: number } {
  const clamp = (value: number) => Math.max(0, Math.min(100, value))
  return { fill: marginPct === null ? 0 : clamp(Number(marginPct)), mark: clamp(Number(targetPct)) }
}

// ---- Keep ----------------------------------------------------------------------------------------------------------------------

export const KEEP_REASON_MAX = 200

/** Why "Keep" is held: no cost now, the same as kept, no reason, a write running; null: it keeps. */
export function keepHeldOf(input: { readonly costNow: string | null; readonly kept: Kept | null; readonly reason: string; readonly busy: boolean }): Words | null {
  if (input.busy) return { key: 'keep.held.busy' }
  if (input.costNow === null) return { key: 'keep.held.unknown' }
  if (input.kept && Number(input.kept.amount) === Number(input.costNow)) return { key: 'keep.held.same' }
  if (!input.reason.trim()) return { key: 'keep.held.reason' }
  return null
}

/** What happened after Keep: kept (version n) or sent for approval to Finance (four eyes, the company's default). */
export function keepDoneOf(answer: { readonly mode: 'KEPT' | 'SENT_FOR_APPROVAL'; readonly kept: Kept | null }, money: (amount: string) => string): Words {
  return answer.mode === 'KEPT' && answer.kept ? { key: 'keep.done.kept', params: { version: answer.kept.version, amount: money(answer.kept.amount) } } : { key: 'keep.done.sent' }
}

export const KEEP_REFUSALS = ['SAME_AS_KEPT', 'TOTAL_MOVED', 'MISSING_PARTS'] as const

/** A refused write in words: a known refusal code (its own, an issue's, the end of an issue's path) first, else the kind of answer. */
export function refusalOf(error: unknown, known: readonly string[] = KEEP_REFUSALS): Words {
  const value = error as { kind?: string; code?: unknown; issues?: ReadonlyArray<{ code?: unknown; path?: unknown }> } | null
  const codes: string[] = []
  if (typeof value?.code === 'string') codes.push(value.code)
  for (const issue of value?.issues ?? []) {
    if (typeof issue.code === 'string') codes.push(issue.code)
    const path = typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('/') : ''
    const last = path.split(/[/.]/).pop()
    if (last) codes.push(last)
  }
  const hit = codes.find((code) => known.includes(code))
  return hit ? { key: `refusal.${hit}` } : { key: problemKeyOf(error) }
}

/** A failed call as a `problem.*` key of `products-cost` (the API's kind, never its English). */
export function problemKeyOf(error: unknown): string {
  switch ((error as { kind?: string } | null)?.kind) {
    case 'forbidden':
    case 'step_up':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'signed_out':
      return 'problem.signedOut'
    case 'unavailable':
      return 'problem.offline'
    default:
      return 'problem.unavailable'
  }
}
