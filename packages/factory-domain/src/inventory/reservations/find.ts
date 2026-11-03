import { UNITS } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'
import { shadeLotKey, shadeLotWords, type ShadeFacts, type ShadeRule, asksOneShadePerOrder } from './shade'

/**
 * Find hides for a job (B-W2b-100; SCM-257, SCM-206; design warehouse.hides pop-up "Find hides for a job", production.cutting
 * "Allocate hides…", production.workorders "Reserve leather…"), pure. The API gives the available hides of one article and
 * colour at one site (on hand, usable, not held, not reserved for another demand; already filtered by grade and shade group
 * when asked) and the area the job needs; this groups them by shade lot and proposes ONE shade lot first, with the area
 * running against the need ("Covers 46.20 of 44.00 m² ✓"); the other lots follow with the shade warning, out-of-shade hides
 * apart (never proposed).
 *
 *   order of the lots  the order's own shade lot first when it holds one and the rule asks one shade per order; then the lots
 *                      that cover the need alone (the smallest excess of their proposal first, then the oldest lot, then
 *                      its code); then the others, the most area first. Without a need: the most area first.
 *   in a lot           the largest hides first (the fewest hides cover the need), then the tag; remnants come last by size.
 *   the proposal       the first lot's hides in that order until the running area reaches the need (all of them when it
 *                      never does: "30.00 of 44.00 m²: 14.00 m² short").
 *
 * Areas are the base unit's (an area unit), Decimal strings with four decimals; the words carry two.
 */

export interface FindHide extends ShadeFacts {
  readonly receivedAt: string | null
  readonly gradeId: string | null
  readonly gradeCode: string | null
  readonly state: string
  /** On hand at the site, in the base unit. */
  readonly left: DecimalInput
  readonly locationCodes: readonly string[]
  /** Its live remnant tag (IN_STOCK), when it is a tagged remnant. */
  readonly remnant: { readonly id: string; readonly code: string } | null
}

export interface FindInput {
  /** What the job still needs (less what its order has reserved already), in the base unit; null: no need given (by area). */
  readonly need: DecimalInput | null
  readonly baseUom: string
  readonly rule: ShadeRule
  /** The hides the order holds or has reserved already (their shade lots), when the search is for an order. */
  readonly held: readonly ShadeFacts[]
  readonly hides: readonly FindHide[]
}

export type Language = 'it' | 'en'

export interface FoundHide extends FindHide {
  readonly left: string
  /** The lot's area up to and with this hide, in its order. */
  readonly running: string
  /** In the proposal (the first lot's hides that reach the need). */
  readonly proposed: boolean
}

export interface FoundLot {
  readonly key: string
  readonly lotId: string
  readonly lotCode: string
  readonly shadeGroupId: string | null
  readonly shadeLabel: string | null
  readonly words: Readonly<Record<Language, string>>
  readonly hides: FoundHide[]
  readonly count: number
  readonly total: string
  /** The lot alone covers the need (false without a need). */
  readonly covers: boolean
  /** The order's own shade lot (it holds or has reserved hides of it). */
  readonly ordersOwn: boolean
  /** Taking it would mix shades in the order: another lot than the first (the proposal's). */
  readonly shadeWarning: boolean
}

export interface Proposal {
  readonly lotKey: string
  readonly hideIds: string[]
  readonly count: number
  readonly area: string
  readonly covers: boolean
  readonly words: Readonly<Record<Language, string>>
}

export interface FindResult {
  readonly need: string | null
  readonly baseUom: string
  readonly lots: FoundLot[]
  /** Hides of an out-of-shade group: listed, never proposed for an order that asks one shade. */
  readonly outOfShade: FoundHide[]
  readonly proposal: Proposal | null
}

const dec = (value: DecimalInput): Decimal => new Dec(value.toString())
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const symbol = (uom: string): string => (uom in UNITS ? UNITS[uom as keyof typeof UNITS].symbol : uom)

const MARKS: Readonly<Record<Language, { readonly group: string; readonly point: string }>> = { it: { group: '.', point: ',' }, en: { group: ',', point: '.' } }

/** A decimal with two places for people (grouped, the language's mark; exact, never through a float). */
export function areaNumber(value: DecimalInput, language: Language): string {
  const text = dec(value).toFixed(2, Dec.ROUND_HALF_UP)
  const negative = text.startsWith('-')
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.')
  return `${negative ? '-' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, MARKS[language].group)}${MARKS[language].point}${fraction}`
}

/**
 * Hides against a need, in words: "11 hides · 46.20 of 44.00 m² ✓" (it "11 pelli · 46,20 di 44,00 m² ✓"); short: "4 hides ·
 * 30.00 of 44.00 m²: 14.00 m² short" (it "…: mancano 14,00 m²"); without a need: "4 hides · 30.00 m²".
 */
export function againstNeedWords(figure: { readonly count: number; readonly area: DecimalInput; readonly need: DecimalInput | null; readonly uom: string }, language: Language): string {
  const nouns = language === 'it' ? (figure.count === 1 ? 'pelle' : 'pelli') : figure.count === 1 ? 'hide' : 'hides'
  const unit = symbol(figure.uom)
  const head = `${figure.count} ${nouns}`
  if (figure.need === null) return `${head} · ${areaNumber(figure.area, language)} ${unit}`
  const area = dec(figure.area)
  const need = dec(figure.need)
  const of = language === 'it' ? 'di' : 'of'
  const base = `${head} · ${areaNumber(area, language)} ${of} ${areaNumber(need, language)} ${unit}`
  if (area.gte(need)) return `${base} ✓`
  const short = areaNumber(need.minus(area), language)
  return language === 'it' ? `${base}: mancano ${short} ${unit}` : `${base}: ${short} ${unit} short`
}

const largestFirst = (a: FindHide, b: FindHide): number => dec(b.left).comparedTo(dec(a.left)) || compare(a.hideCode, b.hideCode)

/** The hides grouped by shade lot, in the order above, with the proposal (rules in the header). */
export function findHides(input: FindInput): FindResult {
  const need = input.need === null ? null : dec(input.need)
  const wanted = need !== null && need.greaterThan(0) ? need : null
  const ownKeys = new Set(input.held.map((hide) => shadeLotKey(hide)))
  const oneShade = asksOneShadePerOrder(input.rule)
  const outOfShade = input.hides.filter((hide) => hide.outOfShade && oneShade)
  const groups = new Map<string, FindHide[]>()
  for (const hide of input.hides) {
    if (hide.outOfShade && oneShade) continue
    const key = shadeLotKey(hide)
    groups.set(key, [...(groups.get(key) ?? []), hide])
  }

  interface Draft {
    readonly key: string
    readonly hides: FindHide[]
    readonly total: Decimal
    readonly covers: boolean
    /** What the proposal of this lot would take beyond the need. */
    readonly excess: Decimal | null
    readonly ordersOwn: boolean
    readonly oldest: string | null
  }
  const drafts: Draft[] = [...groups.entries()].map(([key, hides]) => {
    const sorted = [...hides].sort(largestFirst)
    const total = sorted.reduce((sum, hide) => sum.plus(dec(hide.left)), ZERO)
    let running = ZERO
    let excess: Decimal | null = null
    for (const hide of sorted) {
      if (wanted === null) break
      running = running.plus(dec(hide.left))
      if (running.gte(wanted)) {
        excess = running.minus(wanted)
        break
      }
    }
    const received = hides.map((hide) => hide.receivedAt).filter((at): at is string => at !== null).sort()
    return { key, hides: sorted, total, covers: excess !== null, excess, ordersOwn: ownKeys.has(key), oldest: received[0] ?? null }
  })
  const byOldest = (a: Draft, b: Draft) => {
    if (a.oldest !== b.oldest) {
      if (a.oldest === null) return 1
      if (b.oldest === null) return -1
      return compare(a.oldest, b.oldest)
    }
    return compare(a.hides[0]!.lotCode, b.hides[0]!.lotCode) || compare(a.key, b.key)
  }
  drafts.sort((a, b) => {
    if (oneShade && a.ordersOwn !== b.ordersOwn) return a.ordersOwn ? -1 : 1
    if (wanted !== null && a.covers !== b.covers) return a.covers ? -1 : 1
    if (wanted !== null && a.covers && b.covers) return a.excess!.comparedTo(b.excess!) || byOldest(a, b)
    return b.total.comparedTo(a.total) || byOldest(a, b)
  })

  const first = drafts[0]
  const lots: FoundLot[] = drafts.map((draft, index) => {
    let running = ZERO
    let reached = wanted === null
    const hides: FoundHide[] = draft.hides.map((hide) => {
      running = running.plus(dec(hide.left))
      const proposed = index === 0 && wanted !== null && !reached
      if (proposed && running.gte(wanted!)) reached = true
      return { ...hide, left: quantityText(dec(hide.left)), running: quantityText(running), proposed }
    })
    const head = draft.hides[0]!
    return {
      key: draft.key,
      lotId: head.lotId,
      lotCode: head.lotCode,
      shadeGroupId: head.shadeGroupId,
      shadeLabel: head.shadeLabel,
      words: { it: shadeLotWords(head, 'it'), en: shadeLotWords(head, 'en') },
      hides,
      count: hides.length,
      total: quantityText(draft.total),
      covers: draft.covers,
      ordersOwn: draft.ordersOwn,
      shadeWarning: index > 0 || (oneShade && ownKeys.size > 0 && !draft.ordersOwn),
    }
  })

  let proposal: Proposal | null = null
  if (first && wanted !== null) {
    const chosen = lots[0]!.hides.filter((hide) => hide.proposed)
    const area = chosen.reduce((sum, hide) => sum.plus(dec(hide.left)), ZERO)
    const figure = { count: chosen.length, area, need: wanted, uom: input.baseUom }
    proposal = { lotKey: first.key, hideIds: chosen.map((hide) => hide.hideId), count: chosen.length, area: quantityText(area), covers: area.gte(wanted), words: { it: againstNeedWords(figure, 'it'), en: againstNeedWords(figure, 'en') } }
  }
  return {
    need: need === null ? null : quantityText(need),
    baseUom: input.baseUom,
    lots,
    outOfShade: outOfShade.sort(largestFirst).map((hide) => ({ ...hide, left: quantityText(dec(hide.left)), running: quantityText(dec(hide.left)), proposed: false })),
    proposal,
  }
}
