import type { HealthInput, HealthState } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import type { Phrase } from '../../model'
import type { BrandHealth, Dates, Headline, OrderProduction, WaitingOn, Words } from './api'
// ---- F-OP-103: the ONE waiting list's inputs (the customer's requests as read, the order's open yes, Still to do) ----
import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { OpenApproval } from '../../api'
import { stillRowsOf, type StillRowOf } from '../changes/model'
import { yesDoorOf } from '../../depth/model' // F-OP-117: the Changes dot
import { waitsForMe } from '../../../../home/approvals/requests/model' // F-OP-117
// F-OO-202: ONE place per waiting row, decided by the domain (B-OO-011) — the web stamps it, never a second map
import { BLOCKER_KINDS, ORDER_YES_KINDS, placeOf, YES_PLACE, type BlockerKind, type BlockerPlace, type OrderYesKind } from '@nexus/factory-domain/production-brand/waiting'

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview's rules, without
 * a screen. Every figure is the production read's (B-SA-031: the order's own cells); nothing here names another customer, a
 * worker or a station. Words are `orders` keys (`overview.*`) and the production parts' own (`parts.*`).
 *
 * F-OO-100 (order overview lane: one file per section): each section's own rules live in its file — where.ts, progress.ts,
 * people.ts, dates.ts, linked.ts, facts.ts. This file keeps what more than one place reads: the API's words, the health chip (the
 * band too), the read's state, the requested date's field id (Lines too) and the ONE waiting list (the header, the cards and the
 * Changes tab; F-OO-202: each row with its place — Where it is now, Next dates or Requests & changes).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The API's own words in the page's language. */
export const say = (words: Words, locale: string): string => (locale === 'it' ? words.it : words.en)

/** The keeper's health → the parts' chip states. */
const HEALTH: Readonly<Record<BrandHealth, HealthState>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })

// ---- O1 "Where it is now" ------------------------------------------------------------------------------------------------------

/** The statuses after production (the headline's words and the health's lateness read them; F-OO-100: where.ts too). */
export const AFTER: readonly Order['status'][] = ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED']

/**
 * The health chip's input: the keeper's health and a person's raise (its note only for the office, workorders.view); no state kept
 * yet: the order read's own lateness in the same words ("Late · 3 d"), else not known.
 */
export function healthInputOf(order: Pick<Order, 'daysLate' | 'promiseDate' | 'status'>, headline: Headline | null | undefined, dates?: Dates | null): HealthInput {
  const health = headline?.health ?? null
  const daysLate = order.daysLate !== null && order.daysLate > 0 && !AFTER.includes(order.status) ? order.daysLate : null
  if (!health) return { computed: daysLate !== null ? 'LATE' : undefined, daysLate, promise: order.promiseDate, plan: dates?.planned.finish ?? null }
  const raise = health.raise
  return {
    computed: HEALTH[health.computed ?? health.code],
    daysLate,
    raised: raise ? { reason: raise.reasonCode as NonNullable<HealthInput['raised']>['reason'], note: raise.note, by: raise.by?.name ?? null, at: raise.at } : null,
    promise: order.promiseDate,
    plan: dates?.planned.finish ?? null,
  }
}

/** The band draws the chip only when it matters: Late or At risk (never "On track", never "No date yet"). */
export function bandHealthOf(input: HealthInput): boolean {
  return input.computed === 'LATE' || input.computed === 'AT_RISK' || !!input.raised
}

// F-OO-202 (review F14): "Who acts next" is gone from the office page — `whoActsNextOf` and the state's `next` with it (nobody drew
// them after F-OO-103). The keeper's `waitingOn` (the domain's production-brand/waiting) stays the ONE rule of who the order waits on,
// read by the orders list and the portal; the office page groups the requests by who waits instead (Requests & changes).

// ---- the read's state (loading, failed, withheld) ------------------------------------------------------------------------------

/** The order's production read on the page: still read, read (with its time), or failed (only this part says so). */
export type ProductionState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly read: OrderProduction } | { readonly status: 'failed'; readonly problem: string }

/** The read once it is there. */
export const readOf = (state: ProductionState | null | undefined): OrderProduction | null => (state?.status === 'ready' ? state.read : null)

/**
 * A re-read of some parts put into the read the page holds: the parts read again replace theirs (and their withheld keys); the rest
 * stay as they were. The time is the newest read's.
 */
export function mergeRead(known: OrderProduction | null, next: OrderProduction): OrderProduction {
  if (!known) return next
  const reread = new Set(next.parts)
  const keep = known.withheld.filter((key) => !reread.has(key.split('.')[0] as never))
  return {
    ...known,
    ...Object.fromEntries(next.parts.map((part) => [part, next[part]])),
    order: next.order,
    asOf: next.asOf,
    refreshSeconds: next.refreshSeconds,
    parts: [...new Set([...known.parts, ...next.parts])],
    withheld: [...new Set([...keep, ...next.withheld])],
  }
}

// ── F-SA-233 (sales page plan N2, picks P2, P3, P16; 10-order-page §2.1 O3–O8; review C-20) ──────────────────────────────────────

// ---- F-OP-103 (order page plan N1; 10-order-page §3.2; 13-backend B4; review R-21, R-22): the ONE waiting list ----------------------
/**
 * The order's waiting list, ONE source for Overview's cards and the Changes badge (R-22; the dock does not read it, R-21): each blocker
 * of the production read (`headline.waiting.blockers[]`, its `ref` and `sub`) and each open yes of the order (the order read's
 * `openApprovals`, B-OP-020) is ONE row — who it waits on, since when, its words, its place (F-OO-202) and ONE door:
 *
 *   BRAND_REQUEST · REQUEST / COUNTER     Answer… (the ONE review window on this page, `?open=`) — an agreed or lapsed counter waits on us
 *   BRAND_REQUEST · PROBLEM               Reply in the thread (This order's conversation at the message it was raised with)
 *   BRAND_REQUEST · REPROMISE             Production › #dates — never drawn as such: Next dates draws the row with Decide… (F-OO-143)
 *   an open yes of the order              Confirm / Refuse… for an approver who did not ask; held for the asker; who decides (F-OP-101)
 *   APPROVAL of our counter-offer         Open… (F-OO-204: the ONE review window, `?open=`: our counter and Decide for <customer>)
 *   APPROVAL · PARTNER_TASK               Their turn (F-OO-204: what we asked the customer — it answers; no door of ours)
 *   DEPOSIT                               Record the payment (payments.record, the request open) or Money ›
 *   BRAND_PAUSE                           Lift the customer's pause… in place (F-OP-116: the shared Lift; no ref: Production › #holds)
 *   holds · quality · work                Production › #holds
 *   MATERIAL_SHORT · GATE                 Production › #dates
 *
 * Oldest first (a row with no known start last). Nothing here names another customer: every row is this order's own read.
 *
 * F-OO-202 (review F15; plan §9): each row is stamped with ONE place by the domain (`placeOf` keyed on kind + sub, `YES_PLACE` for an
 * open yes — B-OO-011): HOLD (Where it is now's strips), DATE (Next dates; a refused new date too, F3) or REQUEST (Requests & changes).
 * A kind this page does not know yet is a REQUEST: it stays on the card, never hidden.
 */
export type WaitingDoor =
  | { readonly kind: 'answer'; readonly requestId: string; readonly request: BrandRequest | null }
  | { readonly kind: 'reply'; readonly messageId: string | null }
  | { readonly kind: 'yes'; readonly task: OpenApproval }
  | { readonly kind: 'payment'; readonly requestId: string }
  | { readonly kind: 'tab'; readonly tab: 'production' | 'money'; readonly anchor: string | null }
  /** F-OP-116: the customer's pause on a work order this reader reaches: "Lift the customer's pause…" (the shared Lift, F-OP-114). */
  | { readonly kind: 'lift'; readonly workOrderId: string }
  // ---- F-OO-204 (11-design §5.3, §5.4): no dead "Changes ›" door on what waits on the customer ----
  /** Our counter-offer still open: Open… the ONE review window (it shows our counter and "Decide for <customer>"); it only opens. */
  | { readonly kind: 'open'; readonly requestId: string; readonly request: BrandRequest | null }
  /** What we asked the customer (a yes, an approval, a task on its portal): theirs to answer — "Their turn", no button. */
  | { readonly kind: 'their' }
  // ---- end F-OO-204
  // ---- F-OC-102 (18-lead-settles L11): the customer said no to the order's latest revision while its wait still stands — it waits on
  // us (restore it as before, or change it again): its row opens the revision's own row in Changes › What changed (`#change-<id>`).
  | { readonly kind: 'refused'; readonly amendmentId: string }
  // ---- end F-OC-102

/** A row's words: the API's own (it + en), or the page's phrase (its `{customer}` and the request's kind as `{what}` filled in: rowWordsOf). */
export type WaitingWords = { readonly kind: 'api'; readonly words: Words } | { readonly kind: 'phrase'; readonly phrase: Phrase; readonly requestKind?: string | null }

export interface WaitingRow {
  readonly key: string
  /** The blocker's kind, or YES for an open yes of the order. */
  readonly kind: string
  readonly sub: string | null
  /** F-OP-301 (walk #1): the record it is about (the Changes tab names an approval we asked by its own question); null: none. */
  readonly ref: { readonly type: string; readonly id: string } | null
  readonly on: WaitingOn
  readonly since: string | null
  readonly words: WaitingWords
  readonly door: WaitingDoor
  /** F-OO-202: where the page shows it — HOLD: Where it is now · DATE: Next dates · REQUEST: Requests & changes (and the Changes tab). */
  readonly place: BlockerPlace
  // ---- F-OC-103 (B-OC-004): by when the customer answers, and what a portal task asks; absent: not read (an older answer) ----
  readonly due?: string | null
  readonly task?: { readonly kind: string; readonly label: string } | null
  // ---- end F-OC-103
}

const HOLD_KINDS: ReadonlySet<string> = new Set(['BRAND_PAUSE', 'QUALITY_HOLD', 'NO_MOVE', 'NONCONFORMANCE', 'RELEASE_CHECK', 'SUBCONTRACT', 'CUSTOMER_MATERIAL'])
const DATE_KINDS: ReadonlySet<string> = new Set(['MATERIAL_SHORT', 'GATE'])

interface WaitingInputs {
  /** The customer's requests of this order as read (the review window's door needs the request); null: not read. */
  readonly requests: readonly BrandRequest[] | null | undefined
  /** The order's open requests for a yes (the order read's, B-OP-020). */
  readonly approvals: readonly OpenApproval[] | null | undefined
  /** May record a payment (payments.record). */
  readonly recordPayment: boolean
  /** The page's language (an open yes names its kind in it). */
  readonly locale: string
}

type Blocker = Headline['waiting']['blockers'][number]

function doorOf(blocker: Blocker, inputs: WaitingInputs): WaitingDoor {
  const ref = blocker.ref ?? null
  // F-OC-102 (L11): a revision the customer said no to (the waiting read names the amendment), whatever kind the read calls it.
  if (ref?.type === 'SalesOrderAmendment' && blocker.on === 'US') return { kind: 'refused', amendmentId: ref.id }
  if (blocker.kind === 'BRAND_REQUEST') {
    if ((blocker.sub === 'REQUEST' || blocker.sub === 'COUNTER') && ref) return { kind: 'answer', requestId: ref.id, request: (inputs.requests ?? []).find((request) => request.id === ref.id) ?? null }
    if (blocker.sub === 'PROBLEM') return { kind: 'reply', messageId: ref?.messageId ?? null }
    return { kind: 'tab', tab: 'production', anchor: 'dates' }
  }
  // F-OM-104 (P0-B11): without the payment right the door lands on Money › Payments (the deposit is the plan's first step).
  if (blocker.kind === 'DEPOSIT') return inputs.recordPayment && ref?.type === 'DepositRequest' ? { kind: 'payment', requestId: ref.id } : { kind: 'tab', tab: 'money', anchor: 'payments' }
  // F-OO-204: our open counter-offer opens the ONE review window; anything else we asked the customer is theirs to answer.
  if (blocker.kind === 'APPROVAL' && ref?.type === 'OrderChangeRequest') return { kind: 'open', requestId: ref.id, request: (inputs.requests ?? []).find((request) => request.id === ref.id) ?? null }
  if (blocker.kind === 'APPROVAL' || blocker.kind === 'PARTNER_TASK') return { kind: 'their' }
  // F-OP-116: the customer's pause is lifted in place (a work order the reader does not reach has no ref: Production › holds).
  if (blocker.kind === 'BRAND_PAUSE' && ref?.type === 'WorkOrder') return { kind: 'lift', workOrderId: ref.id }
  // F-PT-301 (10-design §6): each door lands where the thing is answered — the subcontractor's work on its work order's row, the
  // customer's goods and what we buy short on Materials.
  const place = PLACE_OF[blocker.kind]
  if (place) return { kind: 'tab', tab: 'production', anchor: place }
  if (DATE_KINDS.has(blocker.kind)) return { kind: 'tab', tab: 'production', anchor: 'dates' }
  return { kind: 'tab', tab: 'production', anchor: HOLD_KINDS.has(blocker.kind) ? 'holds' : null }
}
/** F-PT-301: the blockers whose door lands on another section of Production than Problems & holds. */
const PLACE_OF: Readonly<Record<string, string>> = Object.freeze({ SUBCONTRACT: 'work-orders', CUSTOMER_MATERIAL: 'materials', MATERIAL_SHORT: 'materials' })

function wordsOf(blocker: Blocker, inputs: WaitingInputs): WaitingWords {
  const api: WaitingWords = { kind: 'api', words: blocker.words }
  const request = blocker.ref ? ((inputs.requests ?? []).find((entry) => entry.id === blocker.ref!.id) ?? null) : null
  // F-OO-204: our open counter-offer, by the request it answers ("Our counter-offer: Change · line 20 · L 2 → 3"); never its fee.
  if (blocker.kind === 'APPROVAL' && blocker.ref?.type === 'OrderChangeRequest') return request ? { kind: 'phrase', phrase: phrase('waiting.counterOpen'), requestKind: request.kind } : api
  if (blocker.kind !== 'BRAND_REQUEST') return api
  // "<Customer> asks: <kind>" — the band notice's own words (band.asks).
  if (blocker.sub === 'REQUEST') return request ? { kind: 'phrase', phrase: phrase('band.asks'), requestKind: request.kind } : api
  // F-OO-204: an agreed or lapsed counter names the request too (its `{what}`).
  if (blocker.sub === 'COUNTER') return request?.counter?.state === 'AGREED' ? { kind: 'phrase', phrase: phrase('waiting.counterAgreed'), requestKind: request.kind } : request?.counter?.state === 'LAPSED' ? { kind: 'phrase', phrase: phrase('waiting.counterLapsed'), requestKind: request.kind } : api
  if (blocker.sub === 'PROBLEM') return { kind: 'phrase', phrase: phrase('waiting.problem') }
  if (blocker.sub === 'REPROMISE') return { kind: 'phrase', phrase: phrase('waiting.repromise') }
  return api
}

// ---- F-OO-202: the domain's place of a row (B-OO-011), never a web map of its own ----
const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(BLOCKER_KINDS)
const YES_KINDS: ReadonlySet<string> = new Set<string>(ORDER_YES_KINDS)
/** A blocker's place: its kind and, for a customer request, its sub (a refused new date is a DATE); an unknown kind: a REQUEST. */
const blockerPlaceOf = (blocker: Blocker): BlockerPlace => (KNOWN_KINDS.has(blocker.kind) ? placeOf({ kind: blocker.kind as BlockerKind, sub: blocker.sub ?? null }) : 'REQUEST')
/** An open yes's place: the order's own yes and its credit hold stop the order (HOLD); an old change's yes is a REQUEST. */
const yesPlaceOf = (kind: string): BlockerPlace => (YES_KINDS.has(kind) ? YES_PLACE[kind as OrderYesKind] : 'REQUEST')
// ---- end F-OO-202

const byOldest = (a: WaitingRow, b: WaitingRow): number => (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0) || (a.since ?? '').localeCompare(b.since ?? '')

export function waitingOf(read: Pick<OrderProduction, 'headline'> | null | undefined, inputs: WaitingInputs): WaitingRow[] {
  const blockers = read?.headline?.waiting.blockers ?? []
  const rows: WaitingRow[] = blockers.map((blocker, index) => ({
    key: `${blocker.kind}:${blocker.ref?.type ?? '-'}:${blocker.ref?.id ?? index}`,
    kind: blocker.kind,
    sub: blocker.sub ?? null,
    ref: blocker.ref ? { type: blocker.ref.type, id: blocker.ref.id } : null, // F-OP-301
    on: blocker.on,
    since: blocker.since,
    words: wordsOf(blocker, inputs),
    door: doorOf(blocker, inputs),
    place: blockerPlaceOf(blocker), // F-OO-202
    due: blocker.due ?? null, // F-OC-103
    task: blocker.task ?? null, // F-OC-103
  }))
  // An open yes of the order waits on us (an office person decides it): its own row with the yes in place.
  for (const task of inputs.approvals ?? []) {
    rows.push({ key: `YES:${task.taskId}`, kind: 'YES', sub: null, ref: null, on: 'US', since: task.requestedAt, words: { kind: 'phrase', phrase: phrase('waiting.yes', { kind: inputs.locale === 'en' ? task.kindLabel.en : task.kindLabel.it }) }, door: { kind: 'yes', task }, place: yesPlaceOf(task.kind) /* F-OO-202 */ })
  }
  // Rows of the same start keep the read's order.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => byOldest(a.row, b.row) || a.index - b.index).map((entry) => entry.row)
}

/**
 * A row's words in the page's language: the API's own, or the phrase with the customer's name and the request's kind in words.
 * F-OO-204 (11-design §5.2): with `askWords`, a request the page read is said whole — its kind and each size asked old → new, as the
 * band notice says it ("<Customer> asks: Change · line 10 · M 40 → 36").
 */
export function rowWordsOf(
  row: Pick<WaitingRow, 'words' | 'door'>,
  say: { readonly t: (key: string, params?: Record<string, string | number>) => string; readonly kindWords: (kind: string) => string; readonly locale: string; readonly customer: string; readonly askWords?: (request: BrandRequest) => string },
): string {
  if (row.words.kind === 'api') return row.words.words[say.locale === 'en' ? 'en' : 'it']
  const { phrase: words, requestKind } = row.words
  const request = row.door.kind === 'answer' || row.door.kind === 'open' ? row.door.request : null // F-OO-204
  const what = request && say.askWords ? say.askWords(request) : requestKind ? say.kindWords(requestKind) : null
  return say.t(words.key, { ...(words.params ?? {}), customer: say.customer, ...(what !== null ? { what } : {}) })
}

/**
 * "Requests & changes": Waiting on us N · Waiting on <Customer> N · Still to do N; "nothing" only when all three are empty.
 * F-OO-202: its two lists hold the REQUEST rows only — holds are Where it is now's, dates Next dates' — so the Changes badge, its dot
 * and the Changes tab (which read this card) count requests and Still to do, nothing twice (D8). F-OO-205: no "latest change" any
 * more (Changes › History tells it), so the card reads nothing of the order itself.
 */
export interface WaitingCard {
  readonly onUs: readonly WaitingRow[]
  readonly onCustomer: readonly WaitingRow[]
  readonly still: readonly StillRowOf[]
  readonly nothing: boolean
}

export function waitingCardOf(rows: readonly WaitingRow[], read: OrderProduction | null | undefined): WaitingCard {
  const requests = rows.filter((row) => row.place === 'REQUEST') // F-OO-202
  const onUs = requests.filter((row) => row.on === 'US')
  const onCustomer = requests.filter((row) => row.on === 'BRAND')
  const still = stillRowsOf(read)
  return { onUs, onCustomer, still, nothing: onUs.length === 0 && onCustomer.length === 0 && still.length === 0 }
}

/**
 * R-22: the Changes tab's badge counts the card's own rows (waiting on us, on the customer, still to do) — never a second rule.
 * F-OO-202 (D8): the card's rows are requests now, so the badge is request rows + Still to do (SEED-SO-0002: 5 → 3).
 */
export const changesBadgeOf = (card: Pick<WaitingCard, 'onUs' | 'onCustomer' | 'still'>): number => card.onUs.length + card.onCustomer.length + card.still.length

/**
 * F-OP-117 (10-order-page §6): the Changes tab's dot — one of the card's rows waits on THIS reader: a yes they decide, a request
 * their team answers, a Still to do row that is their turn.
 */
export function changesDotOf(card: Pick<WaitingCard, 'onUs' | 'still'>): boolean {
  if (card.still.some((row) => row.mayAct)) return true
  return card.onUs.some((row) => (row.door.kind === 'yes' && yesDoorOf(row.door.task).kind === 'decide') || (row.door.kind === 'answer' && !!row.door.request && waitsForMe(row.door.request)))
}
// ---- end F-OP-103

// ---- F-OP-301 (walk #1, #2, #3; plan N1 "Waiting": the header, the card and the Changes badge use the same list) -----------------
/**
 * The ONE call every reader of the waiting list makes — Overview's cards, the Changes badge and dot, and the Changes tab's "Waiting on
 * us" / "Waiting on the customer" — so they cannot disagree (the walk saw badge 4, Overview 3 + 1, Changes 1 and "Nothing waits on the
 * customer" on one order). While the production read is not in, nothing is claimed (`loading`: never "Nothing waits" before it); a
 * failed read says so. No production read on the page at all (a design case): the order's own open yes only.
 * F-OO-202: the same call hands each section its own rows by their place — `card` the requests (Requests & changes, the badge, the
 * Changes tab), `holds` Where it is now's (its strips group them, F-OO-104), `dates` Next dates' — each row in exactly one of them.
 */
export type WaitingState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly rows: readonly WaitingRow[]; readonly card: WaitingCard; readonly holds: readonly WaitingRow[]; readonly dates: readonly WaitingRow[] }

interface WaitingPage {
  readonly production?: ProductionState | null
  readonly requests?: { readonly value: readonly BrandRequest[] | null } | null
  readonly can: { readonly recordPayment: boolean }
}

// Z02 cleanup (W08's note): the call reads the order's open yeses only (the amendments left the card with F-OO-205).
export function orderWaitingOf(order: Pick<Order, 'openApprovals'>, page: WaitingPage, locale: string): WaitingState {
  const state = page.production ?? null
  if (state?.status === 'loading') return { status: 'loading' }
  if (state?.status === 'failed') return { status: 'failed', problem: state.problem }
  const read = readOf(state)
  const rows = waitingOf(read, { requests: page.requests?.value ?? null, approvals: order.openApprovals, recordPayment: page.can.recordPayment, locale })
  const card = waitingCardOf(rows, read) // F-OO-205: no latest change
  // F-OO-202: oldest first in each place, as in the list (no folding here: F-OO-104 groups the holds into one strip per kind).
  return { status: 'ready', rows, card, holds: rows.filter((row) => row.place === 'HOLD'), dates: rows.filter((row) => row.place === 'DATE') }
}
// ---- end F-OP-301

// ── end F-SA-233
