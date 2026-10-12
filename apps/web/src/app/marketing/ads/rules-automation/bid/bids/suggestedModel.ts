/**
 * Bid page, Bids view — Amazon's suggested bid and "Apply" (KEYWORD-AUTO.md; Amazon's Targeting tab: a median with the
 * range under it, and Apply per row or for the selected rows). Pure, tested in Node (`suggestedModel.vitest.test.ts`).
 *
 * Read per ad group (`GET /api/advertising/bids/suggested?adGroupId=`): `{ fetchedAt, rows: [{ targetId, low, mid, high,
 * theme }], unavailable }`. Money in cents of the row's currency; the money keys are left out for a person without the
 * ad-spend permission (absent = hidden). `unavailable` is Amazon's (or the server's) reason in words: the page says "—"
 * with it, never a number of its own.
 *
 * Apply is a bid change through the review, and so is Change bid (one rule for both, the Owner's decision). What it
 * means depends on who runs the keyword:
 *   the Brain, at Auto   the keyword goes Manual: "The brain stops moving this keyword until you switch it back to Auto";
 *                        the review offers "Set a goal instead"
 *   a rule, a plan, an engine   allowed; the line says it may move it again
 *   you, nothing         a plain bid change
 */
import { reasonText } from '../../../_shared/adsWrite'
import type { OwnLimitLine } from '../../../_shared/sendAnyway'
import { money, relWords } from '../_shared/format'
import { MIN_BID_CENTS, ownerLabel, writerName, type BidGridRow } from './bidsModel'

export interface SuggestedBid { targetId: string; low?: number | null; mid?: number | null; high?: number | null; theme?: string | null }
export interface SuggestedAnswer { fetchedAt: string | null; rows: SuggestedBid[]; unavailable: string | null }

/** One ad group's read, as the view holds it. */
export type SuggestedState =
  | { kind: 'loading' }
  | { kind: 'ready'; answer: SuggestedAnswer }
  | { kind: 'failed'; error: string }

/** One keyword's suggestion out of its ad group's read. */
export type SuggestedCell =
  | { kind: 'loading' }
  | { kind: 'bid'; bid: SuggestedBid; at: string | null }
  | { kind: 'none'; reason: string }

export function suggestedCellOf(state: SuggestedState | undefined, targetId: string): SuggestedCell {
  if (!state || state.kind === 'loading') return { kind: 'loading' }
  if (state.kind === 'failed') return { kind: 'none', reason: `Suggested bid not read: ${state.error}` }
  if (state.answer.unavailable) return { kind: 'none', reason: state.answer.unavailable }
  const bid = state.answer.rows.find((r) => r.targetId === targetId)
  if (!bid) return { kind: 'none', reason: 'Amazon suggests no bid for this keyword' }
  return { kind: 'bid', bid, at: state.answer.fetchedAt }
}

const cents = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** The cell: the median, and on hover / focus the range and when Amazon said it ("€0.40 – €0.80 · Amazon · 3 h ago"). */
export function suggestedWords(cell: SuggestedCell, currency: string, now: number = Date.now()): { text: string; hint: string; mid: number | null } {
  if (cell.kind === 'loading') return { text: '…', hint: 'Reading Amazon\'s suggested bid', mid: null }
  if (cell.kind === 'none') return { text: '—', hint: cell.reason, mid: null }
  const { low, mid, high } = cell.bid
  if (!cents(mid)) return { text: '—', hint: mid === undefined ? 'Bids are hidden for you' : 'Amazon suggests no bid for this keyword', mid: null }
  const range = cents(low) && cents(high) ? `${money(low, currency)} – ${money(high, currency)} · ` : ''
  const when = cell.at ? ` · ${relWords(cell.at, now)}` : ''
  return { text: money(mid, currency), hint: `${range}Amazon${when}`, mid }
}

// ── Apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const BRAIN_STOPS = 'The brain stops moving this keyword until you switch it back to Auto'

export interface ApplyLine {
  row: BidGridRow
  /** The bid now and the suggested bid, in cents (null: not known). */
  now: number | null
  next: number | null
  /** Why this row is left out; null = it goes. */
  skip: string | null
  /** What else it does: the brain stops, or who may move it again. */
  note: string | null
  /** The brain runs it at Auto: it goes Manual with this bid. */
  goesManual: boolean
}

/** Who may move a bid again after a person's bid: the owner, in a few words; null when nothing automatic does. */
export function movesNext(row: Pick<BidGridRow, 'owner' | 'auto'>): { note: string | null; goesManual: boolean } {
  const o = row.owner
  if (o.kind === 'BRAIN') return row.auto === 'MANUAL' ? { note: null, goesManual: false } : { note: BRAIN_STOPS, goesManual: true }
  if (o.kind === 'RULE' || o.kind === 'PLAN') return { note: `${o.kind === 'RULE' ? 'Rule' : 'Hourly plan'} “${writerName(o)}” may move it again`, goesManual: false }
  if (o.kind === 'ENGINE') return { note: `${ownerLabel(o)} may move it again`, goesManual: false }
  return { note: null, goesManual: false }
}

/** The rows to apply, each with its now → suggested, or why it is left out. */
export function applyPlan(rows: readonly BidGridRow[], cellOf: (row: BidGridRow) => SuggestedCell): { lines: ApplyLine[]; send: ApplyLine[]; manual: number } {
  const lines = rows.map((row): ApplyLine => {
    const cell = cellOf(row)
    const now = cents(row.bidNow) ? row.bidNow : null
    const next = cell.kind === 'bid' && cents(cell.bid.mid) ? Math.round(cell.bid.mid) : null
    const who = movesNext(row)
    const skip = row.writeBlock ? row.writeBlock
      : cell.kind === 'loading' ? 'Still reading Amazon\'s suggested bid'
      : now === null ? 'Bids are hidden for you'
        : next === null ? (cell.kind === 'none' ? cell.reason : 'Amazon suggests no bid for this keyword')
          : next < MIN_BID_CENTS ? `Under Nexus's ${money(MIN_BID_CENTS, row.currency)} floor`
            : next === now ? 'Already at the suggested bid'
              : null
    return { row, now, next, skip, note: skip ? null : who.note, goesManual: !skip && who.goesManual }
  })
  const send = lines.filter((l) => !l.skip)
  return { lines, send, manual: send.filter((l) => l.goesManual).length }
}

/** The review's one line: where it lands, and what else it does. */
export function applySummary(plan: { send: readonly ApplyLine[]; manual: number }): string {
  if (!plan.send.length) return 'Nothing to apply.'
  if (!plan.manual) return 'Sends to Amazon now.'
  if (plan.send.length === 1) return `Sends to Amazon now. ${BRAIN_STOPS}.`
  return `Sends to Amazon now. The brain stops moving ${plan.manual} of these keywords until you switch them back to Auto.`
}

/** Why the left-out bids are left out, each reason once, without a doubled full stop: "Amazon suggests no bid; …". */
export function skipWords(lines: readonly Pick<ApplyLine, 'skip'>[]): string {
  return [...new Set(lines.map((l) => l.skip?.trim().replace(/\.+$/, '')).filter((w): w is string => !!w))].join('; ')
}

/** The bulk button is held when nothing of the selection can be applied, and says why (audit R7). */
export function applyHeld(plan: { lines: readonly Pick<ApplyLine, 'skip'>[]; send: readonly unknown[] }): string | null {
  if (plan.send.length) return null
  if (!plan.lines.length) return 'Select the keywords first'
  return `Nothing to apply: ${skipWords(plan.lines)}`
}

/** "Apply 3 suggested bids". */
export const applyLabel = (n: number): string => (n === 1 ? 'Apply 1 suggested bid' : `Apply ${n} suggested bids`)

// ── The bulk send's answer (POST /api/advertising/ad-targets/bulk-bid) ───────────────────────────────────────────────

/** One bid of a bulk send: sent (with its change's Undo handle, the change feed's) or not, with why. */
export interface SentBid { targetId: string; ok: boolean; words: string; actionLogId: string | null }
/** A row that waits on his own limits (3A): his "Send anyway" sends it again. */
export interface BulkWait { adTargetId: string; limits: OwnLimitLine[] }

interface BulkAnswer {
  ok?: boolean
  error?: unknown
  outcomes?: Array<{ ok: boolean; actionLogId?: string | null; error?: string | null; outboundQueueId?: string | null }>
  needsConfirmation?: BulkWait[]
}

/**
 * Each row's answer. The route lists first the rows it held back over his CPC ceiling (they have no outcome), then the
 * sent rows that wait on another of his limits; the outcomes follow the sent rows in order (advertising.routes.ts).
 */
export function readBulkBid(list: ReadonlyArray<{ targetId: string }>, status: number, raw: unknown): { results: SentBid[]; waits: BulkWait[] } {
  const body = (raw ?? {}) as BulkAnswer
  if (status >= 400 || body.ok === false) {
    const words = reasonText(body.error, status)
    return { results: list.map((e) => ({ targetId: e.targetId, ok: false, words, actionLogId: null })), waits: [] }
  }
  const waits = Array.isArray(body.needsConfirmation) ? body.needsConfirmation : []
  const outcomes = Array.isArray(body.outcomes) ? body.outcomes : []
  const heldBack = new Set(waits.slice(0, Math.max(0, list.length - outcomes.length)).map((w) => w.adTargetId))
  const waiting = new Set(waits.map((w) => w.adTargetId))
  const results: SentBid[] = []
  list.filter((e) => !heldBack.has(e.targetId)).forEach((e, i) => {
    const o = outcomes[i]
    if (!o || waiting.has(e.targetId)) return
    results.push({ targetId: e.targetId, ok: !!o.ok, words: o.ok ? (o.outboundQueueId ? 'Sent' : 'Saved') : reasonText(o.error), actionLogId: o.actionLogId ?? null })
  })
  return { results, waits }
}
