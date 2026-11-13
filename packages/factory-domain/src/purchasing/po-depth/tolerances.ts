import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { ITEM_KINDS } from '../../product/materials/rules'
import { QUANTITY_SCALE, UNITS, type Uom } from '../../product/units/units'
import { Dec, parseDecimal } from '../../tax/decimal'

/**
 * Over and under delivery tolerances (B-W2b-296; SCM-061; design purchasing.settings "Delivery tolerances"; factory-db
 * buying-depth.prisma DeliveryTolerance), pure.
 *
 *   rule      how far a receipt may be over or under the ordered quantity, in percent (0 to 100, four places), for one
 *             company or every company, one supplier or every supplier, and one material, one kind of material (never
 *             finished garments) or every material; beyond it the extra is refused (BLOCK) or waits for a person's yes
 *             (APPROVAL). One ACTIVE rule per scope (the module's); archived, never deleted.
 *   pick      at a receipt the most specific ACTIVE rule wins: the material over its kind over every material, then the
 *             supplier over every supplier, then the company over every company.
 *   line      a purchase order line that carries its own tolerance (a leather line's area tolerance, agreed with the
 *             tannery on that order) keeps it, both ways, as W1 did: over it the receiver says why the extra is taken.
 *   under     within the tolerance under, the line counts as received (the order no longer waits for the rest); below it
 *             the line stays open (a partial delivery, said in words). A short delivery is never refused.
 *   over      beyond the tolerance over: BLOCK refuses the receipt (receive at most the limit; the rest goes back);
 *             APPROVAL needs a person's yes: the office's receipt waits OPEN for a RECEIPT_OVER_TOLERANCE yes per such line
 *             (B-W2b-377); the goods-in tablet and goods without a PO refuse it in words (the office asks the yes). Without
 *             any rule the W1 rule stands: exactly as ordered, more only with the receiver's reason.
 */

export const TOLERANCE_ACTIONS = ['BLOCK', 'APPROVAL'] as const
export type ToleranceAction = (typeof TOLERANCE_ACTIONS)[number]
export const TOLERANCE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export const MAX_TOLERANCE_NOTE = 2000

export interface ToleranceRule {
  readonly id: string
  readonly companyId: string | null
  readonly supplierId: string | null
  readonly itemId: string | null
  readonly itemKind: string | null
  readonly overPct: string
  readonly underPct: string
  readonly whenBeyond: ToleranceAction
  readonly status: string
}

export interface ToleranceFacts {
  readonly companyId: string
  readonly supplierId: string
  readonly itemId: string
  readonly itemKind: string
}

const matches = (rule: ToleranceRule, facts: ToleranceFacts): boolean =>
  rule.status === 'ACTIVE' &&
  (rule.companyId === null || rule.companyId === facts.companyId) &&
  (rule.supplierId === null || rule.supplierId === facts.supplierId) &&
  (rule.itemId === null || rule.itemId === facts.itemId) &&
  (rule.itemKind === null || rule.itemKind === facts.itemKind)

/** How specific a rule is: material (2 item, 1 kind, 0 every), then supplier, then company — compared in that order. */
const rank = (rule: ToleranceRule): [number, number, number] => [rule.itemId !== null ? 2 : rule.itemKind !== null ? 1 : 0, rule.supplierId !== null ? 1 : 0, rule.companyId !== null ? 1 : 0]

/** The rule a receipt of this material from this supplier for this company follows, or null when none matches. */
export function toleranceFor(rules: readonly ToleranceRule[], facts: ToleranceFacts): ToleranceRule | null {
  let best: ToleranceRule | null = null
  for (const rule of rules) {
    if (!matches(rule, facts)) continue
    if (best === null) {
      best = rule
      continue
    }
    const [a, b] = [rank(rule), rank(best)]
    const better = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] !== b[2] ? a[2] > b[2] : rule.id < best.id
    if (better) best = rule
  }
  return best
}

/** Two rules of the same scope (company, supplier, material or kind). */
export const sameScope = (a: Pick<ToleranceRule, 'companyId' | 'supplierId' | 'itemId' | 'itemKind'>, b: Pick<ToleranceRule, 'companyId' | 'supplierId' | 'itemId' | 'itemKind'>): boolean =>
  a.companyId === b.companyId && a.supplierId === b.supplierId && a.itemId === b.itemId && a.itemKind === b.itemKind

const percentOk = (value: string): boolean => {
  const parsed = parseDecimal(value)
  return parsed !== null && fitsDecimal(value.trim(), 7, 4) && parsed.greaterThanOrEqualTo(0) && parsed.lessThanOrEqualTo(100)
}

/** What is wrong with a rule as typed; none: it can be stored. */
export function toleranceProblems(input: { readonly itemId: string | null; readonly itemKind: string | null; readonly overPct: string; readonly underPct: string; readonly note: string | null }): Issue[] {
  const problems: Issue[] = []
  if (input.itemId !== null && input.itemKind !== null) problems.push({ path: 'body/itemKind', message: 'A rule is for one material or one kind of material, not both.' })
  if (input.itemKind !== null && !(ITEM_KINDS as readonly string[]).includes(input.itemKind)) problems.push({ path: 'body/itemKind', message: 'A kind of material (finished garments take no delivery tolerance).' })
  if (!percentOk(input.overPct)) problems.push({ path: 'body/overPct', message: 'A percentage from 0 to 100, with at most four decimals.' })
  if (!percentOk(input.underPct)) problems.push({ path: 'body/underPct', message: 'A percentage from 0 to 100, with at most four decimals.' })
  if (input.note !== null && (input.note.trim() === '' || input.note.length > MAX_TOLERANCE_NOTE)) problems.push({ path: 'body/note', message: `At most ${MAX_TOLERANCE_NOTE} characters.` })
  return problems
}

/** What a receipt reads for one order line: its tolerance either way, what happens beyond it, and where it comes from. */
export interface ReceiptTolerance {
  readonly overPct: string
  readonly underPct: string
  /** REASON: W1's rule (more only with the receiver's reason); BLOCK or APPROVAL: the rule's. */
  readonly whenBeyond: 'REASON' | ToleranceAction
  readonly source: 'LINE' | 'RULE' | 'NONE'
  readonly toleranceId: string | null
}

/** The line's own tolerance when it carries one, else the rule's, else none (exactly as ordered). */
export function receiptToleranceOf(line: { readonly areaTolerancePct: string | null }, rule: ToleranceRule | null): ReceiptTolerance {
  if (line.areaTolerancePct !== null) return { overPct: new Dec(line.areaTolerancePct).toString(), underPct: new Dec(line.areaTolerancePct).toString(), whenBeyond: 'REASON', source: 'LINE', toleranceId: null }
  if (rule !== null) return { overPct: new Dec(rule.overPct).toString(), underPct: new Dec(rule.underPct).toString(), whenBeyond: rule.whenBeyond, source: 'RULE', toleranceId: rule.id }
  return { overPct: '0', underPct: '0', whenBeyond: 'REASON', source: 'NONE', toleranceId: null }
}

/**
 * The refusal of a receipt line beyond its tolerance over (the receipt's words of the difference first), or null when the
 * W1 rule decides (the receiver's reason). `upTo` is the most the line may hold, in the base unit's words.
 */
export function beyondToleranceRefusal(words: string, tolerance: ReceiptTolerance, upTo: string): string | null {
  if (tolerance.whenBeyond === 'REASON') return null
  if (tolerance.whenBeyond === 'BLOCK') return `${words} Beyond the delivery tolerance (+${tolerance.overPct} %) the extra is refused: receive at most ${upTo} in all; the rest goes back to the supplier.`
  // B-W2b-377: the office's receipt waits for the yes (modules/inventory/receiving/tolerance-hold.ts); these words are the goods-in
  // tablet's and goods without a PO's, which ask no yes.
  return `${words} Beyond the delivery tolerance (+${tolerance.overPct} %) the extra needs a person's yes: the office records this receipt to ask it, or receive at most ${upTo} in all here.`
}

/** The most a line may hold, in words ("110 m²"), for the refusal. */
export const upToWords = (upTo: string, baseUom: Uom): string => `${new Dec(upTo).toDecimalPlaces(QUANTITY_SCALE).toString()} ${UNITS[baseUom].symbol}`
