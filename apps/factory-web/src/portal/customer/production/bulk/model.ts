import { GUEST_ZIP } from '@nexus/factory-domain/accounting/guest/files'
import { URGENCY_BATCH_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import type { ProductionRow, UndoAnswer, UrgencyAnswer, UrgencyOutcome, UrgentUse, Words } from '../api'
import { URGENCY_OUTCOMES } from '../api'
import { rowName, urgencyCell, urgencyText, urgentRowsOf, type Tone } from '../model'
import type { ProblemOrder } from '../problem/model'
import type { BulkAskKind, WithdrawAnswer } from './api'
import type { ChangeRules } from '../../orders/api' // F-PR-23b

/**
 * F-PR-23a — the bulk bar on My production (production plan §1 "Bulk", §3 "Customer urgency", §5 Portal › Production; 17-web-r2
 * §1.5; lead picks L25; review fixes R-49, R-50, R-64; walls PW-11, PW-12), pure. The rows the customer picked (box, x, Shift-click;
 * on a phone Select on the cards), the bar on the first pick: how many, Select all, at most five actions — Mark urgent · Mark regular
 * · Move to top (· Approve · Ask ▾ with F-PR-23b) — and More ▾ Report a problem · Download files · Export; at most 50 at a time.
 * Before Send a review names each order and what will happen (urgent now with its own place in its list; asked of us: over its
 * limit or from Cutting; cannot, and why); after Send one result per row, and Undo puts the urgency and the order back (and
 * withdraws what Mark urgent asked of us).
 *
 * The wall: every rule reads the customer's OWN rows as My production read them; a body names only those rows' ids; the API's
 * answer names only its own orders (an id not its own is only counted: "not found"). Nothing here makes a place in our plan, a
 * count of another customer or a name of ours — the stage is a hint, the API decides on its live cut facts.
 */

/** At most this many orders per bulk action (the API's URGENCY_BATCH_MAX = BULK_ASK_MAX = BULK_FILES_MAX). */
export const BULK_MAX = URGENCY_BATCH_MAX

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
const say = (words: Words, locale: Locale): string => words[locale]

// ── the picked rows ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The picked rows that are in the list now, in the list's order (a row that left the list is no longer picked). */
export const pickedRowsOf = (rows: readonly ProductionRow[], selected: readonly string[]): ProductionRow[] => {
  const ids = new Set(selected)
  return rows.filter((row) => ids.has(row.id))
}

/** The selection kept after the list was read again: only ids still in it, in the order they were picked. */
export const keepPicked = (selected: readonly string[], rows: readonly ProductionRow[]): string[] => {
  const ids = new Set(rows.map((row) => row.id))
  return selected.filter((id) => ids.has(id))
}

/** "Select all 12": every row of the view (the list has no pages: all its own rows are loaded). */
export const allIdsOf = (rows: readonly ProductionRow[]): string[] => rows.map((row) => row.id)

// ── the bar ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const BULK_ACTIONS = ['URGENT', 'REGULAR', 'TOP', 'APPROVE', 'ASK_HOLD', 'ASK_CANCEL', 'ASK_RESUME', 'REPORT', 'FILES', 'EXPORT'] as const
export type BulkActionId = (typeof BULK_ACTIONS)[number]

export interface BulkFacts {
  /** The customer's urgency switch (off: no mark and no Move to top is drawn). */
  readonly urgencyOn: boolean
  /** portal.production.urgency. */
  readonly mayMark: boolean
  /** portal.salesOrders.ask: a mark over the quota or from Cutting is asked of us (else it stays as it is, with why). */
  readonly mayAsk: boolean
  /** portal.comment: Report a problem. */
  readonly mayReport: boolean
  /** portal.customerDocuments.view: Download files. */
  readonly mayFiles: boolean
  readonly preview: boolean
  readonly offline: boolean
  /** A bulk action is being sent or a file made. */
  readonly busy: boolean
  // ---- F-PR-23b
  /** portal.approvals.view: Approve (absent: not drawn). */
  readonly mayApprove?: boolean
  /** portal.approve: the role answers approvals (else Approve is held with why). */
  readonly mayAnswer?: boolean
  /** The kinds the customer's limits open for Ask ▾ (null: being read; absent: no Ask ▾). Drawn only with `mayAsk`. */
  readonly askKinds?: readonly BulkAskKind[] | null
  // ---- end F-PR-23b
}

export interface BulkAction {
  readonly id: BulkActionId
  readonly label: string
  /** A second line (what the action holds), or null. */
  readonly hint: string | null
  /** Why it cannot act now, in words; null: it acts. */
  readonly held: string | null
}

export interface BulkBar {
  /** How many are picked ("3 selected" is the frame's count). */
  readonly count: number
  /** "Select all 12" while some rows are not picked; null when every row is. */
  readonly selectAll: string | null
  /** The bar's own actions, in order (at most five: the marks, Move to top, then Approve and Ask with F-PR-23b). */
  readonly actions: readonly BulkAction[]
  /** More ▾: Report a problem, Download files, Export. */
  readonly more: readonly BulkAction[]
  /** F-PR-23b: Ask ▾ — pause, cancel, resume (the kinds the customer's limits open); null: not drawn. */
  readonly ask?: readonly BulkAction[] | null
}

/** Why every bulk action waits (preview, offline, sending, over 50), else null. */
export function commonHeld(count: number, facts: Pick<BulkFacts, 'preview' | 'offline' | 'busy'>, t: Translate): string | null {
  if (facts.preview) return t('held.preview')
  if (facts.offline) return t('held.offline')
  if (facts.busy) return t('bulk.held.busy')
  if (count > BULK_MAX) return t('bulk.held.tooMany', { count, max: BULK_MAX })
  return null
}

/**
 * The bar of the picked rows: the marks and Move to top only while the customer's urgency is on and the person may mark (else not
 * drawn: a portal draws no door that cannot open); Report a problem, Download files by right; Export for everyone who reads.
 */
export function bulkBarOf(picked: readonly ProductionRow[], total: number, facts: BulkFacts, t: Translate): BulkBar {
  const count = picked.length
  const common = commonHeld(count, facts, t)
  const actions: BulkAction[] = []
  if (facts.urgencyOn && facts.mayMark) {
    const urgent = picked.filter((row) => row.urgency?.code === 'URGENT').length
    actions.push({ id: 'URGENT', label: t('bulk.markUrgent'), hint: null, held: common ?? (urgent === count ? t('bulk.held.allUrgent') : null) })
    actions.push({ id: 'REGULAR', label: t('bulk.markRegular'), hint: null, held: common ?? (urgent === 0 ? t('bulk.held.allRegular') : null) })
    actions.push({ id: 'TOP', label: t('bulk.toTop'), hint: null, held: common ?? (urgent === 0 ? t('bulk.held.markFirst') : null) })
  }
  // ---- F-PR-23b: Approve (the approvals waiting on the picked orders) and Ask ▾
  if (facts.mayApprove) {
    const waiting = picked.filter((row) => row.waiting.code === 'YOU').length
    actions.push({ id: 'APPROVE', label: waiting > 0 ? t('bulk.approve.action', { count: waiting }) : t('bulk.approve.actionNone'), hint: null, held: common ?? (waiting === 0 ? t('bulk.held.nothingWaits') : !facts.mayAnswer ? t('bulk.approve.heldRole') : null) })
  }
  const ask = facts.mayAsk && facts.askKinds !== undefined ? askItemsOf(count, facts.askKinds, facts, t) : null
  // ---- end F-PR-23b
  const more: BulkAction[] = []
  if (facts.mayReport) more.push({ id: 'REPORT', label: t('bulk.report'), hint: t('bulk.reportHint'), held: common })
  if (facts.mayFiles) more.push({ id: 'FILES', label: t('bulk.files'), hint: t('bulk.filesHint'), held: common })
  // Export is a read: only the cap holds it (and a file being made).
  more.push({ id: 'EXPORT', label: t('bulk.export'), hint: t('bulk.exportHint'), held: facts.busy ? t('bulk.held.busy') : count > BULK_MAX ? t('bulk.held.tooMany', { count, max: BULK_MAX }) : null })
  return { count, selectAll: count < total ? t('bulk.selectAll', { count: total }) : null, actions, more, ask }
}

/**
 * The bar on a phone (17-web-r2 §1.5 "390: Mark urgent · Mark regular · More ▾"): the first two of the bar's actions stay, the
 * others join More ▾ first. On a desktop the bar is as it is.
 */
export function phoneBarOf(bar: BulkBar): BulkBar {
  return { ...bar, actions: bar.actions.slice(0, 2), more: [...bar.actions.slice(2), ...(bar.ask ?? []), ...bar.more], ask: null }
}

// ---- F-PR-23b: Ask ▾ (Ask N) ----------------------------------------------------------------------------------------------------
/** Ask ▾ in the bar's order: pause, cancel, resume. */
export const ASK_MENU: readonly BulkAskKind[] = ['HOLD', 'CANCEL', 'RESUME']

/** The bar's id of each kind. */
export const ASK_ACTION = { HOLD: 'ASK_HOLD', CANCEL: 'ASK_CANCEL', RESUME: 'ASK_RESUME' } as const satisfies Readonly<Record<BulkAskKind, string>>
export type AskActionId = (typeof ASK_ACTION)[BulkAskKind]
export const askKindOfAction = (id: string): BulkAskKind | null => ASK_MENU.find((kind) => ASK_ACTION[kind] === id) ?? null

/** The kinds the customer's limits open, read from one of its orders' rules (the limits are the customer's, not the order's). */
export function askKindsOf(rules: Pick<ChangeRules, 'asks'> | null): BulkAskKind[] {
  const open = new Set<string>((rules?.asks ?? []).filter((ask) => ask.open).map((ask) => ask.kind))
  return ASK_MENU.filter((kind) => kind === 'CANCEL' || open.has(kind))
}

/** Ask ▾'s items: the kinds open (a closed kind is not drawn); held while the limits are read, and by the bar's own reasons. */
export function askItemsOf(count: number, kinds: readonly BulkAskKind[] | null, facts: Pick<BulkFacts, 'preview' | 'offline' | 'busy'>, t: Translate): BulkAction[] {
  const common = commonHeld(count, facts, t)
  if (kinds === null) return ASK_MENU.map((kind) => ({ id: ASK_ACTION[kind], label: t(`bulk.ask.${kind}`), hint: null, held: common ?? t('bulk.ask.reading') }))
  return ASK_MENU.filter((kind) => kinds.includes(kind)).map((kind) => ({ id: ASK_ACTION[kind], label: t(`bulk.ask.${kind}`), hint: t(`bulk.ask.hint.${kind}`), held: common }))
}

// ---- end F-PR-23b

// ── the review before Send (Mark urgent · Mark regular · Move to top) ────────────────────────────────────────────────────
export const REVIEW_KINDS = ['URGENT', 'REGULAR', 'TOP'] as const
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** What becomes of one picked order: at once, asked of us (over its limit / from Cutting), nothing to change, or it cannot now. */
export type ReviewWill = 'NOW' | 'ASK_QUOTA' | 'ASK_CUT' | 'SAME' | 'CANNOT'

export interface ReviewRow {
  readonly id: string
  /** Their PO first, then "Your order 12" (never the office's series). */
  readonly name: string
  readonly now: string
  readonly next: string
  /** Why, in one line (asked: over your limit / cutting has started; cannot: our lock's reason, asked already …), or null. */
  readonly note: string | null
  readonly will: ReviewWill
}

export interface Review {
  readonly kind: ReviewKind
  readonly rows: readonly ReviewRow[]
  /** The ids sent, in the list's order (every row that changes now or is asked of us); the others are named, never sent. */
  readonly send: readonly string[]
  readonly counts: { readonly now: number; readonly asked: number; readonly same: number; readonly cannot: number }
  /** Move to top: the whole Urgent list in its new order (the API takes the whole list); null for a mark. */
  readonly order: readonly string[] | null
}

const willNote = (key: string | null, t: Translate): string | null => (key ? t(key) : null)

/**
 * Mark urgent or Mark regular of the picked rows, in the list's order, as the API will decide them (markDecision): back to Regular
 * is always free; Urgent is at once inside the quota and before Cutting (each new one at the end of its own list: "Urgent 3"),
 * asked of us over the quota or from Cutting (when the person may ask), never while we locked the order or an "Urgent – asked"
 * waits. The stage is the stored one (a hint): the API reads the live cut facts and says so in the row's result.
 */
export function markReviewOf(picked: readonly ProductionRow[], kind: 'URGENT' | 'REGULAR', use: UrgentUse | null, facts: Pick<BulkFacts, 'mayAsk'>, locale: Locale, t: Translate): Review {
  let used = use?.used ?? 0
  const max = use?.max ?? 0
  const rows: ReviewRow[] = picked.map((row): ReviewRow => {
    const name = rowName(row, locale, t)
    const urgency = row.urgency
    if (!urgency) return { id: row.id, name, now: '—', next: t('bulk.review.stays'), note: t('bulk.review.noUrgency'), will: 'CANNOT' }
    const now = urgencyText(urgencyCell(urgency, locale))
    const cannot = (note: string): ReviewRow => ({ id: row.id, name, now, next: t('bulk.review.stays'), note, will: 'CANNOT' })
    if (kind === 'REGULAR') {
      if (urgency.code !== 'URGENT') return { id: row.id, name, now, next: t('bulk.review.stays'), note: willNote('bulk.review.alreadyRegular', t), will: 'SAME' }
      return { id: row.id, name, now, next: t('bulk.review.regular'), note: null, will: 'NOW' }
    }
    if (urgency.code === 'URGENT') return { id: row.id, name, now, next: t('bulk.review.stays'), note: willNote('bulk.review.alreadyUrgent', t), will: 'SAME' }
    if (urgency.locked) return cannot(urgency.lockWords ? say(urgency.lockWords, locale) : t('held.locked'))
    if (urgency.asked) return cannot(t('held.asked'))
    if (row.stage && row.stage.code !== 'PREPARING') {
      if (!facts.mayAsk) return cannot(t('bulk.review.cutNoAsk'))
      return { id: row.id, name, now, next: t('bulk.review.asked'), note: t('bulk.review.askedCut'), will: 'ASK_CUT' }
    }
    if (used >= max) {
      if (!facts.mayAsk) return cannot(max <= 0 ? t('held.quotaNone') : t('held.quota', { used, max }))
      return { id: row.id, name, now, next: t('bulk.review.asked'), note: max <= 0 ? t('bulk.review.askedNone') : t('bulk.review.askedQuota', { max }), will: 'ASK_QUOTA' }
    }
    used += 1
    return { id: row.id, name, now, next: t('bulk.review.urgentRank', { rank: used }), note: null, will: 'NOW' }
  })
  return reviewOf(kind, rows, null)
}

/**
 * Move to top: the picked Urgent orders go first, in the order they hold now, then the other urgent orders as they are (the API
 * takes the whole Urgent list, with the time it was read). A picked Regular order says "Mark urgent first".
 */
export function topReviewOf(picked: readonly ProductionRow[], rows: readonly ProductionRow[], locale: Locale, t: Translate): Review {
  const urgent = urgentRowsOf(rows)
  const ids = new Set(picked.map((row) => row.id))
  const first = urgent.filter((row) => ids.has(row.id))
  const order = first.length > 0 ? [...first, ...urgent.filter((row) => !ids.has(row.id))].map((row) => row.id) : null
  const place = new Map((order ?? []).map((id, index) => [id, index + 1]))
  const out: ReviewRow[] = picked.map((row): ReviewRow => {
    const name = rowName(row, locale, t)
    const urgency = row.urgency
    const now = urgency ? urgencyText(urgencyCell(urgency, locale)) : '—'
    if (!urgency || urgency.code !== 'URGENT') return { id: row.id, name, now, next: t('bulk.review.stays'), note: t('bulk.held.markFirst'), will: 'CANNOT' }
    const rank = place.get(row.id) ?? urgency.urgentRank ?? 0
    if (rank === urgency.urgentRank) return { id: row.id, name, now, next: t('bulk.review.stays'), note: t('bulk.review.onTop'), will: 'SAME' }
    return { id: row.id, name, now, next: t('bulk.review.urgentRank', { rank }), note: null, will: 'NOW' }
  })
  const moves = out.some((row) => row.will === 'NOW')
  return reviewOf('TOP', out, moves ? order : null)
}

function reviewOf(kind: ReviewKind, rows: readonly ReviewRow[], order: readonly string[] | null): Review {
  const asked = rows.filter((row) => row.will === 'ASK_CUT' || row.will === 'ASK_QUOTA').length
  const now = rows.filter((row) => row.will === 'NOW').length
  return {
    kind,
    rows,
    send: kind === 'TOP' ? (order ? rows.filter((row) => row.will === 'NOW').map((row) => row.id) : []) : rows.filter((row) => row.will !== 'SAME' && row.will !== 'CANNOT').map((row) => row.id),
    counts: { now, asked, same: rows.filter((row) => row.will === 'SAME').length, cannot: rows.filter((row) => row.will === 'CANNOT').length },
    order,
  }
}

/** The review's title: "Mark 3 orders urgent", "Mark 2 orders regular", "Move 2 orders to the top". */
export const reviewTitleOf = (review: Pick<Review, 'kind' | 'rows'>, t: Translate): string =>
  t(review.kind === 'URGENT' ? 'bulk.review.titleUrgent' : review.kind === 'REGULAR' ? 'bulk.review.titleRegular' : 'bulk.review.titleTop', { count: review.rows.length })

/** The one line under the title: what the quota allows now ("You may mark 1 more urgent at once: 2 of 3 used."), or the rule. */
export function reviewLeadOf(review: Pick<Review, 'kind'>, use: UrgentUse | null, t: Translate): string {
  if (review.kind === 'REGULAR') return t('bulk.review.leadRegular')
  if (review.kind === 'TOP') return t('bulk.review.leadTop')
  if (!use || use.max <= 0) return t('bulk.review.leadNone')
  return use.left > 0 ? t('bulk.review.leadLeft', { count: use.left, used: use.used, max: use.max }) : t('bulk.review.leadFull', { used: use.used, max: use.max })
}

/** Save says what it does: "Mark 1 · ask 2", "Mark 3 urgent", "Ask us for 2", "Mark 2 regular", "Save the new order". */
export function reviewSaveOf(review: Pick<Review, 'kind' | 'counts'>, t: Translate): string {
  const { now, asked } = review.counts
  if (review.kind === 'REGULAR') return t('bulk.review.saveRegular', { count: now })
  if (review.kind === 'TOP') return t('bulk.review.saveTop')
  if (now > 0 && asked > 0) return t('bulk.review.saveBoth', { now, asked })
  if (asked > 0) return t('bulk.review.saveAsk', { count: asked })
  return t('bulk.review.saveUrgent', { count: now })
}

/** Why Save waits: the bar's own reasons, then nothing to send. Null: it sends. */
export function reviewHeldOf(review: Pick<Review, 'send'>, facts: Pick<BulkFacts, 'preview' | 'offline' | 'busy'>, t: Translate): string | null {
  return commonHeld(review.send.length, facts, t) ?? (review.send.length === 0 ? t('bulk.review.nothing') : null)
}

/** The need-by date of the orders asked of us is offered only when the review asks some. */
export const reviewAsks = (review: Pick<Review, 'counts'>): boolean => review.counts.asked > 0

// ── after Send: one result per row ───────────────────────────────────────────────────────────────────────────────────────
export interface RowResult {
  /** It went through (done, or asked of us). */
  readonly ok: boolean
  readonly words: string
  readonly tone: Tone
}

export interface BulkOutcome {
  readonly results: Readonly<Record<string, RowResult>>
  readonly done: number
  readonly asked: number
  readonly not: number
  /** What Undo puts back: the urgency batch (marks and moves) and the batch of what was asked of us. Null: nothing to undo. */
  readonly undo: { readonly batchId: string | null; readonly askBatchId: string | null } | null
}

const notSent = (row: ReviewRow, t: Translate): RowResult => ({ ok: false, words: row.note ? t('bulk.result.notSentWhy', { words: row.note }) : t('bulk.result.notSent'), tone: 'neutral' })

/** The answer of a mark or of the new order, row by row (an order not in the answer: not found among its own). */
export function outcomeOf(review: Review, answer: UrgencyAnswer, locale: Locale, t: Translate): BulkOutcome {
  const results: Record<string, RowResult> = {}
  let done = 0
  let asked = 0
  let not = 0
  const sent = new Set(review.send)
  for (const row of review.rows) {
    if (!sent.has(row.id)) {
      results[row.id] = notSent(row, t)
      continue
    }
    const result = answer.results.find((entry) => entry.orderId === row.id)
    if (!result) {
      results[row.id] = { ok: false, words: t('bulk.result.notFound'), tone: 'danger' }
      not += 1
    } else if (result.done) {
      results[row.id] = { ok: true, words: result.urgency === 'URGENT' ? (result.urgentRank !== null ? t('bulk.result.urgent', { rank: result.urgentRank }) : t('bulk.result.urgentNoRank')) : t('bulk.result.regular'), tone: 'success' }
      done += 1
    } else if (result.asked) {
      results[row.id] = { ok: true, words: t('bulk.result.asked'), tone: 'info' }
      asked += 1
    } else {
      results[row.id] = { ok: false, words: result.words ? t('bulk.result.notDoneWhy', { words: say(result.words, locale) }) : t('bulk.result.notDone'), tone: 'warning' }
      not += 1
    }
  }
  const askBatchId = answer.askBatchId ?? null
  const undo = answer.batchId || askBatchId ? { batchId: answer.batchId, askBatchId } : null
  return { results, done, asked, not, undo }
}

/** The outcome a refusal names at `body/orderIds/<index>/<OUTCOME>` (B-PR-22a), else null. */
const outcomeAt = (code: string): UrgencyOutcome | null => ((URGENCY_OUTCOMES as readonly string[]).includes(code) ? (code as UrgencyOutcome) : null)

/**
 * A bulk send refused as a whole (409: nothing changed and nothing was asked; each order's words at its place in the body), or
 * failed (no answer): the rows in words, and whether the send may be tried again (the same key: nothing is done twice).
 */
export function refusedOutcomeOf(review: Review, error: unknown, t: Translate): { outcome: BulkOutcome | null; problem: string | null } {
  if (!isApiError(error)) return { outcome: null, problem: t('bulk.failed.unavailable') }
  if (error.kind === 'unavailable') return { outcome: null, problem: t('bulk.failed.unavailable') }
  if (error.kind === 'forbidden') return { outcome: null, problem: t('refused.forbidden') }
  if (error.kind === 'conflict' || error.kind === 'not_found') {
    const results: Record<string, RowResult> = {}
    const sent = review.kind === 'TOP' ? (review.order ?? []) : review.send
    const byIndex = new Map<string, string>()
    for (const issue of error.issues) {
      const parts = issuePath(issue).split('/')
      const at = Number(parts[2])
      const id = Number.isInteger(at) ? sent[at] : undefined
      if (!id) continue
      const code = parts[3] ?? ''
      const outcome = outcomeAt(code)
      byIndex.set(id, outcome && outcome !== 'DONE' ? t(`refused.${outcome}`) : t('bulk.result.notAsked'))
    }
    // A version conflict of the new order names when and by whom (never a name), as the Urgent order dialog says it.
    const conflict = error.issues.map((issue) => issuePath(issue)).find((path) => path.startsWith('body/orderIds/CHANGED_SINCE'))
    let not = 0
    for (const row of review.rows) {
      if (!review.send.includes(row.id)) {
        results[row.id] = notSent(row, t)
        continue
      }
      const words = byIndex.get(row.id) ?? (error.kind === 'not_found' ? t('bulk.result.notFound') : conflict ? t('bulk.result.changed') : t('bulk.result.notDone'))
      results[row.id] = { ok: false, words, tone: 'warning' }
      not += 1
    }
    return { outcome: { results, done: 0, asked: 0, not, undo: null }, problem: null }
  }
  return { outcome: null, problem: t('bulk.failed.other') }
}

/** The Done line: "2 done · 1 asked of us · 1 not done" (only the parts that hold rows), its tone by the worst part. */
export function doneLineOf(outcome: Pick<BulkOutcome, 'done' | 'asked' | 'not'>, t: Translate): { line: string; tone: 'success' | 'warning' | 'danger' } {
  const parts = [
    ...(outcome.done > 0 ? [t('bulk.done.done', { count: outcome.done })] : []),
    ...(outcome.asked > 0 ? [t('bulk.done.asked', { count: outcome.asked })] : []),
    ...(outcome.not > 0 ? [t('bulk.done.not', { count: outcome.not })] : []),
  ]
  const tone = outcome.done + outcome.asked === 0 ? 'danger' : outcome.not > 0 ? 'warning' : 'success'
  return { line: parts.length > 0 ? parts.join(' · ') : t('bulk.done.nothing'), tone }
}

// ── Undo (marks and moves; what Mark urgent asked of us is withdrawn) ────────────────────────────────────────────────────
/** What an Undo did, in one line: put back (and what it left as it is), withdrawn, or why nothing was. */
export function undoLineOf(urgency: UndoAnswer | null, asks: WithdrawAnswer | null, t: Translate): string {
  const parts: string[] = []
  if (urgency) parts.push(urgency.skipped.length > 0 ? t('notice.undoneSkipped', { count: urgency.skipped.length }) : t('notice.undone'))
  if (asks) {
    const withdrawn = asks.results.filter((result) => result.done).length
    const left = asks.results.length - withdrawn
    parts.push(left > 0 ? t('bulk.undo.withdrawnLeft', { count: withdrawn, left }) : t('bulk.undo.withdrawn', { count: withdrawn }))
  }
  return parts.join(' ')
}

/** An Undo refused (another's batch or none: not found; every order changed since: nothing to undo). */
export function undoProblemOf(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('refused.failed')
  if (error.kind === 'not_found') return t('refused.undoNotFound')
  if (error.kind === 'conflict') return t('refused.undoNothing')
  if (error.kind === 'unavailable') return t('held.offline')
  return t('refused.failed')
}

// ── More ▾: Report a problem · Download files · Export ─────────────────────────────────────────────────────────────────
/** The orders the Report a problem dialog names, by their own names (F-PR-24's dialog holds Send over 50, in its words). */
export const problemOrdersOfRows = (picked: readonly ProductionRow[], locale: Locale, t: Translate): ProblemOrder[] => picked.map((row) => ({ id: row.id, name: rowName(row, locale, t) }))

/**
 * The zip's refusals (B-PR-46b factory-domain production-brand/approve-zip PRODUCTION_ZIP_REFUSALS; that module is server-only) and
 * its limits (the accountant's zip, accounting/guest/files GUEST_ZIP), said in our words.
 */
export const ZIP_REFUSALS = ['NOTHING_TO_ZIP', 'TOO_MANY_FILES', 'TOO_LARGE', 'FILE_UNAVAILABLE'] as const
export type ZipRefusal = (typeof ZIP_REFUSALS)[number]
const MB = 1024 * 1024

/** The zip refusal a 409 names at `problem/<CODE>` (B-PR-46b), else null. */
export function zipRefusalOf(error: unknown): ZipRefusal | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const code = issuePath(issue).split('/').pop() ?? ''
    if ((ZIP_REFUSALS as readonly string[]).includes(code)) return code as ZipRefusal
  }
  return null
}

/** Download files refused or failed, in words. */
export function zipProblemOf(error: unknown, t: Translate): string {
  const code = zipRefusalOf(error)
  if (code) return t(`bulk.zip.${code}`, { files: GUEST_ZIP.maxFiles, mb: Math.round(GUEST_ZIP.maxBytes / MB), fileMb: Math.round(GUEST_ZIP.fileBytes / MB) })
  if (!isApiError(error) || error.kind === 'unavailable') return t('bulk.filesFailed')
  if (error.kind === 'not_found') return t('bulk.filesNotFound')
  if (error.kind === 'forbidden') return t('bulk.filesForbidden')
  return t('bulk.filesFailed')
}

/** The zip's name on the person's disk: our words and the day, never the office's series of an order. */
export const zipNameOf = (today: string, t: Translate): string => `${t('bulk.filesName', { date: today })}.zip`
