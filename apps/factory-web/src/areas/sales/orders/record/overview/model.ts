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

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview's rules, without
 * a screen. Every figure is the production read's (B-SA-031: the order's own cells); nothing here names another customer, a
 * worker or a station. Words are `orders` keys (`overview.*`) and the production parts' own (`parts.*`).
 *
 * F-OO-100 (order overview lane: one file per section): each section's own rules live in its file — where.ts, progress.ts,
 * people.ts, dates.ts, linked.ts, facts.ts. This file keeps what more than one place reads: the API's words, the health chip (the
 * band too), the read's state, the requested date's field id (Lines too) and the ONE waiting list (the header, the cards and the
 * Changes tab).
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

/**
 * F-OP-103: who acts next (office face) is the first row of the ONE waiting list (`waitingOf`), so its "since" is the card's and the
 * band's; with no row, who the read says the work waits on. The view says the row's words (`rowWordsOf`).
 */
// F-OP-301 (walk #2): with no row it never falls back to the kept `headline.waiting` (a stale "Waiting on us · 5 d" beside a card
// that says nothing waits): the oldest Still to do row (the card's third list) names who acts, else nobody (`who: null`, the view
// says the card's own "Nothing waits"); no headline read: not known.
export interface WhoActsNext {
  readonly who: WaitingOn | null | undefined
  readonly since: string | null
  readonly kind: 'request' | 'record'
  readonly row: WaitingRow | null
  /** F-OP-301: the Still to do row it names when no waiting row stands (its words are the view's `what`). */
  readonly still: StillRowOf | null
}

export function whoActsNextOf(rows: readonly WaitingRow[], headline: Headline | null | undefined, still: readonly StillRowOf[] = []): WhoActsNext {
  const first = rows[0] ?? null
  if (first) return { who: first.on, since: first.since, kind: REQUEST_KINDS.has(first.kind) ? 'request' : 'record', row: first, still: null }
  if (!headline) return { who: undefined, since: null, kind: 'record', row: null, still: null }
  const oldest = [...still].sort((a, b) => a.since.localeCompare(b.since))[0] ?? null
  if (oldest) return { who: oldest.waitingOn === 'CUSTOMER' ? 'BRAND' : 'US', since: oldest.since, kind: 'record', row: null, still: oldest }
  return { who: null, since: null, kind: 'record', row: null, still: null }
}

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

/** F-OP-104: the requested date's field on Lines in edit mode (its id: Next dates' "Change…" focuses it). */
export const REQUESTED_FIELD_ID = 'amend-requested-date'

// ---- F-OP-103 (order page plan N1; 10-order-page §3.2; 13-backend B4; review R-21, R-22): the ONE waiting list ----------------------
/**
 * The order's waiting list, ONE source for Overview's "Who acts next", the "Requests & changes" card and the Changes badge (R-22; the
 * dock does not read it, R-21): each blocker of the production read (`headline.waiting.blockers[]`, its `ref` and `sub`) and each open
 * yes of the order (the order read's `openApprovals`, B-OP-020) is ONE row — who it waits on, since when, its words, and ONE door:
 *
 *   BRAND_REQUEST · REQUEST / COUNTER     Answer… (the ONE review window on this page, `?open=`) — an agreed or lapsed counter waits on us
 *   BRAND_REQUEST · PROBLEM               Reply in the thread (This order's conversation at the message it was raised with)
 *   BRAND_REQUEST · REPROMISE             Production › #dates (Decide… is F-OP-105: deferred)
 *   an open yes of the order              Confirm / Refuse… for an approver who did not ask; held for the asker; who decides (F-OP-101)
 *   APPROVAL · PARTNER_TASK               Changes › (what we asked the customer: it decides)
 *   DEPOSIT                               Record the payment (payments.record, the request open) or Money ›
 *   BRAND_PAUSE                           Lift the customer's pause… in place (F-OP-116: the shared Lift; no ref: Production › #holds)
 *   holds · quality · work                Production › #holds
 *   MATERIAL_SHORT · GATE                 Production › #dates
 *
 * Oldest first (a row with no known start last). Nothing here names another customer: every row is this order's own read.
 */
export type WaitingDoor =
  | { readonly kind: 'answer'; readonly requestId: string; readonly request: BrandRequest | null }
  | { readonly kind: 'reply'; readonly messageId: string | null }
  | { readonly kind: 'yes'; readonly task: OpenApproval }
  | { readonly kind: 'payment'; readonly requestId: string }
  | { readonly kind: 'tab'; readonly tab: 'production' | 'money' | 'changes'; readonly anchor: string | null }
  /** F-OP-116: the customer's pause on a work order this reader reaches: "Lift the customer's pause…" (the shared Lift, F-OP-114). */
  | { readonly kind: 'lift'; readonly workOrderId: string }

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
}

/** The kinds that wait for an answer of a person (a request, a yes, a task) — the rest wait for a record (a payment, a hold …). */
const REQUEST_KINDS: ReadonlySet<string> = new Set(['APPROVAL', 'PARTNER_TASK', 'BRAND_REQUEST', 'YES'])
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
  if (blocker.kind === 'BRAND_REQUEST') {
    if ((blocker.sub === 'REQUEST' || blocker.sub === 'COUNTER') && ref) return { kind: 'answer', requestId: ref.id, request: (inputs.requests ?? []).find((request) => request.id === ref.id) ?? null }
    if (blocker.sub === 'PROBLEM') return { kind: 'reply', messageId: ref?.messageId ?? null }
    return { kind: 'tab', tab: 'production', anchor: 'dates' }
  }
  if (blocker.kind === 'DEPOSIT') return inputs.recordPayment && ref?.type === 'DepositRequest' ? { kind: 'payment', requestId: ref.id } : { kind: 'tab', tab: 'money', anchor: null }
  if (blocker.kind === 'APPROVAL' || blocker.kind === 'PARTNER_TASK') return { kind: 'tab', tab: 'changes', anchor: null }
  // F-OP-116: the customer's pause is lifted in place (a work order the reader does not reach has no ref: Production › holds).
  if (blocker.kind === 'BRAND_PAUSE' && ref?.type === 'WorkOrder') return { kind: 'lift', workOrderId: ref.id }
  if (DATE_KINDS.has(blocker.kind)) return { kind: 'tab', tab: 'production', anchor: 'dates' }
  return { kind: 'tab', tab: 'production', anchor: HOLD_KINDS.has(blocker.kind) ? 'holds' : null }
}

function wordsOf(blocker: Blocker, inputs: WaitingInputs): WaitingWords {
  const api: WaitingWords = { kind: 'api', words: blocker.words }
  if (blocker.kind !== 'BRAND_REQUEST') return api
  const request = blocker.ref ? ((inputs.requests ?? []).find((entry) => entry.id === blocker.ref!.id) ?? null) : null
  // "<Customer> asks: <kind>" — the band notice's own words (band.asks).
  if (blocker.sub === 'REQUEST') return request ? { kind: 'phrase', phrase: phrase('band.asks'), requestKind: request.kind } : api
  if (blocker.sub === 'COUNTER') return request?.counter?.state === 'AGREED' ? { kind: 'phrase', phrase: phrase('waiting.counterAgreed') } : request?.counter?.state === 'LAPSED' ? { kind: 'phrase', phrase: phrase('waiting.counterLapsed') } : api
  if (blocker.sub === 'PROBLEM') return { kind: 'phrase', phrase: phrase('waiting.problem') }
  if (blocker.sub === 'REPROMISE') return { kind: 'phrase', phrase: phrase('waiting.repromise') }
  return api
}

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
  }))
  // An open yes of the order waits on us (an office person decides it): its own row with the yes in place.
  for (const task of inputs.approvals ?? []) {
    rows.push({ key: `YES:${task.taskId}`, kind: 'YES', sub: null, ref: null, on: 'US', since: task.requestedAt, words: { kind: 'phrase', phrase: phrase('waiting.yes', { kind: inputs.locale === 'en' ? task.kindLabel.en : task.kindLabel.it }) }, door: { kind: 'yes', task } })
  }
  // Rows of the same start keep the read's order.
  return rows.map((row, index) => ({ row, index })).sort((a, b) => byOldest(a.row, b.row) || a.index - b.index).map((entry) => entry.row)
}

/** A row's words in the page's language: the API's own, or the phrase with the customer's name and the request's kind in words. */
export function rowWordsOf(row: Pick<WaitingRow, 'words'>, say: { readonly t: (key: string, params?: Record<string, string | number>) => string; readonly kindWords: (kind: string) => string; readonly locale: string; readonly customer: string }): string {
  if (row.words.kind === 'api') return row.words.words[say.locale === 'en' ? 'en' : 'it']
  const { phrase: words, requestKind } = row.words
  return say.t(words.key, { ...(words.params ?? {}), customer: say.customer, ...(requestKind ? { what: say.kindWords(requestKind) } : {}) })
}

/** "Requests & changes": Waiting on us N · Waiting on <Customer> N · Still to do N (top 3) · the latest change; "Nothing waits" only when all three are empty. */
export interface WaitingCard {
  readonly onUs: readonly WaitingRow[]
  readonly onCustomer: readonly WaitingRow[]
  readonly still: readonly StillRowOf[]
  readonly latest: { readonly revision: number; readonly at: string | null } | null
  readonly nothing: boolean
}

export function waitingCardOf(rows: readonly WaitingRow[], read: OrderProduction | null | undefined, order: Pick<Order, 'amendments'>): WaitingCard {
  const onUs = rows.filter((row) => row.on === 'US')
  const onCustomer = rows.filter((row) => row.on === 'BRAND')
  const still = stillRowsOf(read)
  return {
    onUs,
    onCustomer,
    still,
    latest: order.amendments.latestRevision !== null ? { revision: order.amendments.latestRevision, at: order.amendments.latestAt } : null,
    nothing: onUs.length === 0 && onCustomer.length === 0 && still.length === 0,
  }
}

/** R-22: the Changes tab's badge counts the card's own rows (waiting on us, on the customer, still to do) — never a second rule. */
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
 * The ONE call every reader of the waiting list makes — Overview's "Who acts next" and "Requests & changes", the Changes badge and
 * dot, and the Changes tab's "Waiting on us" / "Waiting on the customer" — so they cannot disagree (the walk saw badge 4, Overview
 * 3 + 1, Changes 1 and "Nothing waits on the customer" on one order). While the production read is not in, nothing is claimed
 * (`loading`: never "Nothing waits" before it); a failed read says so. No production read on the page at all (a design case): the
 * order's own open yes only.
 */
export type WaitingState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly rows: readonly WaitingRow[]; readonly card: WaitingCard; readonly next: WhoActsNext }

interface WaitingPage {
  readonly production?: ProductionState | null
  readonly requests?: { readonly value: readonly BrandRequest[] | null } | null
  readonly can: { readonly recordPayment: boolean }
}

export function orderWaitingOf(order: Pick<Order, 'openApprovals' | 'amendments'>, page: WaitingPage, locale: string): WaitingState {
  const state = page.production ?? null
  if (state?.status === 'loading') return { status: 'loading' }
  if (state?.status === 'failed') return { status: 'failed', problem: state.problem }
  const read = readOf(state)
  const rows = waitingOf(read, { requests: page.requests?.value ?? null, approvals: order.openApprovals, recordPayment: page.can.recordPayment, locale })
  const card = waitingCardOf(rows, read, order)
  return { status: 'ready', rows, card, next: whoActsNextOf(rows, read?.headline ?? null, card.still) }
}
// ---- end F-OP-301

// ── end F-SA-233
