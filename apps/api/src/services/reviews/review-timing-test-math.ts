/**
 * Reviews PR J (2026-10-27) — the pure part of timing tests and A/B splits: which group an order is in, how sure a
 * difference is, and the words. No database, no clock of its own.
 *
 *   assignArm()     an order goes to a group by its order number: a stable hash of (test, order number) picks one of
 *                   10,000 buckets; the first `holdoutPct` % of the buckets are the holdout (no request), the rest are
 *                   split evenly between the asked groups. The same order always lands in the same group of a test;
 *                   another test splits independently.
 *   sureBetter()    a simple two-proportion test: how likely the leader's review rate is really higher than the other
 *                   group's (one-sided, normal approximation, pooled rate).
 *   testResult()    the leader, how sure, the lift over the group in place now, and the words. "Too early to call" while
 *                   any asked group has fewer than MIN_COUNTED_PER_ARM orders whose time to answer is over.
 *
 * A review counts for an order the way the ONE review rate counts it (review-rate.service.ts): linked to its request by
 * the attribution within ANSWER_DAYS (= ATTRIBUTION_DAYS) of the request. Amazon does not say who wrote a review, so
 * every rate is an estimate; where no review can follow at all, the service says "Not measurable" instead of a 0 %.
 */
import { createHash } from 'node:crypto'

export const TEST_KINDS = ['TIMING', 'AB'] as const
export type TestKind = (typeof TEST_KINDS)[number]
export const TEST_STATUSES = ['DRAFT', 'WAITING_APPROVAL', 'RUNNING', 'STOPPED', 'DONE'] as const
export type TestStatus = (typeof TEST_STATUSES)[number]
/** A test that still holds its market: nobody may start another one there. */
export const LIVE_STATUSES: readonly TestStatus[] = ['DRAFT', 'WAITING_APPROVAL', 'RUNNING']

/**
 * The channels a TIMING test may cover: an Amazon market (Amazon's own request), or Shopify (Nexus's own review e-mail).
 * A Shopify test covers the whole store — its orders carry no market — stored as EVERY_MARKET, as an A/B split of an
 * all-markets rule is.
 */
export const TIMING_CHANNELS = ['AMAZON', 'SHOPIFY'] as const
export type TimingChannel = (typeof TIMING_CHANNELS)[number]
export const EVERY_MARKET = '*'
/** Why a channel is not offered for a timing test, in words (Owner, 2026-10-27: Nexus asks no eBay buyer). */
export const NOT_OFFERED_WORDS: Readonly<Record<string, string>> = {
  EBAY: 'eBay is not offered: Nexus asks no eBay buyer — eBay asks its buyers for feedback itself.',
  ETSY: 'Etsy is not offered: Nexus sends Etsy buyers no review request, so there is no day to test.',
}

/** The first-try days a timing test may compare (Amazon: day 4 at the earliest, the scheduler's cap is day 25; Shopify the same). */
export const FIRST_DAY = 4
export const LAST_DAY = 25
export const DAY_CHOICES = [4, 7, 10, 14, 21] as const
export const MIN_ARMS = 2
export const MAX_ARMS = 4
export const HOLDOUT_MAX = 20

export const DEFAULT_ORDERS_PER_ARM = 300
export const ORDERS_PER_ARM_MIN = 50
export const ORDERS_PER_ARM_MAX = 2000
export const DEFAULT_MAX_DAYS = 56
export const MAX_DAYS_MIN = 14
export const MAX_DAYS_MAX = 84

/**
 * Days after a request in which a review still counts for it: the ONE review rate's attribution window
 * (review-rate.service.ts ATTRIBUTION_DAYS, which review-attribution.service.ts links with). Kept here as a number so this
 * file stays pure; review-timing-test.vitest.test.ts holds the two equal.
 */
export const ANSWER_DAYS = 30
/** Orders per asked group, with their time to answer over, before a test may be called. */
export const MIN_COUNTED_PER_ARM = 100
/** How sure a winner must be before it may be applied. */
export const APPLY_MIN_SURE = 80

/** The scheduler's mark on a holdout order's request (`suppressedReason` + `providerResponseCode`). */
export const HOLDOUT_REASON = 'timing_test_holdout'
export const HOLDOUT_CODE = 'TIMING_TEST_HOLDOUT'
export const HOLDOUT_LABEL = 'Not asked (holdout)'

const BUCKETS = 10_000
const DAY_MS = 24 * 60 * 60 * 1000

export interface EndsWhen { ordersPerArm: number; maxDays: number }

/** The stored `endsWhen`, with defaults and bounds. */
export function endsWhenOf(raw: unknown): EndsWhen {
  const r = (raw ?? {}) as Partial<EndsWhen>
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
  return {
    ordersPerArm: num(r.ordersPerArm, DEFAULT_ORDERS_PER_ARM, ORDERS_PER_ARM_MIN, ORDERS_PER_ARM_MAX),
    maxDays: num(r.maxDays, DEFAULT_MAX_DAYS, MAX_DAYS_MIN, MAX_DAYS_MAX),
  }
}

/** "At 300 orders per group, or after 8 weeks". */
export function endsWords(ends: EndsWhen, kind: TestKind = 'TIMING'): string {
  const weeks = Math.round(ends.maxDays / 7)
  return `At ${ends.ordersPerArm.toLocaleString('en-IE')} orders per ${kind === 'AB' ? 'side' : 'group'}, or after ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
}

// ── Which group an order is in ───────────────────────────────────────────────────────────────────────────────────

/** 0–9,999, the same for the same test and order number on every run and every machine. */
export function bucketOf(testId: string, orderNumber: string): number {
  const digest = createHash('sha256').update(`${testId}\u0000${orderNumber.trim()}`).digest()
  return digest.readUInt32BE(0) % BUCKETS
}

export interface ArmSlot { id: string; position: number; holdout: boolean }

/** The group of an order (null when the test has no asked group). */
export function assignArm<T extends ArmSlot>(test: { id: string; holdoutPct: number; arms: readonly T[] }, orderNumber: string): T | null {
  const asked = test.arms.filter((a) => !a.holdout).sort((a, b) => a.position - b.position)
  if (asked.length === 0) return null
  const holdout = test.arms.find((a) => a.holdout) ?? null
  const held = holdout ? Math.round(Math.min(HOLDOUT_MAX, Math.max(0, test.holdoutPct)) * (BUCKETS / 100)) : 0
  const bucket = bucketOf(test.id, orderNumber)
  if (holdout && bucket < held) return holdout
  const index = Math.min(asked.length - 1, Math.floor(((bucket - held) * asked.length) / (BUCKETS - held)))
  return asked[index]
}

// ── How sure ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The standard normal distribution function (Abramowitz–Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

export interface GroupCount { n: number; k: number }

/**
 * How likely group `b`'s true rate is above group `a`'s (0–1), by a one-sided two-proportion z-test on the pooled rate.
 * Null when a group has no order; 0.5 when nothing (or everything) happened in both, so there is no difference to see.
 */
export function sureBetter(a: GroupCount, b: GroupCount): number | null {
  if (a.n <= 0 || b.n <= 0) return null
  const pooled = (a.k + b.k) / (a.n + b.n)
  if (pooled <= 0 || pooled >= 1) return 0.5
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n))
  return normalCdf((b.k / b.n - a.k / a.n) / se)
}

/** "92% sure means about 1 chance in 12 that the difference is luck." */
export function sureWords(sure: number): string {
  const luck = 1 - sure / 100
  if (luck <= 0.005) return `${sure}% sure means less than 1 chance in 200 that the difference is luck.`
  const inN = Math.max(1, Math.floor(1 / luck + 1e-9))
  return `${sure}% sure means about 1 chance in ${inN} that the difference is luck.`
}

// ── The result ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArmCounts {
  id: string
  label: string
  position: number
  holdout: boolean
  /** Orders the scheduler put in this group. */
  orders: number
  /** Their requests that went out. */
  sent: number
  /** Orders whose time to answer is over (they count in the rate). */
  counted: number
  /** Reviews among the counted orders. */
  reviews: number
}

export interface TestResult {
  tooEarly: boolean
  /** The asked group with the highest rate among counted orders; null before any counted order. */
  leaderId: string | null
  /** The group in place now (the first asked group). */
  controlId: string | null
  /** How sure the leader beats the group it is compared with (0–100), or null. */
  sure: number | null
  /** The leader's rate over the control's, in % (null when the control has none). */
  liftPct: number | null
  /** The headline in words. */
  words: string
  /** What "N% sure" means, or null. */
  sureWords: string | null
  /** Rate per group among counted orders (null when none counted). */
  rates: Record<string, number | null>
  /** More counted orders the smallest asked group needs before the test can be called (0 when it can). */
  needMore: number
}

const rateOf = (a: ArmCounts) => (a.counted > 0 ? a.reviews / a.counted : null)
const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`)

/** "Day 7" from "Day 7 (now)" for the middle of a sentence ("day 7"). */
function lower(label: string): string {
  const plain = label.replace(/\s*\(now\)$/i, '')
  return /^Day \d+$/.test(plain) ? plain.toLowerCase() : plain
}

/**
 * The leader, how sure and the words. `where` is the market in words ("in Germany"), used in the headline only.
 * The leader is compared with the group in place now; when the group in place leads, with the runner-up.
 */
export function testResult(arms: readonly ArmCounts[], opts: { where?: string; kind?: TestKind; ended?: boolean } = {}): TestResult {
  const asked = arms.filter((a) => !a.holdout).sort((a, b) => a.position - b.position)
  const rates: Record<string, number | null> = Object.fromEntries(arms.map((a) => [a.id, rateOf(a)]))
  const control = asked[0] ?? null
  const minCounted = asked.length ? Math.min(...asked.map((a) => a.counted)) : 0
  const needMore = Math.max(0, MIN_COUNTED_PER_ARM - minCounted)
  const base = { controlId: control?.id ?? null, rates, needMore }
  const where = opts.where ? ` ${opts.where}` : ''
  const more = opts.kind === 'AB' ? 'per side' : 'per group'
  // A test that ended gets no new orders: only the ones already in it still count, as their time to answer ends.
  const stillToGo = opts.ended
    ? `It ended with fewer than ${MIN_COUNTED_PER_ARM} counted orders ${more}; the orders already in it still count as their ${ANSWER_DAYS} days end.`
    : `About ${needMore} more orders ${more} to go; reviews keep arriving up to ${ANSWER_DAYS} days after each request.`

  const withCounted = asked.filter((a) => a.counted > 0)
  if (!control || withCounted.length < 2) {
    return {
      ...base, tooEarly: true, leaderId: null, sure: null, liftPct: null, sureWords: null,
      words: `Too early to call — no order has had its full time to answer yet. Reviews keep arriving up to ${ANSWER_DAYS} days after each request.`,
    }
  }
  const ranked = [...withCounted].sort((a, b) => (rateOf(b)! - rateOf(a)!) || a.position - b.position)
  const leader = ranked[0]
  const other = leader.id === control.id ? ranked[1] : control
  const sureRaw = sureBetter({ n: other.counted, k: other.reviews }, { n: leader.counted, k: leader.reviews })
  // Never "100% sure": the counts can always be luck.
  const sure = sureRaw == null ? null : Math.min(99, Math.round(sureRaw * 100))
  const lr = rateOf(leader)!
  const cr = rateOf(control)
  const liftPct = cr && cr > 0 ? Math.round((lr / cr - 1) * 100) : null
  const tooEarly = needMore > 0
  const noReviews = withCounted.every((a) => a.reviews === 0)

  if (noReviews) {
    return {
      ...base, tooEarly, leaderId: null, sure: null, liftPct: null, sureWords: null,
      words: tooEarly
        ? `Too early to call — no reviews in any group yet. ${stillToGo}`
        : 'No group brought a review yet — there is nothing to call.',
    }
  }
  const sureText = sure == null ? '' : `, ${sure}% sure`
  if (tooEarly) {
    const lead = rateOf(leader) === rateOf(other) ? 'the groups are level' : `${lower(leader.label)} leads${sureText}`
    return {
      ...base, tooEarly, leaderId: leader.id, sure, liftPct, sureWords: null,
      words: `Too early to call — ${lead}. ${stillToGo}`,
    }
  }
  let words: string
  if (rateOf(leader) === rateOf(other)) {
    words = `No difference${where}: ${lower(leader.label)} and ${lower(other.label)} bring the same share of reviews (${pct(lr)}).`
  } else if (leader.id === control.id) {
    const now = opts.kind === 'AB' ? '' : ' (now)'
    words = `${control.label.replace(/\s*\(now\)$/i, '')}${now} stays best${where} — ${sure ?? 50}% sure it beats ${lower(other.label)}`
  } else if (liftPct != null) {
    words = `${leader.label.replace(/\s*\(now\)$/i, '')} gets ${liftPct}% more reviews${where} — ${sure ?? 50}% sure`
  } else {
    words = `${leader.label} gets reviews where ${lower(control.label)} got none${where} — ${sure ?? 50}% sure`
  }
  return { ...base, tooEarly, leaderId: leader.id, sure, liftPct, words, sureWords: sure == null ? null : sureWords(sure) }
}

/**
 * Why the winner may not be applied, or null. A timing test: only once it finished, and only a leader that is not the
 * group in place. An A/B split (N3): as soon as it has a result — the same "too early" and the same "how sure" rule — and
 * only when B leads (A is what is in place); applying ends the split.
 */
export function applyHeld(test: { kind: string; status: string }, result: Pick<TestResult, 'tooEarly' | 'leaderId' | 'controlId' | 'sure'>): string | null {
  const ab = test.kind === 'AB'
  if (test.status === 'WAITING_APPROVAL' || test.status === 'DRAFT') return ab ? 'The split has not started.' : 'The test has not finished: stop it, or wait until it ends.'
  if (!ab && test.status === 'RUNNING') return 'The test has not finished: stop it, or wait until it ends.'
  if (result.tooEarly || !result.leaderId) return 'Too early to call — there is no winner yet.'
  if (result.leaderId === result.controlId) {
    return ab
      ? 'A — the rule as it is — is the best: there is nothing to apply. End the test to keep A as it is.'
      : 'The day in place now is the best: there is nothing to apply. Keep it instead.'
  }
  if ((result.sure ?? 0) < APPLY_MIN_SURE) {
    return `Only ${result.sure ?? 0}% sure — a winner can be applied at ${APPLY_MIN_SURE}% or more. ${ab ? 'Let the split run on, or end it to keep A.' : 'Keep the day in place, or run a new test.'}`
  }
  return null
}

// ── Progress and the end ─────────────────────────────────────────────────────────────────────────────────────────

/** Whether a running test has reached its end: every asked group at its orders, or its days are over. */
export function shouldFinish(test: { startedAt: Date | null; endsWhen: unknown }, arms: readonly Pick<ArmCounts, 'holdout' | 'orders'>[], now: Date): boolean {
  if (!test.startedAt) return false
  const ends = endsWhenOf(test.endsWhen)
  if (now.getTime() - test.startedAt.getTime() >= ends.maxDays * DAY_MS) return true
  const asked = arms.filter((a) => !a.holdout)
  return asked.length > 0 && asked.every((a) => a.orders >= ends.ordersPerArm)
}

/** "Running · week 2 of about 6" (from the pace so far; at most the test's last week). */
export function progressWords(test: { startedAt: Date | null; endsWhen: unknown }, arms: readonly Pick<ArmCounts, 'holdout' | 'orders'>[], now: Date): string {
  if (!test.startedAt) return 'Running'
  const ends = endsWhenOf(test.endsWhen)
  const elapsed = Math.max(0, (now.getTime() - test.startedAt.getTime()) / DAY_MS)
  const week = Math.max(1, Math.ceil(elapsed / 7))
  const lastWeek = Math.ceil(ends.maxDays / 7)
  const asked = arms.filter((a) => !a.holdout)
  const fewest = asked.length ? Math.min(...asked.map((a) => a.orders)) : 0
  if (fewest === 0 || elapsed < 1) return `Running · week ${Math.min(week, lastWeek)} · ends after ${lastWeek} weeks at the latest`
  const totalDays = Math.min(ends.maxDays, elapsed + Math.max(0, ends.ordersPerArm - fewest) / (fewest / elapsed))
  return `Running · week ${Math.min(week, lastWeek)} of about ${Math.max(week, Math.ceil(totalDays / 7))}`
}

/** The groups of a new timing test: the days asked (the day in place now first, marked), then the holdout. */
export function timingArms(days: readonly number[], currentDays: number | null, holdoutPct: number): Array<{ label: string; position: number; delayDays: number | null; holdout: boolean }> {
  const unique = [...new Set(days.map((d) => Math.round(d)))].sort((a, b) => a - b)
  const ordered = currentDays != null && unique.includes(currentDays) ? [currentDays, ...unique.filter((d) => d !== currentDays)] : unique
  const arms = ordered.map((d, i) => ({ label: d === currentDays ? `Day ${d} (now)` : `Day ${d}`, position: i, delayDays: d, holdout: false }))
  if (holdoutPct > 0) arms.push({ label: HOLDOUT_LABEL, position: arms.length, delayDays: null, holdout: true })
  return arms
}

/** "Day 4 vs 7 vs 10 · 10% holdout". */
export function groupsWords(arms: ReadonlyArray<{ label: string; delayDays: number | null; holdout: boolean; position: number }>, holdoutPct: number, kind: TestKind): string {
  const asked = arms.filter((a) => !a.holdout).sort((a, b) => a.position - b.position)
  const head = kind === 'AB'
    ? 'A against B · split 50 / 50 by order number'
    : `Day ${asked.map((a) => a.delayDays).join(' vs ')}`
  return holdoutPct > 0 ? `${head} · ${holdoutPct}% holdout` : head
}
