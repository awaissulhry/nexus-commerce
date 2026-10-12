/**
 * Bid page, Bids view — Change bid (Owner 2026-10-12: "a bid of my own choice, or reduce the bid or add to the bid by a
 * certain number or by a certain percentage"). One dialog for the selected keywords and for one keyword's detail: How ·
 * value · an optional limit, and the review's table Now → New, worked out again on every key. Pure, tested in Node
 * (`adjustModel.vitest.test.ts`).
 *
 *   How     Set to € · Raise by € · Lower by € · Raise by % · Lower by %
 *   Limit   "Not above" for Set and the raises, "Not below" for the lowers; empty = none
 *
 * Money in cents of each row's own currency, rounded to the cent (half up). A result under Nexus's floor or over the
 * ceiling stops there and its line says so; a limit hit says "Stops at your limit". A bid that cannot change says why
 * (its market Nexus only reads, hidden, already there). Who may move it next, and the brain's Auto → Manual, are
 * `movesNext` — the same rule as Apply suggested. A selection in more than one currency holds the money modes: an
 * amount means nothing across € and £, a percent does.
 */
import { money } from '../_shared/format'
import { bidProblem, MAX_BID_CENTS, MIN_BID_CENTS, parseBid, type BidGridRow } from './bidsModel'
import { BRAIN_STOPS, movesNext, skipWords } from './suggestedModel'

export const ADJUST_HOWS = ['set', 'raiseBy', 'lowerBy', 'raisePct', 'lowerPct'] as const
export type AdjustHow = (typeof ADJUST_HOWS)[number]
export const isAdjustHow = (v: unknown): v is AdjustHow => (ADJUST_HOWS as readonly unknown[]).includes(v)

/** What the person typed, as typed. */
export interface AdjustDraft { how: AdjustHow; amount: string; limit: string }

const isMoney = (how: AdjustHow): boolean => how === 'set' || how === 'raiseBy' || how === 'lowerBy'
const lowers = (how: AdjustHow): boolean => how === 'lowerBy' || how === 'lowerPct'

/**
 * The draft after another How: the value starts empty (0.05 € means nothing as a percent), and so does the limit when
 * its side turns ("Not above" ↔ "Not below": a limit typed for one never silently means the other).
 */
export function withHow(draft: AdjustDraft, how: AdjustHow): AdjustDraft {
  if (how === draft.how) return draft
  return { how, amount: '', limit: lowers(how) === lowers(draft.how) ? draft.limit : '' }
}

/** The highest raise a percent may ask for (a typo of 100 for 10 is still shown in the table before it goes). */
export const MAX_RAISE_PCT = 500

export const MIXED_MONEY = 'Pick one market to change bids by an amount'
export const MIXED_LIMIT = 'Bids in more than one currency: pick one market to set a limit'
const A_BID = 'Type a bid like 0.45'

/** The rows whose bid may change: a market Nexus writes to, a bid this person sees. */
const changeable = (r: BidGridRow): boolean => !r.writeBlock && typeof r.bidNow === 'number'

/** The currencies of the bids that may change, in the order met (all rows when none may). */
export function currenciesOf(rows: readonly BidGridRow[]): string[] {
  const some = rows.some(changeable) ? rows.filter(changeable) : rows
  return [...new Set(some.map((r) => r.currency))]
}

/** Where the dialog starts: Set to (the Owner's first words), or Raise by % when the bids are in more than one
 *  currency. */
export function adjustStart(rows: readonly BidGridRow[]): AdjustDraft {
  return { how: currenciesOf(rows).length > 1 ? 'raisePct' : 'set', amount: '', limit: '' }
}

/** "12.5" or "12,5" → 1250 (hundredths of a percent); "" → null; anything else → NaN. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(',', '.').replace(/\s*%$/, '')
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  return Math.round(Number(t) * 100)
}

/** The draft, read: the value (cents, or hundredths of a percent), the limit in cents, and why Save waits. */
export interface AdjustInput {
  how: AdjustHow
  value: number | null
  limit: number | null
  /** Why nothing can go yet, in a few words (the review's held Save); null = the plan may go. */
  held: string | null
  /** What is wrong with a typed value, for the field it belongs to (never for an empty one). */
  errors: { amount?: string; limit?: string }
}

export function readDraft(draft: AdjustDraft, currencies: readonly string[]): AdjustInput {
  const { how } = draft
  const currency = currencies[0] ?? 'EUR'
  const mixed = currencies.length > 1
  const errors: AdjustInput['errors'] = {}
  let value: number | null = null
  let waiting: string | null = null

  if (mixed && isMoney(how)) waiting = MIXED_MONEY
  else if (how === 'set') {
    const cents = parseBid(draft.amount)
    const problem = bidProblem(cents, currency)
    if (cents === null) waiting = problem
    else if (!Number.isFinite(cents)) errors.amount = A_BID
    else if (problem) errors.amount = problem
    else value = cents
  } else if (isMoney(how)) {
    const cents = parseBid(draft.amount)
    if (cents === null) waiting = 'Type an amount'
    else if (!Number.isFinite(cents)) errors.amount = 'Type an amount like 0.05'
    else if (cents <= 0) errors.amount = `More than ${money(0, currency)}`
    else if (cents > MAX_BID_CENTS) errors.amount = `At most ${money(MAX_BID_CENTS, currency)}`
    else value = cents
  } else {
    const pct = parsePercent(draft.amount)
    if (pct === null) waiting = 'Type a percent'
    else if (!Number.isFinite(pct)) errors.amount = 'Type a percent like 10'
    else if (pct <= 0) errors.amount = 'More than 0 %'
    else if (lowers(how) && pct >= 10_000) errors.amount = 'Under 100 %'
    else if (!lowers(how) && pct > MAX_RAISE_PCT * 100) errors.amount = `At most ${MAX_RAISE_PCT} %`
    else value = pct
  }

  // The limit: a bid in one currency; with more than one there is no field for it, and nothing typed counts.
  let limit: number | null = null
  if (!mixed) {
    const cents = parseBid(draft.limit)
    const problem = cents === null ? null : !Number.isFinite(cents) ? A_BID : bidProblem(cents, currency)
    if (problem) errors.limit = problem
    else limit = cents
  }

  const held = waiting ?? errors.amount ?? errors.limit ?? null
  return { how, value: held ? null : value, limit, held, errors }
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AdjustLine {
  row: BidGridRow
  /** The bid now and the bid it goes to, in cents (null: not known, or nothing typed yet). */
  now: number | null
  next: number | null
  /** Why this bid does not change; null = it goes (or waits for the value). */
  skip: string | null
  /** What else it says: where it stopped (floor, ceiling, your limit) and who may move it next. */
  note: string | null
  /** The brain runs it at Auto: it goes Manual with this bid. */
  goesManual: boolean
}

export interface AdjustPlan {
  input: AdjustInput
  lines: AdjustLine[]
  send: AdjustLine[]
  manual: number
}

/** Cents changed by a percent in hundredths, rounded to the cent (integer maths: no float drift at the half cent). */
const byPercent = (cents: number, hundredths: number): number => Math.round((cents * (10_000 + hundredths)) / 10_000)

/** One row's new bid, or why it stays. */
function lineOf(row: BidGridRow, input: AdjustInput): AdjustLine {
  const now = typeof row.bidNow === 'number' && Number.isFinite(row.bidNow) ? row.bidNow : null
  const stay = (skip: string): AdjustLine => ({ row, now, next: null, skip, note: skip, goesManual: false })
  if (row.writeBlock) return stay(row.writeBlock)
  if (now === null) return stay('Bids are hidden for you')
  const { how, value, limit } = input
  if (value === null) return { row, now, next: null, skip: null, note: null, goesManual: false }

  const c = row.currency
  const floor = money(MIN_BID_CENTS, c)
  const ceiling = money(MAX_BID_CENTS, c)
  const yours = limit === null ? '' : money(limit, c)
  // A raise that cannot go up, a lower that cannot go down: said before any number is worked out.
  if (how !== 'set') {
    if (lowers(how)) {
      if (limit !== null && now <= limit) return stay(`Already at or under your limit ${yours}`)
      if (now <= MIN_BID_CENTS) return stay(`Already at the ${floor} floor`)
    } else {
      if (limit !== null && now >= limit) return stay(`Already at or over your limit ${yours}`)
      if (now >= MAX_BID_CENTS) return stay(`Already at the ${ceiling} ceiling`)
    }
  }

  let next = how === 'set' ? value
    : how === 'raiseBy' ? now + value
      : how === 'lowerBy' ? now - value
        : byPercent(now, how === 'raisePct' ? value : -value)
  let stop: string | null = null
  const limited = limit !== null && (lowers(how) ? next < limit : next > limit)
  if (limited) { next = limit!; stop = `Stops at your limit ${yours}` }
  if (next < MIN_BID_CENTS) { next = MIN_BID_CENTS; stop = `Stops at the ${floor} floor` }
  if (next > MAX_BID_CENTS) { next = MAX_BID_CENTS; stop = `Stops at the ${ceiling} ceiling` }

  if (next === now) return stay(limited ? `Already at your limit ${yours}` : how === 'set' ? 'Already at that bid' : 'Rounds to the same bid')
  const who = movesNext(row)
  return { row, now, next, skip: null, note: [stop, who.note].filter(Boolean).join(' · ') || null, goesManual: who.goesManual }
}

/** Every row's Now → New, or why it stays; the lines that go; how many go Manual. Nothing goes while the draft waits. */
export function adjustPlan(rows: readonly BidGridRow[], draft: AdjustDraft): AdjustPlan {
  const input = readDraft(draft, currenciesOf(rows))
  const lines = rows.map((r) => lineOf(r, input))
  const send = lines.filter((l) => l.next !== null && !l.skip)
  return { input, lines, send, manual: send.filter((l) => l.goesManual).length }
}

/** The review's table order: the bids that change first, then the ones that stay (each in the selection's order). */
export const tableOrder = (lines: readonly AdjustLine[]): AdjustLine[] => [...lines.filter((l) => !l.skip), ...lines.filter((l) => l.skip)]

/** The review's one line under its title: where it lands, and the brain's keywords that go Manual. */
export function adjustSummary(plan: Pick<AdjustPlan, 'send' | 'manual'>): string {
  if (!plan.manual) return 'Sends to Amazon now.'
  if (plan.send.length === 1) return `Sends to Amazon now. ${BRAIN_STOPS}.`
  return `Sends to Amazon now. The brain stops moving ${plan.manual} of these keywords until you switch them back to Auto.`
}

/** The review's problem when the value is typed and still nothing can go: each reason once. */
export function adjustNothing(plan: Pick<AdjustPlan, 'input' | 'lines' | 'send'>): string | null {
  if (plan.input.held || plan.send.length || !plan.lines.length) return null
  return `Nothing to send: ${skipWords(plan.lines)}`
}

/** "Send 12 bids"; "Send bids" while none can go yet. */
export const sendLabel = (n: number): string => (n === 0 ? 'Send bids' : n === 1 ? 'Send 1 bid' : `Send ${n} bids`)

/** The dialog's title: "Change bid" for one keyword, "Change 12 bids" for many. */
export const changeTitle = (n: number): string => (n === 1 ? 'Change bid' : `Change ${n} bids`)

/**
 * Why the Change bid button is held, or null. Whoever sets the bid, a person may change it (one rule with Apply
 * suggested, A6): only the market Nexus only reads, a hidden bid and the permission hold it — one keyword with its own
 * reason, many only when none of them can change.
 */
export function changeHeld(rows: readonly Pick<BidGridRow, 'writeBlock' | 'bidNow'>[], canBids: boolean): string | null {
  if (!rows.length) return 'Select the keywords first'
  const why = rows.map((r) => r.writeBlock || (typeof r.bidNow === 'number' ? null : 'Bids are hidden for you'))
  if (why.every((w) => w !== null)) return rows.length === 1 ? why[0] : `Nothing to change: ${skipWords(why.map((skip) => ({ skip })))}`
  return canBids ? null : 'Needs the ads bids permission'
}

// ── the form's words ────────────────────────────────────────────────────────────────────────────────────────────────

export interface AdjustField { label: string; prefix?: string; suffix?: string; placeholder: string; error?: string }
export interface AdjustForm {
  hows: Array<{ value: AdjustHow; label: string }>
  /** The value's field; null when the How chosen cannot take one here (an amount across currencies). */
  amount: AdjustField | null
  /** The optional limit's field; null when the bids are in more than one currency. */
  limit: AdjustField | null
  /** One plain line under the form: why a field is not there. */
  note: string | null
}

/**
 * What the form shows for this selection and draft. The money mark is the selection's currency ("€", "£"); with more
 * than one, each one ("€/£"), so the held money modes say why by themselves.
 */
export function adjustForm(rows: readonly BidGridRow[], draft: AdjustDraft, symbolOf: (currency: string) => string): AdjustForm {
  const currencies = currenciesOf(rows)
  const mixed = currencies.length > 1
  const mark = currencies.map(symbolOf).join('/') || symbolOf('EUR')
  const input = readDraft(draft, currencies)
  const hows: AdjustForm['hows'] = [
    { value: 'set', label: `Set to ${mark}` },
    { value: 'raiseBy', label: `Raise by ${mark}` },
    { value: 'lowerBy', label: `Lower by ${mark}` },
    { value: 'raisePct', label: 'Raise by %' },
    { value: 'lowerPct', label: 'Lower by %' },
  ]
  const one = rows.length === 1 && typeof rows[0].bidNow === 'number' ? rows[0].bidNow : null
  const amount: AdjustField | null = mixed && isMoney(draft.how) ? null
    : draft.how === 'set' ? { label: 'New bid', prefix: mark, placeholder: one !== null ? (one / 100).toFixed(2) : '0.50', error: input.errors.amount }
      : isMoney(draft.how) ? { label: 'Amount', prefix: mark, placeholder: '0.05', error: input.errors.amount }
        : { label: 'Percent', suffix: '%', placeholder: '10', error: input.errors.amount }
  const limit: AdjustField | null = mixed ? null
    : { label: lowers(draft.how) ? 'Not below' : 'Not above', prefix: mark, placeholder: 'No limit', error: input.errors.limit }
  return { hows, amount, limit, note: !mixed ? null : amount ? MIXED_LIMIT : MIXED_MONEY }
}
