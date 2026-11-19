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
// F-SA-241 / F-SA-242: the apply plan, the extra pieces' outcomes, the design change's own-collection hold.
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'
import { DESIGN_HELD_WORDS } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import type { ApplyPlan, ApplyPlanStep } from './api'

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
  // F-SA-240 (sa-5's B-SA-042): a colourway change is held only once something of the line is CUT (request/COLOUR_CUT; the old
  // COLOUR_IN_WORK is no longer said), and an accept that leaves pieces cut beyond the new figure needs their outcome
  // (refusal/EXTRA_OUTCOME, the work-order change's own refusal raised inside the accept).
  'COLOUR_CUT',
  'EXTRA_OUTCOME',
  'ADDRESS_GONE',
  'SHIPMENT_PREPARED',
  'NOT_KEPT',
  'NOT_OPEN',
  'URGENCY_OFF',
  'LOCKED',
])

/** A refusal's code from the API's issues: `request/<CODE>` (its last part: `request/shipToAddressId/ADDRESS_GONE`), else null. */
// F-SA-240: also `refusal/<CODE>` — a refusal of the work-order change an accept proposes in the same command (EXTRA_OUTCOME).
export function requestRefusalOf(issues: readonly ApiIssue[] | undefined): string | null {
  for (const issue of issues ?? []) {
    const path = issuePath(issue)
    if (path.startsWith('request/') || path.startsWith('refusal/')) return path.split('/').at(-1) ?? null
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
  | (ReviewCommon & {
      readonly as: 'request'
      readonly record: Loaded<RequestRecord>
      readonly impact: Loaded<RequestImpactRead>
      // F-SA-241 (14-change-flow §3.2, §3.4): the apply plan (On the floor now, Extra pieces, What happens next), the choices made in
      // the window before Accept, and after it the "Done · What happens next" view. F-SA-242: the "Also write it in the order's
      // conversation" tick. Optional: a design case or an older host draws today's window.
      readonly plan?: Loaded<ApplyPlan>
      readonly choices?: ApplyChoices
      readonly tell?: TellTick
      readonly done?: DoneView | null
    })
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
  // ---- F-SA-241: the choices before Accept, the steps after it ----
  /** Extra pieces: the outcome picked (none is picked for the reader, Round 4). */
  onExtraOutcome?: (outcome: ExtraOutcome) => void
  /** A touched work order with bundles in work: Finish what is started (default) or Stop now. */
  onWorkChoice?: (workOrderId: string, choice: WorkChoice) => void
  /** After Accept: one step's own command, or "Do the next steps" (one after another, stopping at the first refusal). */
  onRunStep?: (key: string) => void
  onRunAll?: () => void
  /** After Accept: Close (a door) or Next request › (Home › Approvals). */
  onDoneClose?: () => void
  // ---- F-SA-242: the conversation ----
  /** "Also write it in the order's conversation" ticked or not. */
  onTell?: (on: boolean) => void
  /** After Accept: "Tell the customer…" — the words written in the order's conversation (the thread's own send). */
  onTellOpen?: () => void
  onTellWords?: (words: string) => void
  onTellSend?: () => void
  onTellClose?: () => void
}

/** An accepted pause opened later: its work orders still held (from the impact read), for "Lift the hold". */
export function heldFollowUpOf(request: Pick<BrandRequest, 'id' | 'kind' | 'status'>, impact: Pick<RequestImpactRead, 'workOrders'> | null): FollowUp | null {
  if (request.kind !== 'HOLD' || request.status !== 'ACCEPTED' || !impact) return null
  const held = impact.workOrders.filter((workOrder) => workOrder.held)
  return held.length > 0 ? { kind: 'lift', requestId: request.id, workOrders: held.map(({ id, number }) => ({ id, number })) } : null
}

// ---- F-SA-240 (sales page plan P5, P24; 14-change-flow §3.1): the doors of the ONE review window ------------------------------------
/**
 * The window opens from four doors — Home › Approvals (its inbox rows), the order page (its waiting requests: band notice,
 * Overview, Changes), the order's thread (the ask's card) and the customer's Work tab (its requests) —, each by the same address
 * word on its own page (`?open=<id>`; the order page `?tab=changes&open=<id>`, the Work tab `?tab=work&open=<id>`), and the ‹ ›
 * arrows walk the door's own list. Approvals keeps its own host (Approvals.tsx); the other doors use use-request-review-door.ts.
 */

/** The address word that opens the window on a door's page. */
export const DOOR_PARAM = 'open'

/** A door's list: the ids it shows in its order (a request alone, or a customer's batch), the batches named among them. */
export interface RequestDoorList {
  readonly ids: readonly string[]
  readonly batches?: readonly string[] | undefined
}

/** The door's list of a set of requests (the order's, the customer's): those waiting for this reader, a batch of 2+ as one entry. */
export function doorListOf(requests: readonly BrandRequest[]): { readonly ids: string[]; readonly batches: string[] } {
  const groups = requestGroupsOf(requests)
  return { ids: groups.map((group) => group.openId), batches: groups.filter(isBatchGroup).map((group) => group.openId) }
}

/** What an id the address names opens as when the door lists it (a batch it names as one); null: not listed (asked of the API). */
export function doorTargetOf(list: RequestDoorList, id: string): 'request' | 'batch' | null {
  if (list.batches?.includes(id)) return 'batch'
  return list.ids.includes(id) ? 'request' : null
}

/**
 * The door page's address with the window opened on `id` (null: closed): every other word kept (its tab, its scroll stays —
 * the host replaces the address without scrolling), so Esc / Close returns to the same tab. `search` is the page's own query.
 */
export function doorAddress(search: string, id: string | null, param: string = DOOR_PARAM): string {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (id) query.set(param, id)
  else query.delete(param)
  const text = query.toString()
  return text ? `?${text}` : ''
}
// ---- end F-SA-240

// ---- F-SA-241 (sales page plan P5, P6', R1, R8; 14-change-flow §3.2 items 4 and 6, §3.4; lead picks Round 4; review R-6) -----------
/**
 * The window's new parts, for every door, from the apply plan (B-SA-045, `GET /sales/change-requests/:id/apply-plan`):
 *
 *   On the floor now   the order's OWN cells per asked size (ordered · asked · in work orders · cut · sewn · packed; "not counted here"
 *                      where a site does not count a step, never 0) and "In work now: 3 bundles at Sewing" — workorders.view, else "—"
 *                      and "Needs work-order access"
 *   Extra pieces       pieces already cut beyond the new figure, and ONE required choice: Keep and charge the customer (the priced
 *                      change Accept makes) · Keep as leftover for <customer> (recorded on the work-order change) · Scrap (the scrap's
 *                      own approval) — each held with why when its right or grain is missing; none is picked (Round 4), and Accept
 *                      stays held "Choose what happens to the N extra pieces" until one is (R-6: every outcome is a real command)
 *   What happens next  the plan's numbered steps, who does each, its state in words; per touched work order with bundles in work
 *                      the choice Finish what is started (default) / Stop now (a production hold on it, after Accept)
 *   Done · What        after Accept the window stays open: what the Accept did, then each next step with its own command and its own
 *   happens next       Idempotency-Key (Stop now's hold, "Change the work order now"); "Do the next steps" runs them one after another
 *                      and stops at the first refusal (nothing rolled back silently); Close (a door) or Next request › (Approvals)
 */

export type WorkChoice = 'FINISH' | 'STOP'

/** The choices made in the window before Accept. */
export interface ApplyChoices {
  /** The extra pieces' outcome (null: none picked yet). */
  readonly extraOutcome: ExtraOutcome | null
  /** The work orders to stop now (a production hold right after Accept); the others finish what is started. */
  readonly stops: readonly string[]
}

export const NO_CHOICES: ApplyChoices = Object.freeze({ extraOutcome: null, stops: [] })

const WORK_KINDS: ReadonlySet<string> = new Set(['LOWER_TO_ORDER', 'MAKE_MORE'])

/** A step the reader may stop now: a work order it reaches whose bundles of the step's cells are in work, before Accept. */
export const stoppable = (step: Pick<ApplyPlanStep, 'kind' | 'workOrder' | 'bundles'>): boolean => WORK_KINDS.has(step.kind) && step.workOrder !== null && (step.bundles ?? 0) > 0

/** The touched work orders that offer Finish what is started / Stop now (once each, in the plan's order). */
export function stoppableOf(plan: Pick<ApplyPlan, 'next'> | null): { readonly id: string; readonly number: string; readonly bundles: number }[] {
  const seen = new Set<string>()
  const out: { id: string; number: string; bundles: number }[] = []
  for (const step of plan?.next ?? []) {
    if (!stoppable(step) || seen.has(step.workOrder!.id)) continue
    seen.add(step.workOrder!.id)
    out.push({ id: step.workOrder!.id, number: step.workOrder!.number, bundles: step.bundles ?? 0 })
  }
  return out
}

/** The window's words for a choice the plan holds (said once in the window and on the held Accept). */
export type PlanHeld = { readonly words: Words } | { readonly key: string; readonly params?: Record<string, string | number> }

/**
 * Why Accept waits on the plan, before the click, in order: the change cannot be carried out as it stands (the record's preview — a
 * colourway "Already cut in Black: 40 pieces. Suggest something else or refuse." (F-SA-242), a design change of our own collection
 * (F-SA-242)), then the extra pieces' outcome not chosen (Round 4), then an outcome chosen that this reader may not choose (charging
 * needs the price grain). Null: the plan holds nothing (answerHeld's own reasons still apply).
 */
export function planHeld(plan: ApplyPlan | null | undefined, choices: ApplyChoices = NO_CHOICES): PlanHeld | null {
  if (!plan) return null
  const amend = plan.next.find((step) => step.kind === 'AMEND')
  if (amend?.state === 'NOT_POSSIBLE' && amend.why) return { words: amend.why }
  const style = plan.next.find((step) => step.kind === 'STYLE_CHANGE' && step.state === 'NOT_POSSIBLE' && step.why !== null)
  if (style?.why) return { words: style.why }
  if (plan.extra.needsOutcome && choices.extraOutcome === null) return plan.extra.words ? { words: plan.extra.words } : { key: `${CR}.extra.choose`, params: { count: plan.extra.total } }
  const option = choices.extraOutcome ? plan.extra.outcomes.find((entry) => entry.outcome === choices.extraOutcome) : undefined
  if (option && !option.mayChoose) return option.needsWords ? { words: option.needsWords } : { key: `${CR}.extra.notYours` }
  return null
}

/** Why one outcome of the extra pieces cannot be picked by this reader (held, never hidden): its needs in words; null: it may. */
export const outcomeHeld = (option: Pick<ApplyPlan['extra']['outcomes'][number], 'mayChoose' | 'needsWords'>): Words | null => (option.mayChoose ? null : (option.needsWords ?? { en: 'Not yours to choose.', it: 'Non spetta a te sceglierlo.' }))

/**
 * F-SA-242 (R3): a design change of a style that is not this customer's own label is held — Suggest something else or Refuse; the
 * line's Options… only while no work order makes it (the domain's words carry the options' hint exactly then).
 */
export function designOptionsOffered(plan: Pick<ApplyPlan, 'next' | 'request'> | null | undefined): boolean {
  if (!plan || plan.request.kind !== 'DESIGN') return false
  return plan.next.some((step) => step.kind === 'STYLE_CHANGE' && step.state === 'NOT_POSSIBLE' && (step.why?.en ?? '').includes(DESIGN_HELD_WORDS.options.en))
}

// ---- the state of a step, in words (one word list for the window and the order's "Still to do", F-SA-243) ----

export type StepStateWord = 'thisAccept' | 'afterAccept' | 'done' | 'yourTurn' | 'waiting' | 'needsDecision' | 'leftAsIs' | 'notPossible'

export interface StepState {
  /** A key of `customerRequest.next.state.` (with its team for `waiting`). */
  readonly key: string
  readonly word: StepStateWord
  readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

const stateOf = (word: StepStateWord, team?: string): StepState => ({
  key: word === 'waiting' ? `${CR}.next.state.waiting.${team ?? 'PLANNER'}` : `${CR}.next.state.${word}`,
  word,
  tone: word === 'done' || word === 'thisAccept' ? 'success' : word === 'yourTurn' || word === 'needsDecision' ? 'warning' : word === 'notPossible' ? 'danger' : 'neutral',
})

/**
 * A step of the plan in words: before Accept "This Accept" (what the Accept itself does) or "After Accept"; after it Done, Your turn
 * (the reader may act on it now), Waiting for planning / product / finance / the customer / sales, Left as is, Not possible.
 */
export function stepStateOf(step: Pick<ApplyPlanStep, 'kind' | 'state' | 'team' | 'mayDoNow'>, accepted: boolean): StepState {
  switch (step.state) {
    case 'DONE':
      return stateOf('done')
    case 'LEFT_AS_IS':
      return stateOf('leftAsIs')
    case 'NOT_POSSIBLE':
      return stateOf('notPossible')
    case 'PROPOSED':
      return step.mayDoNow ? stateOf('yourTurn') : stateOf('waiting', step.team)
    case 'TO_DO':
      if (!accepted) return step.kind === 'AMEND' || step.kind === 'STYLE_CHANGE' ? stateOf('thisAccept') : stateOf('afterAccept')
      return step.mayDoNow ? stateOf('yourTurn') : stateOf('waiting', step.team)
  }
}

/** A "Still to do" row of the order (B-SA-050) in the same words: a decision on pieces or work in progress, your turn, or waiting. */
export function stillStateOf(row: { readonly kind: string; readonly waitingOn: string; readonly mayAct: boolean }): StepState {
  if (row.mayAct && (row.kind === 'EXTRA_PIECES' || row.kind === 'WORK_IN_PROGRESS_TASK')) return stateOf('needsDecision')
  if (row.mayAct) return stateOf('yourTurn')
  return stateOf('waiting', row.waitingOn)
}

// ---- after Accept: Done · What happens next ----

/** One next step's own command (each its own Idempotency-Key): Stop now's production hold, or carrying out a work-order change. */
export type DoneCommand =
  | { readonly key: string; readonly kind: 'stop'; readonly workOrder: { readonly id: string; readonly number: string } }
  | { readonly key: string; readonly kind: 'apply'; readonly changeId: string; readonly workOrder: { readonly id: string; readonly number: string } | null; readonly words: Words }

export type CommandState =
  | { readonly phase: 'todo' }
  | { readonly phase: 'running' }
  | { readonly phase: 'done' }
  /** Refused: its own words (a key of `approvals` and its params). */
  | { readonly phase: 'refused'; readonly key: string; readonly params?: Record<string, string | number> }

/**
 * The commands of the done view, in order: each work-order change this reader may carry out now ("Change the work order now": no
 * proposal is approved by its own proposer — the reader holds workorders.manage over it, rule 42), then the work orders chosen to stop
 * now. F-OP-116 (B1): the applies run first and the stops after — a hold placed first would make the work order refuse its own change
 * (ON_HOLD). R-17: a change Accept already carried out in its own command (its answer's `workOrders.applied[]`) is never applied again.
 * A command done or refused keeps its place.
 */
export function doneCommandsOf(plan: Pick<ApplyPlan, 'next'> | null, stops: readonly { readonly id: string; readonly number: string }[], applied: readonly string[] = []): DoneCommand[] {
  const done = new Set(applied)
  const out: DoneCommand[] = []
  for (const step of plan?.next ?? []) {
    if (!WORK_KINDS.has(step.kind) || step.state !== 'PROPOSED' || !step.mayDoNow || step.ref?.type !== 'WorkOrderChange' || done.has(step.ref.id)) continue
    out.push({ key: `apply:${step.ref.id}`, kind: 'apply', changeId: step.ref.id, workOrder: step.workOrder, words: step.words })
  }
  for (const workOrder of stops) out.push({ key: `stop:${workOrder.id}`, kind: 'stop', workOrder: { id: workOrder.id, number: workOrder.number } })
  return out
}

/**
 * F-OP-116 (B1): what runs at once after Accept — the stops chosen ("Stop now"), unless a change is still to be carried out by this
 * reader: then nothing runs by itself (no change is applied without its click) and "Do the next steps" runs the applies first, the
 * stops after. With auto-apply on (R-17) Accept carried the changes out already, so the stops go at once.
 */
export function atAcceptOf(commands: readonly DoneCommand[]): DoneCommand[] {
  if (commands.some((command) => command.kind === 'apply')) return []
  return commands.filter((command) => command.kind === 'stop')
}

/** The commands still to run (not done): "Do the next steps" is offered when two or more are left. */
export const leftToRun = (commands: readonly DoneCommand[], states: Readonly<Record<string, CommandState>>): DoneCommand[] => commands.filter((command) => (states[command.key]?.phase ?? 'todo') !== 'done')

/**
 * "Do the next steps": the commands one after another, each its own call; it stops at the FIRST refusal (the rest stay to do, nothing
 * rolled back silently — as Clear rush does). `run` carries one out and answers its state; `onState` hears every change.
 */
export async function runInOrder(commands: readonly DoneCommand[], run: (command: DoneCommand) => Promise<CommandState>, onState: (key: string, state: CommandState) => void): Promise<{ readonly done: number; readonly refused: string | null }> {
  let done = 0
  for (const command of commands) {
    onState(command.key, { phase: 'running' })
    const state = await run(command)
    onState(command.key, state)
    if (state.phase !== 'done') return { done, refused: command.key }
    done += 1
  }
  return { done, refused: null }
}

/** What the done view holds: the notice and what opens next, handed to the host on Close / Next request ›. */
export interface DoneView {
  readonly notice: { readonly key: string; readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; readonly params?: Record<string, string | number>; readonly lines?: readonly Words[] }
  /** Close (a door) or Next request › (Home › Approvals). */
  readonly next: 'close' | 'next'
  readonly commands: readonly DoneCommand[]
  readonly states: Readonly<Record<string, CommandState>>
  /** The run of "Do the next steps" is going. */
  readonly running: boolean
}

// ---- F-SA-242 (R3, P8; 14-change-flow §4.2): the words in the order's conversation ----

/** The tick "Also write it in the order's conversation" and what became of it. */
export interface TellTick {
  /** Ticked by the person (null: not touched — on when words are typed). */
  readonly chosen: boolean | null
  /** How the customer is reached: in the portal (a request is asked there), or not at all (no portal person any more). */
  readonly reach: 'portal' | 'none'
  /** After the answer: written, refused (a key of `approvals`), or nothing yet. */
  readonly sent: 'no' | 'sending' | 'sent' | { readonly refused: string }
  /** "Tell the customer…" in the done view: its words, while open (null: closed). */
  readonly compose: string | null
}

export const tickOn = (tick: Pick<TellTick, 'chosen'>, words: string): boolean => tick.chosen ?? words.trim() !== ''

/** Why the tick waits: no words yet ("Type the words first"), or no way to reach the customer. Null: it may be ticked. */
export function tellHeld(tick: Pick<TellTick, 'reach'>, words: string): string | null {
  if (tick.reach === 'none') return `${CR}.tell.held.reach`
  if (words.trim() === '') return `${CR}.tell.held.words`
  return null
}

/** The customer is reached in the portal while a portal person asked (every request is asked there) and the portal did not refuse. */
export const reachOf = (request: Pick<BrandRequest, 'askedBy'>, refusedHere: boolean): TellTick['reach'] => (request.askedBy !== null && !refusedHere ? 'portal' : 'none')

/** The words go to the conversation only when ticked, typed and the customer is reached (never automatic). */
export const tellsNow = (tick: TellTick, words: string): boolean => tickOn(tick, words) && tellHeld(tick, words) === null

/** A refusal of the conversation's send in this window's words (the thread's own codes: NO_PORTAL, CLOSED …). */
export function tellRefusalOf(code: string | null): string {
  if (code === 'notice.portal.NO_PORTAL' || code === 'notice.portal.NO_PARTY') return `${CR}.tell.held.reach`
  if (code === 'notice.portal.CLOSED') return `${CR}.tell.refused.closed`
  return `${CR}.tell.refused.other`
}
// ---- end F-SA-241 / F-SA-242
