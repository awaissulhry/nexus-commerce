import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import type { CutStart } from '../sales/change-requests/rules'
import { askUsWords, CHANGED_SINCE_WORDS, MARK_URGENT_FIRST_WORDS, NOT_IN_PRODUCTION_WORDS, setBackWords, unchangedWords, URGENCY_NOT_OPEN_WORDS } from './words'

/**
 * B-PR-41 (production plan §3 "Customer urgency", "The brand never sees a queue place"; lead picks L17, L18, L20; review fixes
 * R-46, R-61, R-65): the customer's own urgency of its orders in production, pure. Replaces the old "rank".
 *
 *   the list      the customer's own orders: Urgent first in its own order (urgentRank 1 first), then Regular by the order's
 *                 date (SalesOrder.orderDate, oldest first), then when it was made, then its number. While the customer's
 *                 urgency switch is off its marks are kept but count for nothing: every order reads as Regular (R-46)
 *   the quota     how many of its open orders may be Urgent at once without asking us (PortalSettings.productionUrgentMax,
 *                 0 to 20, 3 by default). An "Urgent – asked" we accept may take it over the quota: "4 of 3 · 1 agreed with
 *                 us" (the marks we set, UrgencyActor FACTORY)
 *   a mark        at once while the switch is on, inside the quota and before Cutting — the cut facts are read LIVE in the
 *                 command (a cut of leather logged or a bundle made: sales/change-requests readCuts), never the stored stage
 *                 of the keeper (R-61); over the quota or from Cutting it becomes an ask ("Urgent – asked", answered by us);
 *                 refused while we locked the order (with the reason it reads); back to Regular is always free
 *   the order     the customer orders its Urgent list only; "Move to top" on a Regular order says "Mark urgent first" (R-65)
 *   undo          a batch is put back row by row; a row whose batch changed since is left as it is (B-PR-22a), and a row
 *                 going back to Urgent passes the mark's own rules (undo never makes an urgent mark the customer could not)
 *
 * The wall (L20, PW-11): every function takes ONE customer's rows and throws on a row of another customer; nothing here
 * returns a queue place, a count of another customer or who set a mark — only the customer's own list, "2 of 3 urgent used",
 * and words that name no line, work order, worker, site, workshop, supervisor or other customer. Our places in the backlog
 * are planning's (planning/backlog/rank brandSlots): a customer's urgent orders take only the places its OWN orders hold.
 */
export const BRAND_URGENCIES = ['URGENT', 'REGULAR'] as const
export type BrandUrgency = (typeof BRAND_URGENCIES)[number]

/**
 * Who set an order's urgency last (BrandOrderProduction.urgencySetBy, B-PR-15 mirrors it): the customer, or us (an "Urgent –
 * asked" we accepted, or a set-back to Regular). The customer reads ours as "Changed by us", never a name.
 */
export const URGENCY_ACTORS = ['BRAND', 'FACTORY'] as const
export type UrgencyActor = (typeof URGENCY_ACTORS)[number]

/** The urgent quota (PortalSettings.productionUrgentMax; the database keeps it 0 to 20). */
export const URGENT_MAX = Object.freeze({ min: 0, max: 20, byDefault: 3 })

/** The most orders one urgency command names (the portal's bulk bar, L25). */
export const URGENCY_BATCH_MAX = 50

/** What an urgent quota as asked would break (paths under `at`). */
export function urgentMaxProblems(value: unknown, at = 'body/productionUrgentMax'): Issue[] {
  if (typeof value === 'number' && Number.isInteger(value) && value >= URGENT_MAX.min && value <= URGENT_MAX.max) return []
  return [{ path: at, message: `The urgent quota is a whole number from ${URGENT_MAX.min} to ${URGENT_MAX.max}.` }]
}

/** One order of the customer's list, as the urgency rules read it (BrandOrderProduction beside its SalesOrder). */
export interface UrgencyRow {
  readonly orderId: string
  /** The order's customer: every row of one call is the same customer's. */
  readonly partyId: string
  readonly number: string
  /** SalesOrder.orderDate: "Regular by date sent". */
  readonly orderDate: BusinessDate
  readonly createdAt: Date
  readonly urgency: BrandUrgency
  /** Its place inside the customer's Urgent list (1 first); null when Regular. */
  readonly urgentRank: number | null
  /** Who set the urgency last (null: never set: Regular by default). */
  readonly setBy: UrgencyActor | null
  /** We locked it at Regular (production.brand.override), with the reason the customer reads. */
  readonly locked: boolean
  readonly lockReason: string | null
  /** Still in production for the customer: something is left to make or ship (else it left My production). */
  readonly open: boolean
}

/** Throws when a row is another customer's: the rules of one customer never read another's order (wall, PW-11). */
function ownRows<R extends Pick<UrgencyRow, 'partyId'>>(rows: readonly R[], partyId: string): readonly R[] {
  if (rows.some((row) => row.partyId !== partyId)) throw new Error("production-brand urgency: a customer's rules were given an order of another customer")
  return rows
}

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const rankOf = (row: Pick<UrgencyRow, 'urgentRank'>): number => row.urgentRank ?? Number.MAX_SAFE_INTEGER

/** The urgency that counts now: a mark counts only while the customer's switch is on (R-46: dormant, not cleared). */
export const countedUrgency = (row: Pick<UrgencyRow, 'urgency'>, urgencyOn: boolean): BrandUrgency => (urgencyOn ? row.urgency : 'REGULAR')

/** Regular order: the order's date (oldest first), when it was made, its number. */
function regularCompare(a: UrgencyRow, b: UrgencyRow): number {
  return text(a.orderDate, b.orderDate) || a.createdAt.getTime() - b.createdAt.getTime() || text(a.number, b.number) || text(a.orderId, b.orderId)
}

/** The customer's list order with its switch on: Urgent by urgentRank, then Regular by date sent, made, number. */
export function listCompare(a: UrgencyRow, b: UrgencyRow): number {
  const urgentA = a.urgency === 'URGENT'
  const urgentB = b.urgency === 'URGENT'
  if (urgentA !== urgentB) return urgentA ? -1 : 1
  if (urgentA && rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b)
  return regularCompare(a, b)
}

/** The customer's own open orders in its list order (its switch off: every order by date sent, the marks kept dormant). */
export function brandList<R extends UrgencyRow>(rows: readonly R[], input: { readonly partyId: string; readonly urgencyOn: boolean }): R[] {
  const open = ownRows(rows, input.partyId).filter((row) => row.open)
  return [...open].sort(input.urgencyOn ? listCompare : regularCompare)
}

/** "n of max used": the customer's own open orders marked Urgent, and how many of them we set (an accepted ask). */
export interface UrgentUse {
  readonly used: number
  readonly max: number
  /** Urgent marks we set by accepting its "Urgent – asked" (they may take it over the quota). */
  readonly agreed: number
  /** Marks it may still set at once (0 at or over the quota). */
  readonly left: number
  readonly over: boolean
}

/** The customer's use of its quota: its OWN open orders only (a row of another customer throws). */
export function usedOf(rows: readonly UrgencyRow[], input: { readonly partyId: string; readonly max: number }): UrgentUse {
  const urgent = ownRows(rows, input.partyId).filter((row) => row.open && row.urgency === 'URGENT')
  const used = urgent.length
  return { used, max: input.max, agreed: urgent.filter((row) => row.setBy === 'FACTORY').length, left: Math.max(0, input.max - used), over: used > input.max }
}

/** The place a new mark takes: the end of the customer's Urgent list (the command rewrites the ranks 1..n under its lock). */
export const newMarkRank = (rows: readonly UrgencyRow[], partyId: string): number => usedOf(rows, { partyId, max: 0 }).used + 1

// ---- the mark ---------------------------------------------------------------------------------------------------------------

export const MARK_REFUSALS = ['URGENCY_OFF', 'NOT_OPEN', 'LOCKED', 'UNCHANGED'] as const
export type MarkRefusal = (typeof MARK_REFUSALS)[number]
export const ASK_REASONS = ['CUT', 'OVER_QUOTA'] as const
export type AskReason = (typeof ASK_REASONS)[number]

export type MarkDecision =
  | { readonly outcome: 'AT_ONCE' }
  /** It becomes "Urgent – asked" (a RUSH request we answer; B-PR-46a; until then refused with these words: "Ask us"). */
  | { readonly outcome: 'ASK'; readonly reason: AskReason; readonly words: Words }
  | { readonly outcome: 'REFUSED'; readonly code: MarkRefusal; readonly words: Words }

export interface MarkFacts {
  /** PortalSettings.productionUrgencyOn. */
  readonly urgencyOn: boolean
  /** PortalSettings.productionUrgentMax. */
  readonly max: number
  /** The order now (its row read in the command). */
  readonly row: UrgencyRow
  /** The customer's own open orders marked Urgent now (usedOf(...).used; the order itself counted when it is Urgent). */
  readonly used: number
  /**
   * LIVE cut facts read in the command: the order's first cut — a cut of leather logged or a bundle made of one of its cells
   * (sales/change-requests readCuts over its lines); null: nothing cut. Never BrandOrderProduction.stage (R-61).
   */
  readonly cut: CutStart | null
}

/**
 * What a mark as asked does: at once, an ask, or a refusal in words. Back to Regular is always free (while the switch is on
 * and the order is open); Urgent is at once only inside the quota and before Cutting, never while we locked the order.
 */
export function markDecision(wanted: BrandUrgency, facts: MarkFacts): MarkDecision {
  const refused = (code: MarkRefusal, words: Words): MarkDecision => ({ outcome: 'REFUSED', code, words })
  if (!facts.urgencyOn) return refused('URGENCY_OFF', URGENCY_NOT_OPEN_WORDS)
  if (!facts.row.open) return refused('NOT_OPEN', NOT_IN_PRODUCTION_WORDS)
  if (facts.row.urgency === wanted) return refused('UNCHANGED', unchangedWords(wanted))
  if (wanted === 'REGULAR') return { outcome: 'AT_ONCE' }
  if (facts.row.locked) return refused('LOCKED', setBackWords(facts.row.lockReason))
  if (facts.cut !== null) return { outcome: 'ASK', reason: 'CUT', words: askUsWords('CUT', facts.max) }
  if (facts.used >= facts.max) return { outcome: 'ASK', reason: 'OVER_QUOTA', words: askUsWords('OVER_QUOTA', facts.max) }
  return { outcome: 'AT_ONCE' }
}

// ---- the customer's Urgent list ---------------------------------------------------------------------------------------------

/**
 * What the customer's new Urgent list breaks (PUT /portal/production/urgent-order, B-PR-22a: its WHOLE Urgent list in the new
 * order). An id that is not one of its open orders reads "not found" (neutral: another customer's order is never named); a
 * Regular order says "Mark urgent first"; every urgent order once.
 */
export function urgentOrderProblems(rows: readonly UrgencyRow[], input: { readonly partyId: string; readonly urgencyOn: boolean; readonly orderIds: readonly string[] }, at = 'body/orderIds'): Issue[] {
  const own = new Map(ownRows(rows, input.partyId).filter((row) => row.open).map((row) => [row.orderId, row]))
  if (!input.urgencyOn) return [{ path: at, message: URGENCY_NOT_OPEN_WORDS.en }]
  const issues: Issue[] = []
  const seen = new Set<string>()
  input.orderIds.forEach((orderId, index) => {
    const row = own.get(orderId)
    if (seen.has(orderId)) issues.push({ path: `${at}/${index}`, message: 'This order is named twice.' })
    else if (!row) issues.push({ path: `${at}/${index}`, message: 'Order not found.' })
    else if (row.urgency !== 'URGENT') issues.push({ path: `${at}/${index}`, message: MARK_URGENT_FIRST_WORDS.en })
    seen.add(orderId)
  })
  const missing = [...own.values()].filter((row) => row.urgency === 'URGENT' && !seen.has(row.orderId))
  if (missing.length > 0) issues.push({ path: at, message: 'Name every urgent order, in the order you want them.' })
  return issues
}

/** "Move to top": the customer's Urgent list with this order first, or "Mark urgent first" for a Regular order. */
export function moveToTop(rows: readonly UrgencyRow[], input: { readonly partyId: string; readonly orderId: string }): { readonly orderIds: string[] } | { readonly refused: Words } {
  const own = ownRows(rows, input.partyId).filter((row) => row.open)
  const row = own.find((entry) => entry.orderId === input.orderId)
  if (!row) return { refused: NOT_IN_PRODUCTION_WORDS }
  if (row.urgency !== 'URGENT') return { refused: MARK_URGENT_FIRST_WORDS }
  const urgent = brandList(own, { partyId: input.partyId, urgencyOn: true }).filter((entry) => entry.urgency === 'URGENT')
  return { orderIds: [row.orderId, ...urgent.filter((entry) => entry.orderId !== row.orderId).map((entry) => entry.orderId)] }
}

// ---- undo of a batch ---------------------------------------------------------------------------------------------------------

/** One row of a batch to put back: the order now, the batch that changed it last, and its state before the batch. */
export interface UndoEntry {
  readonly row: UrgencyRow
  /** BrandOrderProduction.urgencyBatchId now. */
  readonly batchIdNow: string | null
  /** The batch's audit `before`. */
  readonly before: { readonly urgency: BrandUrgency; readonly urgentRank: number | null }
}

export interface UndoPlan {
  readonly restore: readonly { readonly orderId: string; readonly urgency: BrandUrgency; readonly urgentRank: number | null }[]
  readonly skipped: readonly { readonly orderId: string; readonly words: Words }[]
}

/**
 * Undo of one urgency batch of the customer: each row back to its state before the batch, unless its batch changed since (left
 * as it is) or going back to Urgent would break the mark's own rules (locked, from Cutting, over the quota). Going back to
 * Regular is always free.
 */
export function undoPlan(
  batchId: string,
  entries: readonly UndoEntry[],
  facts: {
    readonly partyId: string
    readonly urgencyOn: boolean
    readonly max: number
    /** The customer's own open orders marked Urgent now (usedOf over all its rows, not only the batch's). */
    readonly used: number
    /** LIVE cut facts per order (readCuts), as for a mark. */
    readonly cuts: ReadonlyMap<string, CutStart>
  },
): UndoPlan {
  ownRows(
    entries.map((entry) => entry.row),
    facts.partyId,
  )
  const restore: { orderId: string; urgency: BrandUrgency; urgentRank: number | null }[] = []
  const skipped: { orderId: string; words: Words }[] = []
  let used = facts.used
  for (const entry of entries) {
    const { row } = entry
    if (entry.batchIdNow !== batchId) {
      skipped.push({ orderId: row.orderId, words: CHANGED_SINCE_WORDS })
      continue
    }
    if (row.urgency === entry.before.urgency) continue
    const decision = markDecision(entry.before.urgency, { urgencyOn: facts.urgencyOn, max: facts.max, row, used, cut: facts.cuts.get(row.orderId) ?? null })
    if (decision.outcome !== 'AT_ONCE') {
      skipped.push({ orderId: row.orderId, words: decision.words })
      continue
    }
    used += entry.before.urgency === 'URGENT' ? 1 : -1
    restore.push({ orderId: row.orderId, urgency: entry.before.urgency, urgentRank: entry.before.urgency === 'URGENT' ? entry.before.urgentRank : null })
  }
  return { restore, skipped }
}

// ---- B-PR-22a: what an urgency command did to one order ------------------------------------------------------------------------

/**
 * Done, or why not (in words beside it): ASK_CUT / ASK_OVER_QUOTA = "Ask us" (B-PR-46a turns them into "Urgent – asked"), the
 * mark's refusals (URGENCY_OFF, NOT_OPEN, LOCKED, UNCHANGED), NOT_KEPT (an order just confirmed: our keeper has not written its
 * production state yet), NO_RIGHT (the office: seen, but the person may not change that customer's urgency).
 */
export const URGENCY_OUTCOMES = ['DONE', 'ASK_CUT', 'ASK_OVER_QUOTA', 'URGENCY_OFF', 'NOT_OPEN', 'LOCKED', 'UNCHANGED', 'NOT_KEPT', 'NO_RIGHT'] as const
export type UrgencyOutcome = (typeof URGENCY_OUTCOMES)[number]

// ---- B-PR-22a: the Urgent list rewritten 1..n ------------------------------------------------------------------------------------

/**
 * The customer's Urgent list after an undo: `current` its urgent orders now, in their order (ids); `placed` the orders put back,
 * each at the place (1 first) it held before its batch — placed from the first place down, each clamped to the end of the list
 * as it stands. Every other order keeps its order. The command writes the result as the ranks 1..n (no database key on the
 * rank: B-PR-15; the customer's lock serialises the rewrite).
 */
export function placeInUrgentList(current: readonly string[], placed: readonly { readonly orderId: string; readonly rank: number }[]): string[] {
  const moving = new Set(placed.map((entry) => entry.orderId))
  const out = current.filter((orderId) => !moving.has(orderId))
  for (const entry of [...placed].sort((a, b) => a.rank - b.rank || text(a.orderId, b.orderId))) {
    const at = Math.max(0, Math.min(Math.trunc(entry.rank) - 1, out.length))
    out.splice(at, 0, entry.orderId)
  }
  return out
}

/** The ranks 1..n of an Urgent list in its order. */
export const ranksOf = (order: readonly string[]): Map<string, number> => new Map(order.map((orderId, index) => [orderId, index + 1]))
