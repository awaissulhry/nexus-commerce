import { REPLY_BATCH_MAX } from '@nexus/factory-domain/threads/replies'
import { ASK_MAX_DAYS } from '@nexus/factory-domain/portal/tasks/rules' // F-CW-203: how far ahead a customer's to-do may be due
import type { ComposerContext, ComposerDraft, SwitchNote } from '../../../../lib/record-thread/composer/model'
import type { OrderRow } from '../api'
import type { Phrase } from './sheet/model'
// F-CP-162: words that look like a price (the API's B-CP-020, 409 NAMES_A_PRICE) — warned, never blocked, like the composer (F-CP-147).
import { namesPriceRefused } from '../../../../lib/record-thread/send-check/model'

/**
 * F-SA-282 (sales page plan N5, picks P10, R7; 11-customer-page §3.8 "Reply to <customer> on N…"; review BW-6; rule 7 / agreement T11
 * "never one bulk message from the office to several customers"): the pure rules of Reply to N on the Orders sheet's own bar — here
 * and on the customer page's Work tab. The SAME words go into the own conversation of each ticked order of ONE customer, in the portal
 * only (POST /threads/SalesOrder/:id/replies, one per order, all with ONE batchId: B-TH-045 folds them into one bell item per reader).
 * Nothing is copied between orders: each conversation gets its own message. No files (a file belongs to one order). Checked here
 * before any window (one customer, the right, at most 50) and again on the server (B-SA-073: BATCH_TWO_CUSTOMERS, BATCH_FULL, and the
 * mis-send text check NAMES_OTHER_CUSTOMER — the composer's own tick, F-SA-282a). Words are keys of the `orders-sheet` catalogue.
 */

/** The most orders one Reply to N posts on: the server's own limit (factory-domain threads/replies REPLY_BATCH_MAX). */
export const REPLY_MAX = REPLY_BATCH_MAX

/** An order the reply goes to: its own conversation (`SalesOrder` thread), its customer, its numbers as the office reads them. */
export interface ReplyTarget {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
  readonly partyId: string
  readonly partyName: string
  /** B-SA-070b: the customer's own number of the order ("Your order 12"; null: none given yet). */
  readonly customerSeq?: number | null
  /** F-CW-203: the order's company (the customer's to-do is made in it). */
  readonly companyId?: string | null
}

export const replyTargetsOf = (rows: readonly (Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyId' | 'partyName'> & Partial<Pick<OrderRow, 'customerSeq' | 'companyId'>>)[]): ReplyTarget[] =>
  rows.map((row) => ({ id: row.id, number: row.number, customerRef: row.customerRef, partyId: row.partyId, partyName: row.partyName, customerSeq: row.customerSeq ?? null /* B-SA-070b */, companyId: row.companyId ?? null /* F-CW-203 */ }))

/**
 * Why the bar's Reply to N… is held, in words before the click, or null: a ticked order of another customer than the page's (the
 * customer page), orders of more than one customer (Sales › Orders: one message never reaches two customers), no right to write in
 * the orders' conversations (threads.post), more than REPLY_MAX orders. The server checks each reply again (B-SA-073).
 */
export function replyManyHeld(rows: readonly Pick<OrderRow, 'partyId'>[], locked: string | null, canPost: boolean): Phrase | null {
  if (rows.length === 0) return null
  if (locked && rows.some((row) => row.partyId !== locked)) return { key: 'bulk.notThisCustomer' }
  if (new Set(rows.map((row) => row.partyId)).size > 1) return { key: 'reply.oneCustomer' }
  if (!canPost) return { key: 'reply.noRight' }
  if (rows.length > REPLY_MAX) return { key: 'reply.tooMany', params: { max: REPLY_MAX } }
  return null
}

/** The bar's words: "Reply to Brand Alpha on 6…" for one customer; with ticks of several, the customer is not named. */
export function replyManyLabel(rows: readonly Pick<OrderRow, 'partyId' | 'partyName'>[]): Phrase {
  const one = rows.length > 0 && new Set(rows.map((row) => row.partyId)).size === 1
  return one ? { key: 'bulk.reply', params: { customer: rows[0]!.partyName, count: rows.length } } : { key: 'bulk.replyAny', params: { count: rows.length } }
}

/**
 * The composer in N mode (rule 24: the thread's own text box, never a copy): the customer's portal only — an office note on N orders is
 * Note to N…, a mail goes per order — no @mentions (they live in office notes), no files (no clip is given). The API checks every call.
 */
export function replyComposerContext(customer: string): ComposerContext {
  return { recordType: 'SalesOrder', recordLabel: '', party: { name: customer }, can: { post: true, email: false, manage: false }, people: [], portal: true, many: true }
}

// ---- one order's answer ---------------------------------------------------------------------------------------------------------

/** What happened on one order: posted, refused for good with why (the server said it), or a fault (tried again by the next Send). */
// F-CW-203: a posted reply also says what became of the customer's to-do, when one was asked (`todo`; absent: none asked).
export type ReplyResult = { readonly state: 'sent'; readonly todo?: TodoResult } | { readonly state: 'refused'; readonly why: Phrase } | { readonly state: 'failed'; readonly why: Phrase }

// ---- F-CW-203 (customer Work tab plan §4; 10-design §4, §6 W3; lead settles S8, S37): "Ask <customer> about N…" = this window with
// ONE tick — "Put it in their to-do list, answer by <date>". After an order's reply is posted, one to-do "Answer our message" is made
// for the customer on that order (POST /partners/:partyId/tasks, ANSWER_MESSAGE; partners.tasks.manage — without the right the tick is
// not drawn and Ask ▾ does not offer the entry). The order then waits on the customer, with the days, until they answer. From Ask ▾
// the tick starts ON, from Reply to N OFF. A to-do that could not be made never loses the message: its line says so, and Try again
// makes the to-do alone (the reply is not posted twice).

/** The tick and its day (`YYYY-MM-DD`; '' = no date). */
export interface ReplyTodo {
  readonly on: boolean
  readonly due: string
}

/** What became of one order's to-do: made, refused for good with why, or a fault (tried again by the next Send). */
export type TodoResult = { readonly state: 'made' } | { readonly state: 'refused'; readonly why: Phrase } | { readonly state: 'failed'; readonly why: Phrase }

const DAY_MS = 86_400_000
const dayOf = (day: string): number => Date.parse(`${day}T12:00:00.000Z`)

/** The day the tick starts on: three working days from today (Saturday and Sunday are skipped). */
export function todoDueDefault(today: string): string {
  let at = dayOf(today)
  for (let left = 3; left > 0; ) {
    at += DAY_MS
    const weekday = new Date(at).getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return new Date(at).toISOString().slice(0, 10)
}

/** The tick as the window opens: ON from Ask ▾, OFF from Reply to N; its day ready either way. */
export const todoStart = (asked: boolean, today: string): ReplyTodo => ({ on: asked, due: todoDueDefault(today) })

/** Why the tick's day holds Send, or null: a day that is not after today, or further ahead than the API takes (no day at all is fine). */
export function todoHeld(todo: ReplyTodo | null | undefined, today: string): Phrase | null {
  if (!todo?.on || todo.due === '') return null
  if (todo.due <= today) return { key: 'reply.todo.past' }
  // The API counts to the END of that day: the last day it takes is the one before the limit.
  if (Math.round((dayOf(todo.due) - dayOf(today)) / DAY_MS) >= ASK_MAX_DAYS) return { key: 'reply.todo.far', params: { max: ASK_MAX_DAYS } }
  return null
}

/** What a refused to-do means: the reader's role, the request as it is (for good), or a fault (tried again). */
export function todoOutcomeOf(error: ReplyError): Exclude<TodoResult, { state: 'made' }> {
  if (error.kind === 'forbidden' || error.kind === 'step_up' || error.kind === 'signed_out') return { state: 'refused', why: { key: 'reply.todo.why.forbidden' } }
  if (error.kind === 'not_found' || error.kind === 'invalid' || error.kind === 'conflict') return { state: 'refused', why: { key: 'reply.why.refused' } }
  return { state: 'failed', why: { key: 'reply.why.failed' } }
}

/** The orders whose message is posted and whose to-do a fault stopped: the next Send makes the to-do alone. */
export const todoLeft = (targets: readonly ReplyTarget[], results: Readonly<Record<string, ReplyResult>>): ReplyTarget[] =>
  targets.filter((target) => {
    const result = results[target.id]
    return result?.state === 'sent' && result.todo?.state === 'failed'
  })
// ---- end F-CW-203

/** One reply's error as the hook reads it: the API's refusal code at `refusal/<CODE>` and the error's kind (null: no API answer). */
export interface ReplyError {
  readonly code: string | null
  readonly kind: string | null
}

/**
 * What one refused reply means: the box's hold (the text names another customer of ours — the API never says whom; the round stops and
 * the composer offers its tick), a refusal of THIS order for good with why, or a fault (no answer, the factory busy): tried again.
 * F-CP-162: or the words look like a price (409 NAMES_A_PRICE): the round stops, the text stays in the box with the composer's warning,
 * and its "Send anyway" goes on to the orders still to post with `pricesInWordsOk`.
 */
export function replyOutcomeOf(error: ReplyError, customer: string): { readonly kind: 'namesOther' } | { readonly kind: 'namesPrice' } | { readonly kind: 'refused' | 'failed'; readonly why: Phrase } {
  // F-CP-162: the price warning (B-CP-020), never an amount repeated.
  if (namesPriceRefused(error.code)) return { kind: 'namesPrice' }
  switch (error.code) {
    case 'NAMES_OTHER_CUSTOMER':
      return { kind: 'namesOther' }
    case 'BATCH_TWO_CUSTOMERS':
      return { kind: 'refused', why: { key: 'reply.oneCustomer' } }
    case 'BATCH_FULL':
      return { kind: 'refused', why: { key: 'reply.tooMany', params: { max: REPLY_MAX } } }
    case 'CLOSED':
      return { kind: 'refused', why: { key: 'reply.why.closed' } }
    case 'NO_PORTAL':
      return { kind: 'refused', why: { key: 'reply.why.noPortal', params: { customer } } }
    case 'NO_PARTY':
    case 'NOT_SHAREABLE':
      return { kind: 'refused', why: { key: 'reply.why.refused' } }
    default:
      break
  }
  if (error.kind === 'not_found') return { kind: 'refused', why: { key: 'reply.why.notFound' } }
  if (error.kind === 'forbidden' || error.kind === 'step_up' || error.kind === 'signed_out') return { kind: 'refused', why: { key: 'reply.why.forbidden' } }
  if (error.kind === 'invalid' || error.kind === 'conflict') return { kind: 'refused', why: { key: 'reply.why.refused' } }
  return { kind: 'failed', why: { key: 'reply.why.failed' } }
}

/** The orders the next Send posts on: not posted yet and not refused for good (a fault is tried again), in the ticked order. */
export const toSend = (targets: readonly ReplyTarget[], results: Readonly<Record<string, ReplyResult>>): ReplyTarget[] =>
  targets.filter((target) => {
    const result = results[target.id]
    return !result || result.state === 'failed'
  })

/** The orders already posted on (said above the box after the round stopped on a hold). */
export const sentOf = (targets: readonly ReplyTarget[], results: Readonly<Record<string, ReplyResult>>): ReplyTarget[] => targets.filter((target) => results[target.id]?.state === 'sent')

/** An order as the preview and the results name it: the office number, and the customer's PO when it gave one. */
export const targetLabel = (target: Pick<ReplyTarget, 'number' | 'customerRef'>): string => (target.customerRef ? `${target.number} (${target.customerRef})` : target.number)

// ---- B-SA-070b: the preview "Brand Alpha will read this on 6 orders:" names each order as the customer reads it — its own number
// ("Your order 12", the portal's count), the office number beside it for the writer; an order with no number of its own yet: as before.
export const previewLabel = (target: Pick<ReplyTarget, 'number' | 'customerRef' | 'customerSeq'>, say: (key: string, params: Record<string, string | number>) => string): string =>
  target.customerSeq ? say('reply.yourOrder', { seq: target.customerSeq, number: target.number }) : targetLabel(target)
// ---- end B-SA-070b

/** The Idempotency-Key of one order's reply, and the words and tick it was made for. */
export interface ReplyKey {
  readonly key: string
  readonly body: string
  readonly ticked: boolean
  /** F-CP-162: made for a "Send anyway" (pricesInWordsOk): another request than the first try's. */
  readonly pricesOk?: boolean
}

/**
 * The key one order's reply goes with: the same while the same words (and tick) go again — a try after a lost answer never posts
 * twice — and a new one for new words or the tick (the API refuses a key used for another request; a refused reply kept none).
 */
export function keyFor(previous: ReplyKey | undefined, body: string, ticked: boolean, fresh: () => string, /** F-CP-162: "Send anyway" */ pricesOk = false): ReplyKey {
  return previous && previous.body === body && previous.ticked === ticked && (previous.pricesOk ?? false) === pricesOk ? previous : { key: fresh(), body, ticked, ...(pricesOk ? { pricesOk } : {}) }
}

/**
 * One round of Send: each order still to post in turn, never two at once (the ticked order), one call per order into its OWN
 * conversation. It stops at the first text the API holds because it names another customer of ours (`namesOther`): nothing more goes,
 * the words come back held with the tick. Answers whether it was held (and by which hold) and how many were posted.
 * F-CP-162: it stops the same way at words that look like a price (`namesPrice`): they come back with the warning and "Send anyway".
 */
export async function replyRound(
  pending: readonly ReplyTarget[],
  post: (target: ReplyTarget) => Promise<ReplyResult | 'namesOther' | /* F-CP-162 */ 'namesPrice'>,
  onResult: (id: string, result: ReplyResult, done: number) => void,
): Promise<{ held: false | 'namesOther' | /* F-CP-162 */ 'namesPrice'; posted: number }> {
  let posted = 0
  for (const [index, target] of pending.entries()) {
    const result = await post(target)
    if (result === 'namesOther' || result === 'namesPrice') return { held: result, posted }
    if (result.state === 'sent') posted += 1
    onResult(target.id, result, index + 1)
  }
  return { held: false, posted }
}

// ---- the window's own holds -------------------------------------------------------------------------------------------------------

/** Whether the customer reads anything in its portal: on, off (the switch is off, or nobody active yet), unknown (not read). */
export type PortalState = 'on' | 'off' | 'unknown'

/** The portal from the customer's Portal access read (partners.view): off when its switch is off or no person of it is active. */
export function portalStateOf(access: { readonly settings: { readonly portalOn: boolean }; readonly people: readonly { readonly status: string }[] } | null): PortalState {
  if (!access) return 'unknown'
  return access.settings.portalOn && access.people.some((person) => person.status === 'ACTIVE') ? 'on' : 'off'
}

/**
 * Why Send waits beyond the composer's own reasons (empty, too long, sending, the names-another-customer hold), or null: the customer
 * has no portal yet (write by e-mail in each order's conversation), or every order is done (nothing left to post on).
 */
export function replySendHeld(portal: PortalState | undefined, customer: string, left: number): Phrase | null {
  if (portal === 'off') return { key: 'reply.portalOff', params: { customer } }
  if (left === 0) return { key: 'reply.nothingLeft' }
  return null
}

/**
 * The customer's language inside "{customer} reads {language}", in the page's language as a sentence writes it (Intl: "Italian",
 * "italiano"; the parties' `languageName` capitalises it for a label); its code when the browser has no name for it.
 */
export function languageInSentence(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** The round's receipt: how many were posted, and each order's line (posted, or not with why) in the ticked order. */
// F-CW-203: + `todos` — how many to-dos were made; `failed` also counts an order whose to-do a fault stopped (Try again makes it).
export function replyReceipt(targets: readonly ReplyTarget[], results: Readonly<Record<string, ReplyResult>>): { sent: number; failed: number; todos: number; lines: Array<{ id: string; label: string; result: ReplyResult | null }> } {
  const lines = targets.map((target) => ({ id: target.id, label: targetLabel(target), result: results[target.id] ?? null }))
  return {
    sent: lines.filter((line) => line.result?.state === 'sent').length,
    failed: lines.filter((line) => line.result?.state === 'failed').length + todoLeft(targets, results).length,
    todos: lines.filter((line) => line.result?.state === 'sent' && line.result.todo?.state === 'made').length,
    lines,
  }
}

// ---- the window's model (use-reply-many.ts keeps it; view/ReplyManyDialog.tsx draws it) -----------------------------------------

export interface ReplyManyModel {
  /** The one customer every ticked order is of. */
  readonly customer: { readonly id: string; readonly name: string }
  readonly targets: readonly ReplyTarget[]
  /** The one batch of every reply of this window (B-TH-045, B-SA-073). */
  readonly batchId: string
  /** The composer's draft (N mode: the portal only). */
  readonly draft: ComposerDraft
  readonly notes: readonly SwitchNote[]
  /** The customer's language (ISO 639-1): undefined while read; null when the reader may not read the customer (nothing guessed). */
  readonly language: string | null | undefined
  /** Whether the customer reads its portal: undefined while read; `unknown` when the reader may not read it (the server says at Send). */
  readonly portal: PortalState | undefined
  readonly sending: boolean
  /** While a round runs: how many orders of how many are done. */
  readonly progress: { readonly done: number; readonly count: number } | null
  /** Each order's answer so far, by order id. */
  readonly results: Readonly<Record<string, ReplyResult>>
  /** The last round ended with nothing held: the window shows its receipt. */
  readonly done: boolean
  /** F-CW-203: the to-do tick and its day; null: the reader may not make a customer's to-dos (the tick is not drawn). */
  readonly todo?: ReplyTodo | null
  /** F-CW-203: opened from Ask ▾ ("Ask <customer> about N orders"); absent: Reply to N. */
  readonly asked?: boolean
  /** F-CW-203: today (the company's day), for the tick's day. */
  readonly today?: string
}

export interface ReplyManyActions {
  readonly onDraft: (draft: ComposerDraft, notes: readonly SwitchNote[]) => void
  /** Send (and Try again): the orders still to post. */
  readonly onSend: () => void
  /** F-CW-203: the to-do tick or its day changed. */
  readonly onTodo?: (todo: ReplyTodo) => void
  /** F-CW-303: the receipt's order name pressed — the host shows that order's thread; the window stays open. Absent: plain names. */
  readonly onOrder?: (orderId: string) => void
  readonly onClose: () => void
}
