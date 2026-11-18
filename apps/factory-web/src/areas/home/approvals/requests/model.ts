import { BATCH_ANSWER_MAX } from '@nexus/factory-domain/production-brand/bulk'
import { HOLD_LIFT_REASON_MAX } from '@nexus/factory-domain/production/holds/kinds'
import { COUNTER_LIMITS } from '@nexus/factory-domain/sales/change-requests/counter'
import { MAX_ANSWER } from '@nexus/factory-domain/sales/change-requests/rules'
import { isApiError, issuePath, type ApiIssue } from '../../../../lib/api/errors'
import type { RequestInput } from '../../../../lib/production/model'
import { productionWordsFor } from '../../../../lib/production/words'
import type { Locale } from '../../../../lib/i18n/locales'
import { minorOf } from '../../../sales/customers/terms/model'
import type { Loaded } from '../../../sales/quotes/record/record-model'
import type { RequestFacts } from '../words/request-words'
import type { AcceptDone, AcceptedWorkOrder, BatchAnswer, BatchItem, BrandRequest, CounterBody, OrderRequestKind, RequestImpactRead, RequestRecord, SalesAccept, Words } from './api'

/**
 * F-PR-08 — a customer's requests in Home › Approvals, without a screen (production plan §3 "Brand asks, we decide: we accept, counter
 * or refuse with words it reads", §5 "Home › Approvals: the one place brand requests are answered (a new 'Brand request' source that
 * opens the review window; a brand's batch shows as one group: accept all or row by row)"; lead picks L4, L26; review fixes R-08,
 * R-23, R-64; wall tests PW-H01, PW-H01b, PW-12). PURE: the container reads, this decides, the view draws.
 *
 *   the source    every request that waits on us and this reader may answer (`waitsForMe`), one row each — a customer's batch
 *                 (one batchId: one customer, one kind) is ONE group row "Cancel · 6 orders" while 2 or more of it wait; a batch
 *                 id met with two customers or two kinds (the database refuses it) is never grouped (PW-12)
 *   the window    `?open=<request id>` or `?open=<batch id>`: the request in the customer's words, the impact read now (frozen,
 *                 priced — the amount only with the price grain —, the earliest date), what accepting does; Accept (RUSH: "Accept
 *                 as urgent" / "Accept and rush the floor"), Suggest something else (a counter), Refuse — each held with its reason
 *                 before the click, Refuse until the words the customer reads are written
 *   a batch       Accept all / Refuse all: the batch is read again first and each request is checked (as Approve N), the current
 *                 ones are answered one by one at the version read; or each order answered alone from the batch's list
 *   after         an accepted pause offers "Lift the hold", a rush of the floor "Clear rush" (R-23: never a generic undo)
 * Words: catalogue `approvals` (`customerRequest.*`), the kinds as the production parts say them (`parts.request.kind.*`).
 */

export const CR = 'customerRequest'

/** The inbox's kind of every customer request (Today's ORDER_CHANGE_REQUEST; the Overview tile opens `?kind=` with it). */
export const REQUEST_INBOX_KIND = 'ORDER_CHANGE_REQUEST'

export const REQUEST_LIMITS = Object.freeze({ answer: MAX_ANSWER, note: COUNTER_LIMITS.note, fee: COUNTER_LIMITS.fee, batch: BATCH_ANSWER_MAX, lift: HOLD_LIFT_REASON_MAX })

/** It waits on us and this reader may answer it now: the inbox's "Waiting for me". */
export const waitsForMe = (request: Pick<BrandRequest, 'waitingOn' | 'may'>): boolean => request.waitingOn === 'US' && (request.may.accept || request.may.refuse || request.may.counter)

// ---- the source: one row per request, one per batch -----------------------------------------------------------------------------

export interface RequestGroup {
  /** What `?open=` names: the request's id, or the batch's id for a group of 2 or more. */
  readonly openId: string
  /** The batch (one customer, one kind) of a group of 2 or more; null for a request alone. */
  readonly batchId: string | null
  /** Its requests waiting for this reader, oldest first. */
  readonly requests: readonly BrandRequest[]
}

export const leadOf = (group: RequestGroup): BrandRequest => group.requests[0]!
export const isBatchGroup = (group: RequestGroup): boolean => group.batchId !== null && group.requests.length > 1

const oldestFirst = (a: Pick<BrandRequest, 'askedAt' | 'id'>, b: Pick<BrandRequest, 'askedAt' | 'id'>): number => a.askedAt.localeCompare(b.askedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The inbox rows of the requests read: those waiting for this reader, oldest first; the waiting requests of one batch together (2 or
 * more) as one group named by the batch. A batch is grouped only when every request of it names one customer and one kind (PW-12:
 * a group never spans two customers — the database already refuses it; here a mixed batch id is listed request by request).
 */
export function requestGroupsOf(requests: readonly BrandRequest[]): RequestGroup[] {
  const waiting = requests.filter(waitsForMe).sort(oldestFirst)
  const members = new Map<string, BrandRequest[]>()
  const shapes = new Map<string, Set<string>>()
  for (const request of waiting) {
    if (!request.batchId) continue
    members.set(request.batchId, [...(members.get(request.batchId) ?? []), request])
    shapes.set(request.batchId, (shapes.get(request.batchId) ?? new Set<string>()).add(`${request.party.id}|${request.kind}`))
  }
  const groups: RequestGroup[] = []
  const told = new Set<string>()
  for (const request of waiting) {
    const batch = request.batchId
    const together = batch !== null && (members.get(batch)?.length ?? 0) > 1 && shapes.get(batch)?.size === 1
    if (!together) {
      groups.push({ openId: request.id, batchId: null, requests: [request] })
      continue
    }
    if (told.has(batch)) continue
    told.add(batch)
    groups.push({ openId: batch, batchId: batch, requests: members.get(batch)! })
  }
  return groups
}

/** The requests of a group the address names: the group's own, or one request of it (`?open=<request id>` of a batch's order). */
export const namesGroup = (group: RequestGroup, openId: string): 'batch' | 'request' | null => (group.openId === openId ? (isBatchGroup(group) ? 'batch' : 'request') : group.requests.some((request) => request.id === openId) ? 'request' : null)

// ---- held with the reason before the click ------------------------------------------------------------------------------------

export type RequestAnswer = 'accept' | 'refuse' | 'counter'

const TEAMS: Readonly<Record<string, string>> = Object.freeze({ 'orders.manage': 'sales', 'production.brand.manage': 'production', 'sales.samples.manage': 'samples' })

/** Who answers a kind, in words (`customerRequest.team.<team>`): Sales, production's manager or planner, sampling. */
export const teamOf = (answeredWith: string): string => TEAMS[answeredWith] ?? 'other'

/**
 * Why this reader may not answer the request this way now (a `customerRequest.held.` key), or null. In order: withdrawn, answered,
 * our counter-offer waits on the customer, another team answers its kind, the answer its state does not take (a lapsed counter is
 * only refused, an agreed one only accepted, a resume never countered, a request countered once), the words a refusal needs, too
 * long, offline, busy. `words` are the words the customer reads (a refusal needs them; an accept may carry them).
 */
export function answerHeld(request: BrandRequest, answer: RequestAnswer, state: { readonly offline: boolean; readonly busy: boolean }, words: string): string | null {
  if (request.status === 'WITHDRAWN') return `${CR}.held.withdrawn`
  if (request.status === 'ACCEPTED' || request.status === 'REFUSED') return `${CR}.held.answered`
  if (request.waitingOn === 'CUSTOMER') return `${CR}.held.waitsOnCustomer`
  if (!(request.may.accept || request.may.refuse || request.may.counter)) return `${CR}.held.team.${teamOf(request.answeredWith)}`
  if (answer === 'accept' && !request.may.accept) return request.counter?.state === 'LAPSED' ? `${CR}.held.counterLapsed` : `${CR}.held.noAccept`
  if (answer === 'refuse' && !request.may.refuse) return request.counter?.state === 'AGREED' ? `${CR}.held.counterAgreed` : `${CR}.held.noRefuse`
  if (answer === 'counter' && !request.may.counter) return request.kind === 'RESUME' ? `${CR}.held.noCounterResume` : request.counter ? `${CR}.held.counteredOnce` : `${CR}.held.noCounter`
  const typed = words.trim()
  if (answer === 'refuse' && typed === '') return `${CR}.held.words`
  if (answer !== 'counter' && typed.length > MAX_ANSWER) return `${CR}.held.long`
  if (state.offline) return `${CR}.held.offline`
  if (state.busy) return `${CR}.held.busy`
  return null
}

/** "Urgent – asked" has two accepts (R-64): as urgent (it moves among that customer's own orders) and rush the floor too. */
export const hasTwoAccepts = (request: Pick<BrandRequest, 'kind'>): boolean => request.kind === 'RUSH'

// ---- Suggest something else (a counter-offer) ---------------------------------------------------------------------------------

export interface CounterDraft {
  /** The date we offer (`YYYY-MM-DD`, from today on), or ''. */
  readonly date: string
  /** A fee typed in the order's currency ("25", "12,50"), only with the price grain; or ''. */
  readonly fee: string
  /** Our words to the customer. */
  readonly note: string
}

export const EMPTY_COUNTER: CounterDraft = Object.freeze({ date: '', fee: '', note: '' })

/** Why Send waits (a `customerRequest.counter.held.` key), or null: at least one of date, fee (price grain only), words. */
export function counterHeld(draft: CounterDraft, options: { readonly withPrice: boolean; readonly today: string }): string | null {
  const date = draft.date.trim()
  const fee = options.withPrice ? draft.fee.trim() : ''
  const note = draft.note.trim()
  if (date === '' && fee === '' && note === '') return `${CR}.counter.held.empty`
  if (date !== '' && date < options.today) return `${CR}.counter.held.past`
  if (fee !== '') {
    const minor = minorOf(fee)
    if (minor === null || minor < 0 || minor > COUNTER_LIMITS.fee) return `${CR}.counter.held.fee`
  }
  if (note.length > COUNTER_LIMITS.note) return `${CR}.counter.held.long`
  return null
}

/** The counter's body: the fee only from a reader with the price grain (a money field sent without it is refused). */
export function counterBodyOf(draft: CounterDraft, version: number, withPrice: boolean): CounterBody {
  const fee = withPrice && draft.fee.trim() !== '' ? minorOf(draft.fee.trim()) : null
  return { version, date: draft.date.trim() || null, note: draft.note.trim() || null, ...(fee !== null ? { fee } : {}) }
}

// ---- after an accept: what it did, and the follow-up (R-23) -----------------------------------------------------------------------

/** "Lift the hold" after an accepted pause, "Clear rush" after Accept and rush the floor: the work orders it acts on. */
export interface FollowUp {
  readonly kind: 'lift' | 'clearRush'
  readonly requestId: string
  readonly workOrders: readonly Pick<AcceptedWorkOrder, 'id' | 'number'>[]
}

/**
 * The follow-up an accept offers instead of a generic undo: the pause's holds on every work order it paused (one held already keeps
 * its other hold), the rush only where this accept set it (one rushed before stays rushed). Nothing to act on: none.
 */
export function followUpOf(requestId: string, done: Pick<AcceptDone, 'kind' | 'paused' | 'rushed'>): FollowUp | null {
  if (done.kind === 'HOLD' && done.paused.length > 0) return { kind: 'lift', requestId, workOrders: done.paused.map(({ id, number }) => ({ id, number })) }
  const rushed = done.kind === 'RUSH' ? done.rushed.filter((workOrder) => workOrder.changed) : []
  return rushed.length > 0 ? { kind: 'clearRush', requestId, workOrders: rushed.map(({ id, number }) => ({ id, number })) } : null
}

/** Every sentence an accept answered, in order: what it did, then what it says beside (urgent use, a rush left alone, re-promises). */
export function doneWordsOf(done: AcceptDone | SalesAccept): Words[] {
  if ('kind' in done) return [done.words, ...(done.urgency ? [done.urgency.use.words] : []), ...(done.rushSkipped ? [done.rushSkipped] : []), ...(done.repromise?.skipped.map((line) => line.words) ?? [])]
  return done.split ? [done.split.words, ...done.split.skipped.map((line) => line.words)] : []
}

/** Lift the hold: why, in one line (the office's own: the customer reads that the work goes on). */
export function liftHeld(reason: string, busy: boolean): string | null {
  const text = reason.trim()
  if (text === '') return `${CR}.lift.held.reason`
  if (text.length > HOLD_LIFT_REASON_MAX || /[\r\n]/.test(text)) return `${CR}.lift.held.long`
  return busy ? `${CR}.held.busy` : null
}

// ---- a batch: each request checked again, the current ones answered ---------------------------------------------------------------

/** One request of a batch as read again before Accept all / Refuse all: current (answered with the others) or left out with why. */
export interface BatchLine {
  readonly requestId: string
  readonly orderId: string
  readonly orderNumber: string
  readonly customerRef: string | null
  readonly version: number
  /** null: still current; else why it is left out (a `customerRequest.held.` key). */
  readonly leftOut: string | null
}

/**
 * The batch's requests as read now, each checked as the answer asks (its state, this reader's right, a counter's state): the order
 * of the read kept. The words are checked once for all (the dialog's own field), never per line. At most the API's batch limit.
 */
export function batchLinesOf(now: readonly BrandRequest[], answer: 'accept' | 'refuse'): BatchLine[] {
  return [...now]
    .sort(oldestFirst)
    .slice(0, BATCH_ANSWER_MAX)
    .map((request) => ({ requestId: request.id, orderId: request.orderId, orderNumber: request.orderNumber, customerRef: request.customerRef, version: request.version, leftOut: answerHeld(request, answer, { offline: false, busy: false }, 'words') }))
}

export const batchItemsOf = (lines: readonly BatchLine[]): BatchItem[] => lines.filter((line) => line.leftOut === null).map((line) => ({ requestId: line.requestId, version: line.version }))

/** What became of one request of the batch: done (its words) or not (the refusal's code, said by `refusalKeyOf`). */
export interface BatchResult {
  readonly ok: boolean
  readonly words: Words | null
  readonly code: string | null
}

export function batchResultsOf(answer: Pick<BatchAnswer, 'results'>): Record<string, BatchResult> {
  return Object.fromEntries(answer.results.map((result) => [result.requestId, { ok: result.done, words: result.words, code: result.done ? null : (result.problem?.code ?? 'other') }]))
}

/**
 * "Nothing was answered" (409): each request's refusal comes back as an issue `body/items/<index>/<code>` — read back onto the
 * requests sent (by their place in `items`); none of that shape: null (a refusal of the whole call, said as one problem).
 */
export function batchRefusalsOf(error: unknown, items: readonly BatchItem[]): Record<string, BatchResult> | null {
  if (!isApiError(error)) return null
  const found: Record<string, BatchResult> = {}
  for (const issue of error.issues) {
    const match = /^body\/items\/(\d+)\/(.+)$/.exec(issuePath(issue))
    const item = match ? items[Number(match[1])] : undefined
    if (item) found[item.requestId] = { ok: false, words: null, code: match![2]!.split('/').at(-1)! }
  }
  return Object.keys(found).length > 0 ? found : null
}

// ---- refusals in words ---------------------------------------------------------------------------------------------------------

/** The refusals this page says itself (`customerRequest.refusal.<code>`); another reads as a generic refusal. */
export const KNOWN_REQUEST_REFUSALS: ReadonlySet<string> = new Set([
  'NO_WORK',
  'MIXED',
  'SHARED',
  'NOTHING_TO_RUSH',
  'NO_LINE',
  'SALES_ASK',
  'PRODUCTION_ASK',
  'RESUME',
  'WITHDRAWN',
  'ACCEPTED',
  'REFUSED',
  'COUNTER_WAITING',
  'COUNTER_AGREED',
  'COUNTER_REFUSED',
  'COUNTER_LAPSED',
  'COLOUR_IN_WORK',
  'ADDRESS_GONE',
  'SHIPMENT_PREPARED',
  'NOT_KEPT',
  'NOT_OPEN',
  'URGENCY_OFF',
  'LOCKED',
])

/** A refusal's code from the API's issues: `request/<CODE>` (its last part: `request/shipToAddressId/ADDRESS_GONE`), else null. */
export function requestRefusalOf(issues: readonly ApiIssue[] | undefined): string | null {
  for (const issue of issues ?? []) {
    const path = issuePath(issue)
    if (path.startsWith('request/')) return path.split('/').at(-1) ?? null
  }
  return null
}

/** A refusal code in this page's words (a key of `customerRequest.refusal.`). */
export const refusalKeyOf = (code: string | null): string => (code && KNOWN_REQUEST_REFUSALS.has(code) ? `${CR}.refusal.${code}` : `${CR}.refusal.other`)

/** An answer's failure as a key of this page, and whether the inbox and the window read again. */
export function answerProblem(error: unknown): { readonly key: string; readonly reload: boolean } {
  if (!isApiError(error)) return { key: `${CR}.problem.internal`, reload: false }
  const code = requestRefusalOf(error.issues)
  if (code) return { key: refusalKeyOf(code), reload: true }
  switch (error.kind) {
    case 'conflict':
      return { key: `${CR}.refusal.moved`, reload: true }
    case 'not_found':
      return { key: `${CR}.refusal.gone`, reload: true }
    case 'forbidden':
    case 'invalid':
    case 'unavailable':
    case 'rate_limited':
    case 'signed_out':
      return { key: `${CR}.problem.${error.kind}`, reload: false }
    default:
      return { key: `${CR}.problem.internal`, reload: false }
  }
}

// ---- words of a request ---------------------------------------------------------------------------------------------------------

/** A kind as the production parts say it ("Urgent – asked", "Pause"), in both languages (a notice's `{request}`). */
export const kindWordsOf = (kind: OrderRequestKind): Words => ({ en: productionWordsFor('en')(`parts.request.kind.${kind}`), it: productionWordsFor('it')(`parts.request.kind.${kind}`) })

/** The request in words for the inbox's notice: its kind and its order's number (never a customer's name in a sentence of ours). */
export const noticeFactsOf = (request: Pick<BrandRequest, 'kind' | 'orderId' | 'orderNumber'>): RequestFacts => ({ kindLabel: kindWordsOf(request.kind), record: { type: 'SalesOrder', id: request.orderId, label: request.orderNumber } })

/** A batch in the notice: its kind (the count goes in the words). */
export const batchFactsOf = (request: Pick<BrandRequest, 'kind' | 'batchId'>): RequestFacts => ({ kindLabel: kindWordsOf(request.kind), record: { type: 'OrderChangeRequest', id: request.batchId ?? '', label: null } })

export const said = (words: Words | null | undefined, locale: Locale): string => (words ? (locale === 'it' ? words.it : words.en) : '')

type Say = (key: string, params?: Record<string, string | number>) => string

/**
 * The request as the shared request card draws it (F-PR-01 RequestCard, office face): what it changes old → new — each size asked
 * (pieces, a colourway), the date (a change's wish, a rush's need-by date, the first part of ship what is ready), the delivery
 * address, a whole-order cancel, the kind of sample round —, the customer's words, the impact read now (else the one kept at Send:
 * frozen, the earliest date, priced — the amount only when the API sent the fee, i.e. with the price grain), our answer.
 */
export function cardInputOf(request: BrandRequest, impact: Pick<RequestImpactRead, 'now' | 'cancelFee'> | null, words: { readonly say: Say; readonly locale: Locale; readonly day: (value: string) => string; readonly money: (minor: number, currency: string) => string }): RequestInput {
  const { say, locale, day } = words
  const changes: { id: string; label: string; from: string; to: string }[] = request.cells.map((cell) => ({
    id: `${cell.lineId}:${cell.size ?? ''}`,
    label: say(`${CR}.change.cell`, { line: cell.seq, style: [cell.style?.code, cell.colourway?.code].filter(Boolean).join(' · ') || '—', size: cell.size ?? say(`${CR}.change.wholeLine`) }),
    from: String(cell.before),
    to: cell.askedColourway ? say(`${CR}.change.inColour`, { pieces: cell.asked, colour: cell.askedColourway.name }) : String(cell.asked),
  }))
  if (request.kind === 'CANCEL' && request.wholeOrder) changes.push({ id: 'whole', label: say(`${CR}.change.wholeOrder`), from: say(`${CR}.change.open`), to: say(`${CR}.change.cancelled`) })
  if (request.requestedDate) changes.push({ id: 'date', label: say(request.kind === 'RUSH' ? `${CR}.change.neededBy` : request.kind === 'SPLIT_SHIPMENT' ? `${CR}.change.firstPart` : `${CR}.change.date`), from: '—', to: day(request.requestedDate) })
  if (request.shipTo) changes.push({ id: 'shipTo', label: say(`${CR}.change.shipTo`), from: '—', to: request.shipTo.label })
  if (request.sampleKind) changes.push({ id: 'sample', label: say(`${CR}.change.sample`), from: '—', to: say(`${CR}.sample.${request.sampleKind}`) })
  const read = impact?.now ?? request.impact
  const fee = impact?.cancelFee ?? request.cancelFee
  const priceText = fee && typeof fee.totalFee === 'number' ? words.money(fee.totalFee, fee.currency) : null
  return {
    id: request.id,
    kind: request.kind,
    state: request.status,
    askedAt: request.askedAt,
    askedBy: request.askedBy,
    changes,
    note: request.note,
    impact: read
      ? {
          frozen: read.frozen.map((entry) => said(entry.words, locale)),
          earliest: read.earliest?.date ? { best: read.earliest.date } : null,
          price: priceText ? 'PRICED' : read.priced ? 'MAY_APPLY' : 'NONE',
          priceText,
        }
      : null,
    answer: request.answeredAt ? { at: request.answeredAt, by: request.answeredBy, words: request.answer } : null,
  }
}

// ---- the window's model --------------------------------------------------------------------------------------------------------

/** The window's dialogs: Suggest something else, and a batch's Accept all / Refuse all (each re-read first). */
export type BatchPhase = { readonly phase: 'reading' } | { readonly phase: 'ready' } | { readonly phase: 'saving' } | { readonly phase: 'done'; readonly results: Readonly<Record<string, BatchResult>> } | { readonly phase: 'failed'; readonly problem: string }

export type RequestDialog =
  | { readonly kind: 'counter'; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'batch'; readonly answer: 'accept' | 'refuse'; readonly rushFloor: boolean; readonly lines: readonly BatchLine[] | null; readonly state: BatchPhase }

interface ReviewCommon {
  /** What `?open=` names. */
  readonly id: string
  /** The words the customer reads (one field for Accept, Refuse and a batch's answers). */
  readonly words: string
  readonly dialog: RequestDialog | null
  /** A problem of the last answer (a key of this page), shown in the window. */
  readonly problem: string | null
  /** The order pages, by order id (with the company prefix). */
  readonly orderHrefs: Readonly<Record<string, string>>
  /** Today, the counter's first date (`YYYY-MM-DD`). */
  readonly today: string
  /** The follow-ups this reader may do: lift a customer's pause (workorders.hold). */
  readonly can: { readonly lift: boolean }
}

export type RequestReviewModel =
  | (ReviewCommon & { readonly as: 'request'; readonly record: Loaded<RequestRecord>; readonly impact: Loaded<RequestImpactRead> })
  | (ReviewCommon & { readonly as: 'batch'; readonly batch: Loaded<readonly BrandRequest[]> })

/** The window's actions (the container's; a design case passes none). */
export interface RequestActions {
  onWords?: (words: string) => void
  /** Accept the open request (RUSH: `rushFloor` true = "Accept and rush the floor"). */
  onAccept?: (rushFloor: boolean) => void
  onRefuse?: () => void
  /** Suggest something else: open the counter dialog, then send it. */
  onCounter?: () => void
  onCounterSend?: (draft: CounterDraft) => void
  /** A batch: Accept all / Refuse all (each re-read first), then confirm the current ones. */
  onBatch?: (answer: 'accept' | 'refuse', rushFloor: boolean) => void
  onBatchConfirm?: () => void
  onCloseDialog?: () => void
  onRetry?: () => void
  /** An accepted pause opened later: Lift the hold (the follow-up dialog). */
  onLift?: (followUp: FollowUp) => void
}

/** An accepted pause opened later: its work orders still held (from the impact read), for "Lift the hold". */
export function heldFollowUpOf(request: Pick<BrandRequest, 'id' | 'kind' | 'status'>, impact: Pick<RequestImpactRead, 'workOrders'> | null): FollowUp | null {
  if (request.kind !== 'HOLD' || request.status !== 'ACCEPTED' || !impact) return null
  const held = impact.workOrders.filter((workOrder) => workOrder.held)
  return held.length > 0 ? { kind: 'lift', requestId: request.id, workOrders: held.map(({ id, number }) => ({ id, number })) } : null
}
