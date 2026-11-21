import type { Order } from '../../api'
import type { Changes, Freeze, FreezeField, FreezeStage, FreezeState } from '../../depth/api'

/**
 * F-OC-202 (order CHANGES tab, 10-design §4; 13-backend R13a, B-OC-017; 18-lead-settles L3) — section 2, Can it still change?, without
 * a screen: ONE sentence that says whether the order can still change and what a change needs now, the door to the Lines tab (the
 * one place to change), and each part with three words only — Can change · Needs the customer's yes · Can't change any more.
 *
 * The first rule that applies (the order's own state first — the freeze rules alone said "everything is open" on a partly shipped
 * order and "not in production" on an order in production):
 *
 *   cancelled       This order is cancelled: nothing changes.
 *   closed          This order is closed: nothing changes any more.
 *   goodsLeft       Goods have left: the lines no longer change. A later change is a return.
 *   firstYes        It waits for its first yes: change the lines on the Lines tab.
 *   blocked         Blocked: revision 2 waits for approval since 18/11. Nothing else changes until it is decided.
 *   nothingOnFloor  Nothing is on the floor yet: everything can change.
 *   locked          Now needs the customer's yes (may cost a fee): Sizes and quantities. Can't change any more: Colourway.
 *   allOpen         Everything can still change.
 *
 * L3: no Options row (no office path changes options after confirmation); the Delivery address row says it is "checked when the
 * customer asks" (the office's own address change is not checked against the rules yet — a later job).
 */

export type FreezeWord = 'canChange' | 'needsYes' | 'cantChange'
export const FREEZE_WORD: Readonly<Record<FreezeState, FreezeWord>> = Object.freeze({ OPEN: 'canChange', CHANGE_REQUEST: 'needsYes', BLOCKED: 'cantChange' })
export const FREEZE_WORD_TONE: Readonly<Record<FreezeWord, 'success' | 'warning' | 'danger'>> = Object.freeze({ canChange: 'success', needsYes: 'warning', cantChange: 'danger' })

/** The parts the section says, in its order (L3: Options hidden). */
export const FREEZE_PARTS: readonly FreezeField[] = Object.freeze(['SIZE_QUANTITY', 'COLOURWAY', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE'])

export type FreezeVerdict =
  | { readonly kind: 'cancelled' | 'closed' | 'goodsLeft' | 'firstYes' | 'nothingOnFloor' | 'allOpen' | 'reading' | 'failed' }
  | { readonly kind: 'blocked'; readonly revision: number | null; readonly since: string }
  | { readonly kind: 'locked'; readonly needsYes: readonly FreezeField[]; readonly cantChange: readonly FreezeField[] }

/** One part: its word now, how many of its sizes or lines it holds, the rule in words, what comes next (B-OC-017), whose rule. */
export interface FreezePart {
  readonly field: FreezeField
  readonly word: FreezeWord
  /** "8 of 14 sizes" / "2 of 3 lines": how many are not open, of how many (only when some but not all are); null: none to count. */
  readonly of: { readonly count: number; readonly total: number; readonly unit: 'sizes' | 'lines' } | null
  /** The rule in words (its own note, else the rule), when the part is not open. */
  readonly words: { readonly en: string; readonly it: string } | null
  /** What freezes next and from which stage (S2: B-OC-017); null: nothing comes, or not sent yet. */
  readonly next: { readonly stage: FreezeStage; readonly word: FreezeWord } | null
  /** The deciding rule is the customer's own set (S2); false: the company's, or not sent yet. */
  readonly customerRule: boolean
}

const RANK: Readonly<Record<FreezeState, number>> = Object.freeze({ OPEN: 0, CHANGE_REQUEST: 1, BLOCKED: 2 })
type Verdictish = { readonly state: FreezeState; readonly words?: { readonly en: string; readonly it: string } | undefined; readonly next?: { readonly stage: FreezeStage; readonly action: FreezeState } | null | undefined; readonly customerRule?: boolean | undefined }

const strictest = <T extends Verdictish>(all: readonly T[]): T | null => all.reduce<T | null>((worst, entry) => (!worst || RANK[entry.state] > RANK[worst.state] ? entry : worst), null)

/** Each part of the order as the freeze read gives it: a size or a line field by its strictest verdict, an order field by its own. */
export function freezePartsOf(freeze: Freeze): FreezePart[] {
  return FREEZE_PARTS.map((field) => {
    const own = freeze.order.fields.find((entry) => entry.field === field) ?? null
    const perLine: Verdictish[] = field === 'SIZE_QUANTITY' ? freeze.lines.flatMap((line) => line.sizes) : field === 'COLOURWAY' || field === 'PRICE' ? freeze.lines.flatMap((line) => line.fields.filter((entry) => entry.field === field)) : []
    // The strictest verdict: the order's own (at its furthest stage) and every line's or size's — as the freeze panel always read it.
    const all: Verdictish[] = [...(own ? [own] : []), ...perLine]
    const worst = strictest(all)
    const held = all.filter((entry) => entry.state !== 'OPEN').length
    const unit = field === 'SIZE_QUANTITY' ? ('sizes' as const) : ('lines' as const)
    const next = worst?.next ?? null
    return {
      field,
      word: FREEZE_WORD[worst?.state ?? 'OPEN'],
      of: perLine.length > 1 && held > 0 && held < perLine.length ? { count: held, total: perLine.length, unit } : null,
      words: worst && worst.state !== 'OPEN' ? (worst.words ?? null) : null,
      next: next && next.action !== worst?.state ? { stage: next.stage, word: FREEZE_WORD[next.action] } : null,
      customerRule: worst?.customerRule === true,
    }
  })
}

const GOODS_LEFT: ReadonlySet<Order['status']> = new Set<Order['status']>(['PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED'])

/** The section's one sentence: the order's state first, then our approval that blocks, then the rules. */
export function freezeVerdictOf(input: { readonly status: Order['status']; readonly changes: Pick<Changes, 'waitingForYes' | 'changes'> | null; readonly freeze: { readonly value: Freeze | null; readonly problem: string | null } | null }): FreezeVerdict {
  if (input.status === 'CANCELLED') return { kind: 'cancelled' }
  if (input.status === 'CLOSED') return { kind: 'closed' }
  if (GOODS_LEFT.has(input.status)) return { kind: 'goodsLeft' }
  if (input.status === 'PENDING_APPROVAL') return { kind: 'firstYes' }
  const waiting = input.changes?.waitingForYes ?? null
  if (waiting) return { kind: 'blocked', revision: input.changes?.changes.find((change) => change.yes.taskId === waiting.taskId)?.revision ?? null, since: waiting.since }
  const freeze = input.freeze?.value ?? null
  if (!freeze) return { kind: input.freeze?.problem ? 'failed' : 'reading' }
  const parts = freezePartsOf(freeze)
  const needsYes = parts.filter((part) => part.word === 'needsYes').map((part) => part.field)
  const cantChange = parts.filter((part) => part.word === 'cantChange').map((part) => part.field)
  if (needsYes.length > 0 || cantChange.length > 0) return { kind: 'locked', needsYes, cantChange }
  return { kind: freeze.order.stage === null ? 'nothingOnFloor' : 'allOpen' }
}

/** The verdicts whose order no longer changes: no door, no parts table, no "the customer can also ask" line. */
export const isFinalVerdict = (verdict: FreezeVerdict): boolean => verdict.kind === 'cancelled' || verdict.kind === 'closed' || verdict.kind === 'goodsLeft'

/**
 * "Change the lines ›" (the Lines tab, the one place to change): for orders.manage on an order that can still change; held — with
 * its reason in words — while our approval of an old change blocks every other change.
 */
export function linesDoorOf(verdict: FreezeVerdict, can: { readonly manage: boolean }): { readonly held: { readonly revision: number | null } | null } | null {
  if (!can.manage || isFinalVerdict(verdict)) return null
  return { held: verdict.kind === 'blocked' ? { revision: verdict.revision } : null }
}
