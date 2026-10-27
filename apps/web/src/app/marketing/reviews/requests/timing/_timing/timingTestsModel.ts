/**
 * Reviews › Requests — timing tests and A/B splits (build spec B22, PR J): the shapes `GET /api/review-timing-tests`
 * answers, the "New timing test" form, and the words and rows the Timing page, the rule editor's A/B card, the Rules
 * page and the Queue's results show. Pure: no fetch, no clock of its own. Every number and sentence about a result comes
 * from the API (how sure, too early, the words); this file only lays it out.
 */

export type TestKind = 'TIMING' | 'AB'
export type TestStatus = 'DRAFT' | 'WAITING_APPROVAL' | 'RUNNING' | 'STOPPED' | 'DONE'

export interface TimingTestArm {
  id: string
  label: string
  position: number
  holdout: boolean
  orders: number
  sent: number
  counted: number
  reviews: number
  delayDays: number | null
  ruleId: string | null
  ruleName: string | null
  rate: number | null
}

export interface TimingTestResult {
  tooEarly: boolean
  leaderId: string | null
  controlId: string | null
  sure: number | null
  liftPct: number | null
  words: string
  sureWords: string | null
  rates: Record<string, number | null>
  needMore: number
}

export interface TimingTest {
  id: string
  kind: TestKind
  channel: string
  market: string
  productType: string | null
  ruleId: string | null
  title: string
  groupsWords: string
  holdoutPct: number
  status: TestStatus
  statusWords: string
  startedAt: string | null
  endedAt: string | null
  endsWhen: { ordersPerArm: number; maxDays: number }
  endsWords: string
  arms: TimingTestArm[]
  result: TimingTestResult
  countedWords: string
  approval: { id: string; what: 'start' | 'apply' } | null
  applied: { armId: string; label: string; delayDays: number; ruleId: string; ruleName: string; created: boolean; at: string; by: string | null } | null
  kept: { at: string; by: string | null } | null
  lastWords: string | null
  applyWords: string | null
  held: { start: string | null; stop: string | null; apply: string | null; keep: string | null }
}

export interface TimingTestsAnswer { tests: TimingTest[]; running: number }
export interface TimingEstimate { currentDays: number; currentWords: string; ordersPerDay: number; endsWords: string }
/** POST answers: the test as it is now, and the approval it waits for (null when the request was refused, with why). */
export interface AskAnswer { test: TimingTest; approval: { id: string; expiresAt: string | null } | null; words: string | null }

/** Where every approval is decided. */
export const APPROVALS_PATH = '/fleet/approvals'

// ── New timing test ──────────────────────────────────────────────────────────────────────────────────────────────

export const TEST_MARKETS = [
  { value: 'IT', label: 'Amazon Italy' },
  { value: 'DE', label: 'Amazon Germany' },
  { value: 'FR', label: 'Amazon France' },
  { value: 'ES', label: 'Amazon Spain' },
  { value: 'UK', label: 'Amazon UK' },
] as const
export const DAY_CHOICES = [4, 7, 10, 14, 21] as const
export const MIN_DAYS = 2
export const MAX_DAYS = 4
export const HOLDOUT_MAX = 20

export interface NewTestForm { market: string; productType: string; days: number[]; holdoutPct: number }
export const NEW_TEST_FORM: NewTestForm = { market: 'DE', productType: '', days: [4, 7], holdoutPct: 10 }

/** Ticks or unticks a day (sorted; never more than MAX_DAYS). */
export function toggleDay(form: NewTestForm, day: number): NewTestForm {
  if (form.days.includes(day)) return { ...form, days: form.days.filter((d) => d !== day) }
  if (form.days.length >= MAX_DAYS) return form
  return { ...form, days: [...form.days, day].sort((a, b) => a - b) }
}

/** "3 groups and a 10% holdout: each group gets about 30% of the new orders." */
export function daysHint(form: NewTestForm): string {
  const n = form.days.length
  if (n < MIN_DAYS) return `Pick ${MIN_DAYS}–${MAX_DAYS} days.`
  const share = Math.round((100 - form.holdoutPct) / n)
  return `${n} groups${form.holdoutPct > 0 ? ` and a ${form.holdoutPct}% holdout` : ''}: each group gets about ${share}% of the new orders, by order number.`
}

/** Why "Start test — send for approval" is held, or null. */
export function newTestHeld(form: NewTestForm, ctx: { canManage: boolean; sending: boolean }): string | null {
  if (!ctx.canManage) return "You need 'Manage reviews' to start a test."
  if (ctx.sending) return 'Sending…'
  if (!form.market) return 'Pick the market to test.'
  if (form.days.length < MIN_DAYS) return `Pick at least ${MIN_DAYS} days to compare.`
  return null
}

export function newTestBody(form: NewTestForm): { market: string; productType: string | null; days: number[]; holdoutPct: number } {
  return { market: form.market, productType: form.productType.trim() ? form.productType.trim().toLowerCase() : null, days: [...form.days], holdoutPct: form.holdoutPct }
}

// ── A test's card ────────────────────────────────────────────────────────────────────────────────────────────────

export type PillTone = 'info' | 'success' | 'warning' | 'neutral' | 'danger'

/** The status pill of a test. */
export function statusPill(test: Pick<TimingTest, 'status' | 'statusWords'>): { tone: PillTone; label: string } {
  switch (test.status) {
    case 'RUNNING': return { tone: 'info', label: test.statusWords }
    case 'DONE': return { tone: 'success', label: 'Finished' }
    case 'WAITING_APPROVAL': return { tone: 'warning', label: 'Waiting for approval' }
    case 'STOPPED': return { tone: 'neutral', label: 'Stopped' }
    default: return { tone: 'neutral', label: 'Not started' }
  }
}

/** "7.6%" (or "—" when no order counts yet). */
export function rateText(rate: number | null | undefined): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`
}

const n = (v: number) => v.toLocaleString('en-IE')

/** The result table of a timing test: First try · Orders · Sent · Counted · Reviews · Rate (the leader marked). */
export function armRows(test: Pick<TimingTest, 'arms' | 'result'>): Array<{ id: string; leader: boolean; cells: [string, string, string, string, string, string] }> {
  return [...test.arms].sort((a, b) => a.position - b.position).map((a) => ({
    id: a.id,
    leader: !test.result.tooEarly && test.result.leaderId === a.id,
    cells: [a.label, n(a.orders), a.holdout ? '—' : n(a.sent), n(a.counted), a.counted ? n(a.reviews) : '—', rateText(a.rate)],
  }))
}

/** One group's progress towards its orders (0–100), for the running card's bars. */
export function armProgress(arm: Pick<TimingTestArm, 'orders' | 'holdout'>, test: Pick<TimingTest, 'endsWhen' | 'holdoutPct' | 'arms'>): number {
  const asked = test.arms.filter((a) => !a.holdout).length || 1
  const target = arm.holdout
    ? Math.max(1, Math.round((test.endsWhen.ordersPerArm * asked * test.holdoutPct) / Math.max(1, 100 - test.holdoutPct)))
    : test.endsWhen.ordersPerArm
  return Math.min(100, Math.round((arm.orders / target) * 100))
}

/** "40 orders · 3 counted · 7.5%" beside a group's bar. */
export function armLine(arm: TimingTestArm): string {
  const counted = arm.counted ? ` · ${n(arm.counted)} counted · ${rateText(arm.rate)}` : ''
  return `${n(arm.orders)} ${arm.orders === 1 ? 'order' : 'orders'}${counted}`
}

/** The tests a page shows: still going (not started, waiting, running) and ended. */
export function splitTests(tests: readonly TimingTest[]): { live: TimingTest[]; ended: TimingTest[] } {
  const live = tests.filter((t) => t.status === 'DRAFT' || t.status === 'WAITING_APPROVAL' || t.status === 'RUNNING')
  return { live, ended: tests.filter((t) => !live.includes(t)) }
}

/** The day the winner would bring ("Keep day 4" uses the group in place now). */
export function keepLabel(test: Pick<TimingTest, 'arms' | 'result'>): string {
  const control = test.arms.find((a) => a.id === test.result.controlId)
  return control?.delayDays != null ? `Keep day ${control.delayDays}` : 'Keep the day in place'
}

// ── A/B splits (rule editor card, Rules page, Queue results) ─────────────────────────────────────────────────────

/** A rule's A/B split: the one still going, else the latest that ended (null when it never had one). */
export function abTestOf(tests: readonly TimingTest[], ruleId: string): TimingTest | null {
  const mine = tests.filter((t) => t.kind === 'AB' && (t.ruleId === ruleId || t.arms.some((a) => a.ruleId === ruleId)))
  return splitTests(mine).live[0] ?? mine[0] ?? null
}

/** "A · Germany jackets (this)" for the card's Side column. */
export function sideLabel(arm: TimingTestArm, thisRuleId: string | null): string {
  return `${arm.label} · ${arm.ruleName ?? 'deleted rule'}${arm.ruleId === thisRuleId ? ' (this)' : ''}`
}

/** The A/B card's rows: Side · Sent · Counted · Rate. */
export function abRows(test: TimingTest, thisRuleId: string | null): Array<{ id: string; cells: [string, string, string, string] }> {
  return [...test.arms].sort((a, b) => a.position - b.position).map((a) => ({ id: a.id, cells: [sideLabel(a, thisRuleId), n(a.sent), n(a.counted), rateText(a.rate)] }))
}

/** "About 120 more orders per side to go" (null once it can be called). */
export function needMoreWords(test: Pick<TimingTest, 'result' | 'kind' | 'status'>): string | null {
  // An ended test gets no new orders: nothing is "to go" (the API's words say so).
  if (test.status === 'STOPPED' || test.status === 'DONE') return null
  if (!test.result.tooEarly || test.result.needMore <= 0) return null
  return `About ${n(test.result.needMore)} more counted orders per ${test.kind === 'AB' ? 'side' : 'group'} to go.`
}

/** The Rules page's A/B mark for a rule: its side and the split's state, from the real tests. */
export function abBadge(ruleId: string, tests: readonly TimingTest[]): { side: string; state: string; tone: PillTone } | null {
  const test = abTestOf(tests, ruleId)
  if (!test) return null
  const side = test.ruleId === ruleId ? 'A' : 'B'
  const state = test.status === 'RUNNING' ? 'running' : test.status === 'WAITING_APPROVAL' ? 'waiting for approval' : test.status === 'DRAFT' ? 'not started' : 'ended'
  return { side, state, tone: test.status === 'RUNNING' ? 'info' : test.status === 'WAITING_APPROVAL' ? 'warning' : 'neutral' }
}

/** The Rules page's "A/B tests" tile. */
export function abTile(tests: readonly TimingTest[]): { value: string; hint: string } {
  const ab = tests.filter((t) => t.kind === 'AB')
  const running = ab.filter((t) => t.status === 'RUNNING')
  const waiting = ab.filter((t) => t.status === 'WAITING_APPROVAL').length
  if (ab.length === 0) return { value: '0', hint: 'none yet · Duplicate as A/B, then start it' }
  const parts = [`${running.length} running`]
  if (waiting) parts.push(`${waiting} waiting for approval`)
  const ended = ab.length - running.length - waiting
  if (ended > 0) parts.push(`${ended} ended`)
  return { value: String(running.length), hint: parts.join(' · ') }
}

/** The Queue results' A/B rows: split · A · B · result. */
export function abResultRows(tests: readonly TimingTest[]): Array<{ id: string; cells: [string, string, string, string] }> {
  return tests.filter((t) => t.kind === 'AB' && t.status !== 'DRAFT').map((t) => {
    const [a, b] = [...t.arms].sort((x, y) => x.position - y.position)
    const side = (arm: TimingTestArm | undefined) => (arm ? `${n(arm.sent)} sent · ${rateText(arm.rate)}` : '—')
    const state = t.status === 'RUNNING' ? '' : t.status === 'WAITING_APPROVAL' ? 'Waiting for approval — ' : 'Ended — '
    return { id: t.id, cells: [t.title, side(a), side(b), t.status === 'WAITING_APPROVAL' ? 'Waiting for approval' : `${state}${t.result.words}`] }
  })
}

// ── Starting an A/B split (the rule editor's card) ────────────────────────────────────────────────────────────────

/** The rule fields the A/B card reads (a RuleItem of the rules list). */
export interface AbRule {
  id: string
  name: string
  scope: string
  marketplace: string | null
  isActive: boolean
  minDaysSinceDelivery: number
  maxDaysSinceDelivery: number
  sendDelayDays?: number | null
  anchor?: string | null
  sendHourLocal?: number | null
  skipWeekends?: boolean
  shiftToBestDay?: boolean
  useSentimentDiversion?: boolean
  fallbackOnNoResponse?: boolean
}

const VARIANT = /^(.*) \(variant \d+\)$/

/** A rule's other side: for A its first "Duplicate as A/B" copy (B), for a copy its A. Null when there is none. */
export function abPartner<T extends Pick<AbRule, 'id' | 'name' | 'scope' | 'marketplace'>>(rule: T, rules: readonly T[]): { a: T; b: T } | null {
  const v = VARIANT.exec(rule.name)
  const same = (r: T) => r.scope === rule.scope && (r.marketplace ?? null) === (rule.marketplace ?? null)
  if (v) {
    const a = rules.find((r) => r.name === v[1] && same(r))
    return a ? { a, b: rule } : null
  }
  const b = rules.find((r) => r.id !== rule.id && VARIANT.exec(r.name)?.[1] === rule.name && same(r))
  return b ? { a: rule, b } : null
}

const TIMING_KEYS = ['sendDelayDays', 'anchor', 'sendHourLocal', 'skipWeekends', 'shiftToBestDay', 'minDaysSinceDelivery', 'maxDaysSinceDelivery', 'useSentimentDiversion', 'fallbackOnNoResponse'] as const

/** Why "Start A/B test — send for approval" is held, or null (the API checks the same again). */
export function abStartHeld(pair: { a: AbRule; b: AbRule }, ctx: { canManage: boolean; unsaved: number; live: TimingTest | null; sending: boolean }): string | null {
  if (!ctx.canManage) return "You need 'Manage reviews' to start a test."
  if (ctx.unsaved > 0) return 'Save your changes first — the split uses the saved rules.'
  if (ctx.live) return ctx.live.status === 'WAITING_APPROVAL' ? 'This split already waits for approval.' : 'This split is already running.'
  if (ctx.sending) return 'Sending…'
  if (!pair.a.isActive) return `Turn “${pair.a.name}” (side A) on first: the split takes the orders it decides.`
  if (pair.b.isActive) return `Turn “${pair.b.name}” (side B) off first: during the split it gets half of A’s orders.`
  const same = TIMING_KEYS.every((k) => JSON.stringify(pair.a[k] ?? null) === JSON.stringify(pair.b[k] ?? null))
  if (same) return `“${pair.b.name}” has the same timing as A. Change B’s first try, send hour or window first.`
  return null
}

/** "Day 7 after delivery · 10:00" — what a side does, for the card before a split starts. */
export function sideTimingWords(rule: AbRule): string {
  const day = rule.sendDelayDays != null ? `Day ${rule.sendDelayDays}` : 'Day from the product-type table'
  const hour = rule.sendHourLocal != null ? ` · ${String(rule.sendHourLocal).padStart(2, '0')}:00` : ''
  const extra = [rule.skipWeekends ? 'skips weekends' : '', rule.shiftToBestDay ? 'best day' : '', rule.useSentimentDiversion ? '“How was it?” first' : ''].filter(Boolean)
  return `${day}${hour}${extra.length ? ` · ${extra.join(' · ')}` : ''} · window day ${rule.minDaysSinceDelivery}–${rule.maxDaysSinceDelivery}`
}
