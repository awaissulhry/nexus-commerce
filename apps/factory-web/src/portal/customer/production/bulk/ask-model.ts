import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import type { AskBody, ChangeRules, ImpactRead } from '../../orders/api'
import { verdictKey } from '../../orders/ask-model'
import { recordHref } from '../../orders/model'
import type { ProductionRow, UrgentUse } from '../api'
import { rowName } from '../model'
import { BULK_REASON_MAX, type AskManyAnswer, type BulkAskKind } from './api'
import { commonHeld, type BulkFacts, type RowResult } from './model'

/**
 * F-PR-23b — Ask N on My production (production plan §3 "Bulk asks: one request per order, one batch; one kind per batch"; lead
 * picks L25, L26; review fix R-50: urgent is asked only through Mark urgent; walls PW-12, PW-15), pure: Ask ▾ offers the kinds the
 * customer's limits open — pause and resume by its limits, cancel by the company's cut-offs —, the review names each picked order
 * with what will happen (asked of us, with its impact: what is frozen, the cost — an amount only for a price role —, what a pause
 * means; or why it cannot be asked now), ONE request per order of ONE batch, each answered by us; after Send one result per row and
 * Undo (what still waits for our answer is withdrawn). "Ask us" on a single row (over the limit or from Cutting) opens the order's
 * own Ask dialog at Urgent, with its need-by date (F-PR-13).
 *
 * The wall: each order's rules and impact are its OWN reads (the session's party); the body names only the picked rows' ids.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
const say = (words: { readonly it: string; readonly en: string }, locale: Locale): string => words[locale]

// ── "Ask us" on a single row: the order's own Ask dialog at Urgent (F-PR-13 `?ask=RUSH`) ─────────────────────────────────
/**
 * Where a row's "Ask us" leads, or null when it is not drawn: only while the customer's urgency is on, the person may ask, and its
 * Mark urgent waits on the limit or on Cutting (never on our lock, never while an "Urgent – asked" waits).
 */
export function askUsHrefOf(prefix: string, row: Pick<ProductionRow, 'id' | 'urgency' | 'stage'>, facts: { readonly urgencyOn: boolean; readonly mayAsk: boolean; readonly use: UrgentUse | null }): string | null {
  const urgency = row.urgency
  if (!facts.urgencyOn || !facts.mayAsk || !urgency || urgency.code !== 'REGULAR' || urgency.locked || urgency.asked) return null
  const cut = row.stage !== null && row.stage.code !== 'PREPARING'
  const full = facts.use !== null && facts.use.left <= 0
  return cut || full ? recordHref(prefix, row.id, 'status', { ask: 'RUSH' }) : null
}

// ── the review before Send ───────────────────────────────────────────────────────────────────────────────────────────────
export interface AskForm {
  /** HOLD: why (required); RESUME and CANCEL: their words (optional, a cancel reason may need them). */
  readonly reason: string
  /** CANCEL: a code of the reasons offered. */
  readonly reasonCode: string
}
export const EMPTY_ASK_FORM: AskForm = { reason: '', reasonCode: '' }

/** The cancel reasons the tenant offers (every order's rules carry the same list): the first rules read. */
export const cancelReasonsOf = (rules: readonly (ChangeRules | null)[]): ChangeRules['reasons'] => rules.find((entry): entry is ChangeRules => entry !== null)?.reasons ?? []

/** What the form misses for the kind (a key of `portal-production`), or null. */
export function askFormProblem(kind: BulkAskKind, form: AskForm, reasons: ChangeRules['reasons']): string | null {
  if (form.reason.trim().length > BULK_REASON_MAX) return 'bulk.ask.form.long'
  if (kind === 'HOLD' && form.reason.trim() === '') return 'bulk.ask.form.why'
  if (kind === 'CANCEL') {
    const reason = reasons.find((entry) => entry.code === form.reasonCode)
    if (!reason) return 'bulk.ask.form.reason'
    if (reason.needsNote && form.reason.trim() === '') return 'bulk.ask.form.note'
  }
  return null
}

/** One order's ask as F-PR-13's impact read takes it (the same checks as Send, nothing written). */
export function askBodyOf(kind: BulkAskKind, form: AskForm): AskBody {
  const words = form.reason.trim()
  if (kind === 'CANCEL') return { kind: 'CANCEL', reasonCode: form.reasonCode, ...(words ? { note: words } : {}) }
  return { kind, ...(words ? { note: words } : {}) }
}

/** What Ask N sends: every order that may be asked, one kind, the form once. */
export function askManyBodyOf(kind: BulkAskKind, ids: readonly string[], form: AskForm): { orderIds: string[]; kind: BulkAskKind; reasonCode?: string; reason?: string } {
  const words = form.reason.trim()
  return { orderIds: [...ids], kind, ...(kind === 'CANCEL' && form.reasonCode ? { reasonCode: form.reasonCode } : {}), ...(words ? { reason: words } : {}) }
}

/** May this order be asked the kind now, by its own rules? Else why, in our words ("voi"). */
export function askVerdictOf(kind: BulkAskKind, rules: ChangeRules, locale: Locale, tOrders: Translate, day: (iso: string) => string, t: Translate): { possible: true } | { possible: false; why: string } {
  if (kind === 'CANCEL') {
    if (rules.openRequestId) return { possible: false, why: t('bulk.ask.openRequest') }
    return rules.cancel.possible ? { possible: true } : { possible: false, why: say(rules.cancel.words, locale) }
  }
  const ask = (rules.asks ?? []).find((entry) => entry.kind === kind)
  if (!ask || !ask.open) return { possible: false, why: tOrders('ask.verdict.NOT_OPEN') }
  if (ask.waitingRequestId) return { possible: false, why: ask.verdict.day ? tOrders('ask.verdict.WAITING', { day: day(ask.verdict.day) }) : tOrders('ask.verdict.WAITING_NO_DAY') }
  if (ask.verdict.possible) return { possible: true }
  const key = verdictKey(kind, ask.verdict)
  if (!key) return { possible: false, why: say(ask.verdict.words, locale) }
  return { possible: false, why: tOrders(key.key, key.params?.day ? { day: day(key.params.day) } : undefined) }
}

/** The impact of one order's ask in one line: what is frozen, the cost (an amount only for a price role), what a pause means. */
export function impactLineOf(kind: BulkAskKind, read: ImpactRead, money: (minor: number, currency: string) => string, tOrders: Translate): { readonly line: string; readonly blocked: boolean } {
  const impact = read.impact
  const head = impact.frozen.length === 0 ? 'ask.impact.nothingFrozen' : impact.blocked ? 'ask.impact.blocked' : 'ask.impact.frozen'
  const fee = read.cancelFee?.totalFee
  const cost = typeof fee === 'number' && fee > 0 && read.cancelFee ? tOrders('ask.impact.fee', { fee: money(fee, read.cancelFee.currency) }) : impact.priced ? tOrders('ask.impact.mayApply') : tOrders('ask.impact.noPrice')
  const note = kind === 'HOLD' || kind === 'RESUME' ? tOrders(`ask.impact.note.${kind}`) : null
  return { line: [tOrders(head), cost, note].filter((part): part is string => !!part).join(' '), blocked: impact.blocked }
}

export type AskWill = 'READING' | 'ASK' | 'CANNOT'

export interface AskRowFacts {
  readonly id: string
  readonly name: string
  /** Where the order is now ("Sewing", "Paused at your request"). */
  readonly now: string
  readonly rules: { readonly state: 'loading' | 'error' | 'ready'; readonly rules: ChangeRules | null }
  /** The impact read with the form as it is (null: not read yet: the form is not filled in, or the rules are read). */
  readonly impact: { readonly state: 'loading' | 'error' | 'ready'; readonly read: ImpactRead | null } | null
}

export interface AskRow {
  readonly id: string
  readonly name: string
  readonly now: string
  readonly next: string
  readonly note: string | null
  readonly will: AskWill
}

export interface AskReview {
  readonly kind: BulkAskKind
  readonly rows: readonly AskRow[]
  /** The orders sent (every row that may be asked; an order whose rules could not be read is sent: we check it at Send). */
  readonly send: readonly string[]
  readonly reading: boolean
}

/** Each picked order with what will happen: asked of us (with its impact once read), or why not; reading while its rules are read. */
export function askReviewOf(
  kind: BulkAskKind,
  rows: readonly AskRowFacts[],
  words: { readonly locale: Locale; readonly t: Translate; readonly tOrders: Translate; readonly day: (iso: string) => string; readonly money: (minor: number, currency: string) => string },
): AskReview {
  const { locale, t, tOrders, day, money } = words
  const asked = t(`bulk.ask.asked.${kind}`)
  const out = rows.map((row): AskRow => {
    const base = { id: row.id, name: row.name, now: row.now }
    if (row.rules.state === 'loading') return { ...base, next: t('bulk.ask.readingRow'), note: null, will: 'READING' }
    if (row.rules.state === 'error' || !row.rules.rules) return { ...base, next: asked, note: t('bulk.ask.unread'), will: 'ASK' }
    const verdict = askVerdictOf(kind, row.rules.rules, locale, tOrders, day, t)
    if (!verdict.possible) return { ...base, next: t('bulk.review.stays'), note: verdict.why, will: 'CANNOT' }
    const impact = row.impact
    if (!impact || impact.state === 'loading') return { ...base, next: asked, note: impact ? t('bulk.ask.impactReading') : null, will: 'ASK' }
    if (impact.state === 'error' || !impact.read) return { ...base, next: asked, note: t('bulk.ask.impactFailed'), will: 'ASK' }
    const line = impactLineOf(kind, impact.read, money, tOrders)
    if (line.blocked) return { ...base, next: t('bulk.review.stays'), note: line.line, will: 'CANNOT' }
    return { ...base, next: asked, note: line.line, will: 'ASK' }
  })
  return { kind, rows: out, send: out.filter((row) => row.will === 'ASK').map((row) => row.id), reading: out.some((row) => row.will === 'READING') || rows.some((row) => row.impact?.state === 'loading') }
}

/** Why Send waits: the bar's reasons, the reads, the form, nothing to ask. Null: it sends. */
export function askHeldOf(review: AskReview, formProblem: string | null, facts: Pick<BulkFacts, 'preview' | 'offline' | 'busy'>, t: Translate): string | null {
  return commonHeld(review.rows.length, facts, t) ?? (review.reading ? t('bulk.ask.held.reading') : formProblem ? t(formProblem) : review.send.length === 0 ? t('bulk.ask.held.nothing') : null)
}

/** The review's title and Send: "Ask us to pause 3 orders" · "Ask for 2". */
export const askTitleOf = (review: Pick<AskReview, 'kind' | 'rows'>, t: Translate): string => t(`bulk.ask.title.${review.kind}`, { count: review.rows.length })
export const askSaveOf = (review: Pick<AskReview, 'send'>, t: Translate): string => t('bulk.ask.save', { count: review.send.length })

/** The own names of the picked rows (the review names each order the customer's way). */
export const askRowNamesOf = (rows: readonly ProductionRow[], locale: Locale, t: Translate): { id: string; name: string; now: string }[] =>
  rows.map((row) => ({ id: row.id, name: rowName(row, locale, t), now: row.marks.paused ? t('bulk.ask.now.paused') : row.stage ? say(row.stage.words, locale) : t('bulk.ask.now.none') }))

// ── after Send ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One result per row: asked of us, or why not (the API's words); an order not in the answer "not found"; one not sent named so. */
export function askResultsOf(review: AskReview, answer: AskManyAnswer, locale: Locale, t: Translate): { results: Record<string, RowResult>; asked: number; not: number } {
  const results: Record<string, RowResult> = {}
  let asked = 0
  let not = 0
  for (const row of review.rows) {
    if (!review.send.includes(row.id)) {
      results[row.id] = { ok: false, words: row.note ? t('bulk.result.notSentWhy', { words: row.note }) : t('bulk.result.notSent'), tone: 'neutral' }
      continue
    }
    const result = answer.results.find((entry) => entry.orderId === row.id)
    if (!result) {
      results[row.id] = { ok: false, words: t('bulk.result.notFound'), tone: 'danger' }
      not += 1
    } else if (result.done) {
      results[row.id] = { ok: true, words: t('bulk.result.asked'), tone: 'info' }
      asked += 1
    } else {
      results[row.id] = { ok: false, words: t('bulk.result.notDoneWhy', { words: say(result.words, locale) }), tone: 'warning' }
      not += 1
    }
  }
  return { results, asked, not }
}

/** The codes a refused ask names (sales/change-requests ASK_VERDICT_CODES and the ask's own), said in F-PR-13's words. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['NOT_OPEN', 'NOT_ASKABLE', 'WAITING', 'READY', 'LOCKED', 'ALREADY_URGENT', 'PAUSED', 'NOT_PAUSED', 'SHIPS_AS_READY', 'CLOSED_SHORT', 'CUT', 'LEATHER_CUT'])
const refusalKey = (code: string): string | null => (REFUSAL_CODES.has(code) ? `ask.verdict.${code === 'WAITING' || code === 'CUT' || code === 'LEATHER_CUT' ? `${code}_NO_DAY` : code}` : null)

/** Ask N refused as a whole (409: nothing asked; each order's code at `body/orderIds/<i>/<code>`), or not sent. */
export function askRefusalOf(review: AskReview, error: unknown, t: Translate, tOrders: Translate): { results: Record<string, RowResult> | null; problem: string | null } {
  if (!isApiError(error) || error.kind === 'unavailable') return { results: null, problem: t('bulk.failed.unavailable') }
  if (error.kind === 'forbidden') return { results: null, problem: t('bulk.ask.forbidden') }
  if (error.kind === 'invalid') return { results: null, problem: t('bulk.ask.invalid') }
  if (error.kind === 'conflict' || error.kind === 'not_found') {
    const words = new Map<string, string>()
    for (const issue of error.issues) {
      const parts = issuePath(issue).split('/')
      const at = Number(parts[2])
      const id = Number.isInteger(at) ? review.send[at] : undefined
      const code = parts[3] ?? ''
      if (!id) continue
      const key = refusalKey(code)
      words.set(id, key ? tOrders(key) : t('bulk.result.notAsked'))
    }
    const results: Record<string, RowResult> = {}
    for (const row of review.rows) {
      if (!review.send.includes(row.id)) results[row.id] = { ok: false, words: row.note ? t('bulk.result.notSentWhy', { words: row.note }) : t('bulk.result.notSent'), tone: 'neutral' }
      else results[row.id] = { ok: false, words: words.get(row.id) ?? (error.kind === 'not_found' ? t('bulk.result.notFound') : t('bulk.result.notAsked')), tone: 'warning' }
    }
    return { results, problem: null }
  }
  return { results: null, problem: t('bulk.failed.other') }
}
