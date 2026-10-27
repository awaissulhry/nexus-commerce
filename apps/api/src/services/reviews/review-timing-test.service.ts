/**
 * Reviews PR J (2026-10-27, build spec B22) — timing tests and the A/B split of review requests.
 *
 *   createTimingTest()    POST /api/review-timing-tests           a TIMING test (Amazon market, product type, 2–4 first-try
 *                                                                   days, holdout %) — made, then sent for approval
 *   createAbTest()        POST /api/review-timing-tests/ab        an A/B split of rule A and its copy B — made, then sent
 *   startTimingTest()     POST /api/review-timing-tests/:id/start "Start test": asks for approval again (a declined one)
 *   stopTimingTest()      POST /api/review-timing-tests/:id/stop  "Stop test" / "End test": ends it AT ONCE (no approval:
 *                                                                   it only stops a test; nothing new is sent by it)
 *   applyTimingWinner()   POST /api/review-timing-tests/:id/apply "Apply winner": asks for approval
 *   keepCurrentDay()      POST /api/review-timing-tests/:id/keep  "Keep day 4": records the decision, changes nothing
 *   listTimingTests()     GET  /api/review-timing-tests           every test with its groups, counts, result and words
 *   estimateTimingTest()  GET  /api/review-timing-tests/estimate  the day in place now and the pace of a market
 *
 * A test changes which buyers are asked and when, so it RUNS only after a person approved "Start test" on the Approvals
 * page (the tool `start-review-timing-test`, agents/tools/review-timing-tests.tools.ts, through approval-gate.service.ts
 * requestApproval — the same door as every other change). Applying a winner changes a rule, so it is approved too
 * (`apply-review-timing-winner`). Nothing changes before a person approves.
 *
 * While a test runs, the scheduler (review-scheduler.service.ts) puts each new order it covers in a group by its order
 * number (review-timing-test-math.ts assignArm); the holdout group's request is SKIPPED (not asked on purpose), the other
 * groups use their first-try day (TIMING) or their rule (AB). The counts per group come from those requests; reviews
 * per group are counted as the ONE review rate counts them (review-rate.service.ts): a visible review the attribution
 * linked to the group's request; for the holdout (never sent, so never linked) the attribution's own rule applied to
 * the day it would have been asked — a review naming the order, else one for the same product in the same channel and
 * market — within the same 30 days (ATTRIBUTION_DAYS). Where no review can follow in the test's channel and market
 * (`rateMeasurable`: e.g. no Amazon review of that market imported) the result says "Not measurable" in the rate's own
 * words, never a 0 %. Amazon does not say who wrote a review, so every rate is an estimate, and the words say so.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { UserPrincipal } from '../agents/call-tool.js'
import { channelMarketLabel, marketWords } from './overviewMath.js'
import { shortDate } from './review-queue-words.js'
import { DEFAULT_DELAY_DAYS, lookupTimingTable, type TimingDefaultRow } from './review-timing.service.js'
import {
  ANSWER_DAYS,
  DAY_CHOICES,
  FIRST_DAY,
  HOLDOUT_MAX,
  LAST_DAY,
  LIVE_STATUSES,
  MAX_ARMS,
  MAX_DAYS_MAX,
  MAX_DAYS_MIN,
  MIN_ARMS,
  ORDERS_PER_ARM_MAX,
  ORDERS_PER_ARM_MIN,
  applyHeld,
  endsWhenOf,
  endsWords,
  groupsWords,
  progressWords,
  shouldFinish,
  testResult,
  timingArms,
  type ArmCounts,
  type EndsWhen,
  type TestKind,
  type TestResult,
} from './review-timing-test-math.js'
import { visibleReviewWhere } from './review-visibility.js'
import { notMeasurableWords, rateKey, rateMeasurable, readRateFacts, type RateFacts } from './review-rate.service.js'

/** The approved tools (agents/tools/review-timing-tests.tools.ts). */
export const START_TOOL = 'start-review-timing-test'
export const APPLY_TOOL = 'apply-review-timing-winner'
/** The arm id `apply-review-timing-winner` takes to put back what was there before a winner was applied. */
export const BEFORE_ARM = 'before'

const DAY_MS = 24 * 60 * 60 * 1000
/** An A/B side's latest first try (a rule's window ends by day 30), for when its orders' time to answer is over. */
const AB_LAST_TRY_DAY = 30
const SCOPE_CHANNEL: Record<string, string> = {
  AMAZON_PER_MARKETPLACE: 'AMAZON', AMAZON_GLOBAL: 'AMAZON', EBAY: 'EBAY', SHOPIFY: 'SHOPIFY', WOOCOMMERCE: 'WOOCOMMERCE', ETSY: 'ETSY', MANUAL: 'MANUAL',
}
/** The channels the scheduler asks (an A/B split of another channel's rule would split nothing; eBay asks its own buyers). */
const ASKED_CHANNELS = ['AMAZON', 'SHOPIFY']

export class TimingTestInputError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const testInclude = { arms: { orderBy: { position: 'asc' as const } } }
type TestRow = Prisma.ReviewTimingTestGetPayload<{ include: typeof testInclude }>
type ArmRow = TestRow['arms'][number]

/** What the test's `result` json keeps between reads. */
export interface StoredResult {
  /** The last counts read, and the result on them (kept when a test ends, so its card shows without a new read). */
  last?: { at: string; arms: ArmCounts[]; result: TestResult } | null
  /** "Apply winner" waits for this approval. */
  applyApprovalId?: string | null
  /** Why the last "Apply winner" did not go through, in words. */
  applyWords?: string | null
  applied?: AppliedWinner | null
  kept?: { at: string; by: string | null } | null
}

export interface AppliedWinner {
  armId: string
  label: string
  delayDays: number
  ruleId: string
  ruleName: string
  /** True when applying added the rule (an undo turns it off); false when it changed a rule's first try. */
  created: boolean
  /** The rule as it was before: an undo puts it back. */
  before: { sendDelayDays: number | null; minDays: number; maxDays: number; isActive: boolean }
  at: string
  by: string | null
}

export const storedOf = (row: { result: unknown }): StoredResult => ((row.result ?? {}) as StoredResult)
const asJson = (v: unknown) => v as Prisma.InputJsonValue

// ── Who is covered (the scheduler) ───────────────────────────────────────────────────────────────────────────────

export interface RunningTest {
  id: string
  kind: TestKind
  channel: string
  market: string
  productType: string | null
  ruleId: string | null
  holdoutPct: number
  startedAt: Date | null
  arms: Array<{ id: string; position: number; holdout: boolean; delayDays: number | null; ruleId: string | null }>
}

/** The tests running now, oldest first, with their groups — the scheduler reads them once per run. */
export async function runningTimingTests(now = new Date()): Promise<RunningTest[]> {
  await finishDueTests(now).catch((err) => logger.warn('[timing-tests] could not finish due tests', { error: err instanceof Error ? err.message : String(err) }))
  const rows = await prisma.reviewTimingTest.findMany({ where: { status: 'RUNNING' }, include: testInclude, orderBy: { startedAt: 'asc' } })
  return rows.map((r) => ({
    id: r.id, kind: r.kind as TestKind, channel: r.channel, market: r.market, productType: r.productType, ruleId: r.ruleId,
    holdoutPct: r.holdoutPct, startedAt: r.startedAt,
    arms: r.arms.map((a) => ({ id: a.id, position: a.position, holdout: a.holdout, delayDays: a.delayDays, ruleId: a.ruleId })),
  }))
}

/** Does the product type word cover the order's product type (as a rule's product types do)? */
function typeCovers(word: string | null, productType: string | null): boolean {
  if (!word) return true
  return (productType ?? '').toLowerCase().includes(word.toLowerCase())
}

/**
 * The running test that covers an order, or null. A TIMING test covers its channel market (and product type); an AB
 * test covers the orders its rule A decides. With two (they are not meant to overlap), the one started first.
 */
export function testForOrder(tests: readonly RunningTest[], order: { channel: string; marketplace: string | null; productType: string | null }, decidingRuleId: string | null): RunningTest | null {
  for (const t of tests) {
    if (t.kind === 'AB') {
      if (t.ruleId && decidingRuleId === t.ruleId) return t
      continue
    }
    if (t.channel !== order.channel) continue
    if ((order.marketplace ?? '').toUpperCase() !== t.market.toUpperCase()) continue
    if (!typeCovers(t.productType, order.productType)) continue
    return t
  }
  return null
}

// ── Counts and the result ────────────────────────────────────────────────────────────────────────────────────────

/** The day an order's time to answer is over, in days after delivery (the same for every group of a test). */
function horizonDays(test: Pick<TestRow, 'kind'> & { arms: Array<Pick<ArmRow, 'delayDays'>> }): number {
  if (test.kind === 'AB') return AB_LAST_TRY_DAY + ANSWER_DAYS
  const days = test.arms.map((a) => a.delayDays ?? 0)
  return Math.max(FIRST_DAY, ...days) + ANSWER_DAYS
}

const chunks = <T>(list: readonly T[], size = 5000): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** The counts of every group of a test, from the requests the scheduler put in them. */
export async function readArmCounts(test: TestRow, now = new Date()): Promise<ArmCounts[]> {
  const armIds = test.arms.map((a) => a.id)
  const rows = armIds.length
    ? await prisma.reviewRequest.findMany({
        where: { timingTestArmId: { in: armIds } },
        select: {
          id: true, orderId: true, status: true, timingTestArmId: true, scheduledFor: true, channel: true, marketplace: true,
          order: { select: { deliveredAt: true, items: { take: 1, select: { productId: true } } } },
        },
        take: 50_000,
      })
    : []
  const horizon = horizonDays(test) * DAY_MS
  const counted = (r: (typeof rows)[number]) => !!r.order?.deliveredAt && now.getTime() - r.order.deliveredAt.getTime() >= horizon

  // Reviews linked to a group's sent request (the attribution).
  const reviewed = new Set<string>()
  const sentIds = rows.filter((r) => r.status === 'SENT').map((r) => r.id)
  for (const ids of chunks(sentIds)) {
    const linked = await prisma.review.findMany({ where: visibleReviewWhere({ attributedRequestId: { in: ids } }), select: { attributedRequestId: true } })
    for (const l of linked) if (l.attributedRequestId) reviewed.add(l.attributedRequestId)
  }

  // The holdout (never sent, so never linked): the attribution's own rule (review-attribution.service.ts) applied to the
  // day the order would have been asked — a review naming the order (eBay feedback, Amazon seller feedback), else a review
  // no request explains for the same product in the same channel and market — within the same window. Each review counts
  // for one order at most.
  const holdoutIds = new Set(test.arms.filter((a) => a.holdout).map((a) => a.id))
  const held = rows
    .filter((r) => r.timingTestArmId && holdoutIds.has(r.timingTestArmId))
    .map((r) => ({ id: r.id, orderId: r.orderId, channel: r.channel, market: r.marketplace, productId: r.order?.items[0]?.productId ?? null, start: r.scheduledFor ?? r.order?.deliveredAt ?? null }))
    .filter((r): r is { id: string; orderId: string; channel: string; market: string | null; productId: string | null; start: Date } => !!r.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  if (held.length) {
    const from = held[0].start
    const to = new Date(held[held.length - 1].start.getTime() + ANSWER_DAYS * DAY_MS)
    type Candidate = { id: string; orderId: string | null; productId: string | null; channel: string; marketplace: string | null; postedAt: Date }
    const select = { id: true, orderId: true, productId: true, channel: true, marketplace: true, postedAt: true } as const
    const byOrder: Candidate[] = []
    for (const ids of chunks([...new Set(held.map((h) => h.orderId))], 1000)) {
      byOrder.push(...await prisma.review.findMany({
        where: visibleReviewWhere({ orderId: { in: ids }, postedAt: { gte: from, lte: to } }),
        select,
        orderBy: { postedAt: 'asc' },
      }))
    }
    const byProduct: Candidate[] = []
    for (const ids of chunks([...new Set(held.map((h) => h.productId).filter((v): v is string => !!v))], 1000)) {
      byProduct.push(...await prisma.review.findMany({
        where: visibleReviewWhere({ attributedRequestId: null, orderId: null, productId: { in: ids }, postedAt: { gte: from, lte: to } }),
        select,
        orderBy: { postedAt: 'asc' },
      }))
    }
    const used = new Set<string>()
    const inWindow = (c: Candidate, h: (typeof held)[number]) => c.postedAt.getTime() >= h.start.getTime() && c.postedAt.getTime() <= h.start.getTime() + ANSWER_DAYS * DAY_MS
    for (const h of held) {
      const hit = byOrder.find((c) => !used.has(c.id) && c.orderId === h.orderId && inWindow(c, h))
        ?? (h.productId
          ? byProduct.find((c) => !used.has(c.id) && c.productId === h.productId && c.channel === h.channel && (c.marketplace ?? '') === (h.market ?? '') && inWindow(c, h))
          : undefined)
      if (hit) {
        used.add(hit.id)
        reviewed.add(h.id)
      }
    }
  }

  return test.arms.map((a) => {
    const mine = rows.filter((r) => r.timingTestArmId === a.id)
    const c = mine.filter(counted)
    return {
      id: a.id, label: a.label, position: a.position, holdout: a.holdout,
      orders: mine.length,
      sent: mine.filter((r) => r.status === 'SENT').length,
      counted: c.length,
      reviews: c.filter((r) => reviewed.has(r.id)).length,
    }
  })
}

/** Keeps the groups' counters in step with what was read (cheap; only what moved is written). */
async function storeArmCounts(test: TestRow, counts: readonly ArmCounts[]): Promise<void> {
  for (const c of counts) {
    const arm = test.arms.find((a) => a.id === c.id)
    if (!arm || (arm.orders === c.orders && arm.sent === c.sent && arm.reviews === c.reviews)) continue
    await prisma.reviewTimingTestArm.updateMany({ where: { id: c.id }, data: { orders: c.orders, sent: c.sent, reviews: c.reviews } })
  }
}

/** "in Germany" for a TIMING test (null for an A/B split, which names its sides instead). */
const whereWords = (test: Pick<TestRow, 'kind' | 'market'>) => (test.kind === 'TIMING' && marketWords(test.market) ? `in ${marketWords(test.market)}` : undefined)

/**
 * Can a review follow this test's requests at all — the ONE review rate's `rateMeasurable` for its channel and market
 * (an A/B split of an all-markets rule: any market of its channel).
 */
export function testMeasurable(test: Pick<TestRow, 'channel' | 'market'>, facts: RateFacts): boolean {
  if (test.market !== '*') return rateMeasurable(test.channel, test.market, facts)
  if (test.channel.toUpperCase() === 'EBAY') return facts.ebayLinked
  const prefix = rateKey(test.channel, '') // "AMAZON|": every market of the channel
  return [...facts.reviewedKeys].some((k) => k.startsWith(prefix))
}

/** The result when no review can follow: no leader, no rates, the ONE rate's words (never a 0 %). */
export function notMeasurableResult(test: Pick<TestRow, 'channel'>, arms: readonly ArmCounts[], base: TestResult): TestResult {
  return {
    ...base,
    tooEarly: true, leaderId: null, sure: null, liftPct: null, sureWords: null,
    rates: Object.fromEntries(arms.map((a) => [a.id, null])),
    words: notMeasurableWords([{ channel: test.channel }]),
  }
}

/** The result of one test now (counts read, counters kept). */
export async function resultOf(test: TestRow, now = new Date()): Promise<{ arms: ArmCounts[]; result: TestResult }> {
  const [arms, facts] = await Promise.all([readArmCounts(test, now), readRateFacts()])
  await storeArmCounts(test, arms).catch(() => undefined)
  const result = testResult(arms, { where: whereWords(test), kind: test.kind as TestKind, ended: test.status === 'STOPPED' || test.status === 'DONE' })
  return { arms, result: testMeasurable(test, facts) ? result : notMeasurableResult(test, arms, result) }
}

// ── The end of a test ────────────────────────────────────────────────────────────────────────────────────────────

/** Running tests that reached their end become DONE; an A/B split whose rule is gone stops. Returns how many moved. */
export async function finishDueTests(now = new Date()): Promise<number> {
  const running = await prisma.reviewTimingTest.findMany({ where: { status: 'RUNNING' }, include: testInclude })
  if (running.length === 0) return 0
  let moved = 0
  const ruleIds = [...new Set(running.flatMap((t) => [t.ruleId, ...t.arms.map((a) => a.ruleId)]).filter((v): v is string => !!v))]
  const rules = ruleIds.length ? await prisma.reviewRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true } }) : []
  const exists = new Set(rules.map((r) => r.id))
  const counts = await prisma.reviewRequest.groupBy({ by: ['timingTestArmId'], where: { timingTestArmId: { in: running.flatMap((t) => t.arms.map((a) => a.id)) } }, _count: { _all: true } })
  const ordersOf = new Map(counts.map((c) => [c.timingTestArmId, c._count._all]))
  for (const t of running) {
    const missing = t.kind === 'AB' && [t.ruleId, ...t.arms.map((a) => a.ruleId)].some((id) => !!id && !exists.has(id))
    const arms = t.arms.map((a) => ({ holdout: a.holdout, orders: ordersOf.get(a.id) ?? 0 }))
    if (!missing && !shouldFinish(t, arms, now)) continue
    const last = await resultOf(t, now).catch(() => null)
    const done = await prisma.reviewTimingTest.updateMany({
      where: { id: t.id, status: 'RUNNING' },
      data: {
        status: missing ? 'STOPPED' : 'DONE',
        endedAt: now,
        ...(missing ? { lastWords: 'A rule of this split was deleted, so the test stopped. The other side keeps running as a normal rule.' } : {}),
        result: asJson({ ...storedOf(t), last: last ? { at: now.toISOString(), ...last } : storedOf(t).last ?? null }),
      },
    })
    moved += done.count
  }
  return moved
}

// ── Approvals ────────────────────────────────────────────────────────────────────────────────────────────────────

type Requester = (tool: string, args: Record<string, unknown>, person: UserPrincipal) => Promise<{
  ok: boolean
  mode: string
  approvalId?: string
  expiresAt?: Date | null
  error?: string
}>

async function defaultRequester(): Promise<Requester> {
  const { requestApproval } = await import('../agents/approval-gate.service.js')
  return requestApproval as Requester
}

const approvalWords = (a: { status: string; reason: string | null; decidedBy: string | null }, what: string): string | null => {
  if (a.status === 'rejected') {
    if ((a.reason ?? '').startsWith('withdrawn')) return `The request to ${what} was withdrawn before anyone approved it.`
    return `The request to ${what} was declined on the Approvals page${a.decidedBy ? ` by ${a.decidedBy}` : ''}.`
  }
  if (a.status === 'expired') return `Nobody approved the request to ${what} before it expired.`
  if (a.status === 'pending' && (a.reason ?? '').startsWith('execution failed')) return `The approved request to ${what} did not run: ${a.reason!.replace(/^execution failed:\s*/, '')}`
  return null
}

/**
 * Every test follows its approvals on each read: a declined, expired or withdrawn start sends the test back to "not
 * started" with why; an approved start that failed to run says so (it still waits); a declined or expired "Apply winner"
 * is cleared with why. Returns how many tests moved.
 */
export async function syncTimingTestApprovals(): Promise<number> {
  const rows = (await prisma.reviewTimingTest.findMany({ where: { status: { in: ['WAITING_APPROVAL', 'DONE', 'STOPPED'] } }, include: testInclude, take: 200 }))
    .filter((r) => (r.status === 'WAITING_APPROVAL' && !!r.approvalId) || !!storedOf(r).applyApprovalId)
  const ids = [...new Set(rows.flatMap((r) => [r.status === 'WAITING_APPROVAL' ? r.approvalId : null, storedOf(r).applyApprovalId ?? null]).filter((v): v is string => !!v))]
  if (ids.length === 0) return 0
  const approvals = await prisma.agentApproval.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, reason: true, decidedBy: true } })
  const byId = new Map(approvals.map((a) => [a.id, a]))
  let moved = 0
  for (const r of rows) {
    if (r.status === 'WAITING_APPROVAL' && r.approvalId) {
      const a = byId.get(r.approvalId)
      if (!a || a.status === 'rejected' || a.status === 'expired') {
        const words = a ? approvalWords(a, 'start it') : 'Its approval request is gone: send it again.'
        const done = await prisma.reviewTimingTest.updateMany({ where: { id: r.id, status: 'WAITING_APPROVAL', approvalId: r.approvalId }, data: { status: 'DRAFT', approvalId: null, lastWords: words } })
        moved += done.count
      } else if (a.status === 'pending' && (a.reason ?? '').startsWith('execution failed')) {
        const words = `${approvalWords(a, 'start it')} It still waits on the Approvals page.`
        if (words !== r.lastWords) await prisma.reviewTimingTest.updateMany({ where: { id: r.id }, data: { lastWords: words } })
      }
    }
    const stored = storedOf(r)
    if (stored.applyApprovalId) {
      const a = byId.get(stored.applyApprovalId)
      if (!a || a.status === 'rejected' || a.status === 'expired' || a.status === 'executed') {
        const words = !a ? 'Its approval request is gone: send it again.' : a.status === 'executed' ? stored.applyWords ?? null : approvalWords(a, 'apply the winner')
        await prisma.reviewTimingTest.updateMany({ where: { id: r.id }, data: { result: asJson({ ...stored, applyApprovalId: null, applyWords: words }) } })
        moved += 1
      } else if (a.status === 'pending' && (a.reason ?? '').startsWith('execution failed')) {
        const words = `${approvalWords(a, 'apply the winner')} It still waits on the Approvals page.`
        if (words !== stored.applyWords) await prisma.reviewTimingTest.updateMany({ where: { id: r.id }, data: { result: asJson({ ...stored, applyWords: words }) } })
      }
    }
  }
  return moved
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TimingTestArmView extends ArmCounts {
  delayDays: number | null
  ruleId: string | null
  ruleName: string | null
  rate: number | null
}

export interface TimingTestView {
  id: string
  kind: TestKind
  channel: string
  market: string
  productType: string | null
  ruleId: string | null
  /** "Amazon Germany · gloves", "Rule “Germany jackets” · A/B". */
  title: string
  /** "Day 4 vs 7 vs 10 · 10% holdout". */
  groupsWords: string
  holdoutPct: number
  status: string
  /** "Waiting for approval", "Running · week 2 of about 6", "Finished 19 Oct", "Stopped 14 Oct by …". */
  statusWords: string
  startedAt: string | null
  endedAt: string | null
  endsWhen: EndsWhen
  endsWords: string
  arms: TimingTestArmView[]
  result: TestResult
  /** "Counted: orders whose time to answer is over (delivered more than 35 days ago) …". */
  countedWords: string
  approval: { id: string; what: 'start' | 'apply' } | null
  applied: AppliedWinner | null
  kept: { at: string; by: string | null } | null
  lastWords: string | null
  applyWords: string | null
  held: { start: string | null; stop: string | null; apply: string | null; keep: string | null }
}

function titleOf(t: Pick<TestRow, 'kind' | 'channel' | 'market' | 'productType'>, ruleName: string | null): string {
  if (t.kind === 'AB') return ruleName ? `“${ruleName}” · A/B split` : 'A/B split'
  const where = channelMarketLabel(t.channel, t.market)
  return t.productType ? `${where} · ${t.productType}` : `${where} · every product`
}

function statusWords(t: TestRow, counts: readonly ArmCounts[], now: Date): string {
  const tz = 'Europe/Rome'
  switch (t.status) {
    case 'DRAFT': return 'Not started'
    case 'WAITING_APPROVAL': return 'Waiting for approval'
    case 'RUNNING': return progressWords(t, counts, now)
    case 'DONE': return t.endedAt ? `Finished ${shortDate(t.endedAt, tz)}` : 'Finished'
    case 'STOPPED': return `Stopped${t.endedAt ? ` ${shortDate(t.endedAt, tz)}` : ''}${t.stoppedBy ? ` by ${t.stoppedBy}` : ''}`
    default: return t.status
  }
}

/** The held reasons of a test's actions (the page shows them on the buttons). */
function heldOf(t: TestRow, stored: StoredResult, result: TestResult, overlap: string | null): TimingTestView['held'] {
  const ended = t.status === 'STOPPED' || t.status === 'DONE'
  const start = t.status === 'WAITING_APPROVAL'
    ? 'Waits for approval on the Approvals page.'
    : t.status !== 'DRAFT' ? (ended ? 'This test has ended. Make a new one to test again.' : 'The test is running.') : overlap
  const stop = ended ? 'This test has ended.' : null
  let apply: string | null
  if (stored.applied) apply = `Applied ${shortDate(new Date(stored.applied.at))}: “${stored.applied.ruleName}” asks on day ${stored.applied.delayDays}.`
  else if (stored.kept) apply = `You kept the day in place on ${shortDate(new Date(stored.kept.at))}.`
  else if (stored.applyApprovalId) apply = 'Waits for approval on the Approvals page.'
  else apply = applyHeld(t, result)
  const keep = !ended ? 'The test has not finished.' : stored.applied ? 'The winner was applied.' : stored.kept ? 'Already kept.' : stored.applyApprovalId ? 'Applying the winner waits for approval.' : null
  return { start, stop, apply, keep }
}

async function ruleNames(ids: readonly string[]): Promise<Map<string, { name: string; isActive: boolean }>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.reviewRule.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, isActive: true } })
  return new Map(rows.map((r) => [r.id, { name: r.name, isActive: r.isActive }]))
}

async function viewOf(t: TestRow, names: Map<string, { name: string; isActive: boolean }>, live: readonly TestRow[], now: Date): Promise<TimingTestView> {
  const stored = storedOf(t)
  // A test that never ran has no counts to read.
  const read = t.startedAt ? await resultOf(t, now) : { arms: t.arms.map((a) => ({ id: a.id, label: a.label, position: a.position, holdout: a.holdout, orders: 0, sent: 0, counted: 0, reviews: 0 })), result: testResult([], { kind: t.kind as TestKind }) }
  const overlap = t.status === 'DRAFT' ? overlapHeld(t, live.filter((o) => o.id !== t.id), names) : null
  const ends = endsWhenOf(t.endsWhen)
  const approvalId = t.status === 'WAITING_APPROVAL' && t.approvalId ? t.approvalId : stored.applyApprovalId ?? null
  return {
    id: t.id, kind: t.kind as TestKind, channel: t.channel, market: t.market, productType: t.productType, ruleId: t.ruleId,
    title: titleOf(t, t.ruleId ? names.get(t.ruleId)?.name ?? null : null),
    groupsWords: groupsWords(t.arms, t.holdoutPct, t.kind as TestKind),
    holdoutPct: t.holdoutPct,
    status: t.status,
    statusWords: statusWords(t, read.arms, now),
    startedAt: t.startedAt?.toISOString() ?? null,
    endedAt: t.endedAt?.toISOString() ?? null,
    endsWhen: ends,
    endsWords: endsWords(ends, t.kind as TestKind),
    arms: t.arms.map((a) => {
      const c = read.arms.find((x) => x.id === a.id)!
      return { ...c, delayDays: a.delayDays, ruleId: a.ruleId, ruleName: a.ruleId ? names.get(a.ruleId)?.name ?? null : null, rate: read.result.rates[a.id] ?? null }
    }),
    result: read.result,
    countedWords: `Counted: orders whose time to answer is over (delivered more than ${horizonDays(t)} days ago). A group's rate is its reviews per counted order (the holdout is never asked, so orders are compared, not requests), each review matched as the review rate matches it; newer orders count as their time ends. Amazon does not say who wrote a review, so rates are estimates.`,
    approval: approvalId ? { id: approvalId, what: t.status === 'WAITING_APPROVAL' ? 'start' : 'apply' } : null,
    applied: stored.applied ?? null,
    kept: stored.kept ?? null,
    lastWords: t.lastWords,
    applyWords: stored.applyWords ?? null,
    held: heldOf(t, stored, read.result, overlap),
  }
}

/** Every test (newest first), each with its groups, counts, result and words. `ruleId` = the A/B splits of a rule. */
export async function listTimingTests(filter: { kind?: string; ruleId?: string } = {}, now = new Date()): Promise<{ tests: TimingTestView[]; running: number }> {
  await syncTimingTestApprovals().catch((err) => logger.warn('[timing-tests] approval sync failed', { error: err instanceof Error ? err.message : String(err) }))
  await finishDueTests(now).catch((err) => logger.warn('[timing-tests] finish failed', { error: err instanceof Error ? err.message : String(err) }))
  const where: Prisma.ReviewTimingTestWhereInput = {
    ...(filter.kind === 'TIMING' || filter.kind === 'AB' ? { kind: filter.kind } : {}),
    ...(filter.ruleId ? { OR: [{ ruleId: filter.ruleId }, { arms: { some: { ruleId: filter.ruleId } } }] } : {}),
  }
  const rows = await prisma.reviewTimingTest.findMany({ where, include: testInclude, orderBy: { createdAt: 'desc' }, take: 50 })
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] } }, include: testInclude })
  const names = await ruleNames([...rows, ...live].flatMap((t) => [t.ruleId, ...t.arms.map((a) => a.ruleId)]).filter((v): v is string => !!v))
  const tests: TimingTestView[] = []
  for (const t of rows) tests.push(await viewOf(t, names, live, now))
  return { tests, running: live.filter((t) => t.status === 'RUNNING').length }
}

// ── The day in place now (and the pace of a market) ──────────────────────────────────────────────────────────────

/** The first try an Amazon order of this market and product type gets now: its rule's own day, else the table's. */
export async function currentFirstTry(market: string, productType: string | null): Promise<{ days: number; words: string }> {
  const { decideRuleForOrder } = await import('./review-scheduler.service.js')
  const [rules, table] = await Promise.all([
    prisma.reviewRule.findMany({ where: { isActive: true } }),
    prisma.reviewTimingDefault.findMany({ where: { isActive: true } }) as Promise<TimingDefaultRow[]>,
  ])
  const { rule } = decideRuleForOrder(rules, { channel: 'AMAZON', marketplace: market, totalPrice: 1e9, fulfillmentMethod: null, hasActiveReturn: false, hasRefund: false, productType })
  const fromTable = lookupTimingTable(productType, table)
  const raw = rule?.sendDelayDays ?? fromTable ?? DEFAULT_DELAY_DAYS
  const lo = Math.max(FIRST_DAY, rule?.minDaysSinceDelivery ?? FIRST_DAY)
  const hi = Math.min(LAST_DAY, rule?.maxDaysSinceDelivery ?? LAST_DAY)
  const days = Math.min(hi, Math.max(lo, raw))
  const words = rule?.sendDelayDays != null
    ? `Day ${days} now, from the rule “${rule.name}”`
    : `Day ${days} now, from the ${fromTable != null ? 'product-type table' : 'built-in default'}${rule ? ` (rule “${rule.name}”)` : ''}`
  return { days, words }
}

/** Orders per day in a market (and product type), delivered in the last 28 days: the pace a test would run at. */
async function marketPace(market: string, productType: string | null, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 28 * DAY_MS)
  const n = await prisma.order.count({
    where: {
      channel: 'AMAZON', marketplace: market, deliveredAt: { gte: since },
      ...(productType ? { items: { some: { product: { productType: { contains: productType, mode: 'insensitive' } } } } } : {}),
    },
  })
  return n / 28
}

export interface TimingEstimate { currentDays: number; currentWords: string; ordersPerDay: number; endsWords: string }

/** For the "New timing test" card: the day in place now, and how long a test would take at this market's pace. */
export async function estimateTimingTest(q: { market?: string; productType?: string; days?: string; holdout?: string; ordersPerArm?: string; maxWeeks?: string }, now = new Date()): Promise<TimingEstimate> {
  const market = (q.market ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(market)) throw new TimingTestInputError('Pick a market.')
  const productType = q.productType?.trim() ? q.productType.trim().toLowerCase() : null
  const days = (q.days ?? '').split(',').map((d) => Number(d)).filter((d) => Number.isFinite(d) && d > 0)
  const holdout = Math.min(HOLDOUT_MAX, Math.max(0, Number(q.holdout ?? 0) || 0))
  const ends = endsWhenOf({ ordersPerArm: Number(q.ordersPerArm) || undefined, maxDays: Number(q.maxWeeks) ? Number(q.maxWeeks) * 7 : undefined })
  const [current, pace] = await Promise.all([currentFirstTry(market, productType), marketPace(market, productType, now)])
  const groups = Math.max(MIN_ARMS, days.length)
  const perGroupPerDay = pace * (1 - holdout / 100) / groups
  const name = marketWords(market) ?? market
  let paceWords: string
  if (perGroupPerDay <= 0) paceWords = `no Amazon ${name} orders were delivered in the last 4 weeks, so it would end after ${Math.round(ends.maxDays / 7)} weeks`
  else {
    const weeks = Math.ceil(Math.min(ends.maxDays, ends.ordersPerArm / perGroupPerDay) / 7)
    paceWords = `about ${weeks} ${weeks === 1 ? 'week' : 'weeks'} at ${name}’s pace (${Math.round(pace * 7)} orders a week)`
  }
  return { currentDays: current.days, currentWords: current.words, ordersPerDay: Math.round(pace * 10) / 10, endsWords: `${endsWords(ends)} — ${paceWords}` }
}

// ── Making a test ────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a test may not start while another one holds its orders, or null. */
function overlapHeld(t: Pick<TestRow, 'kind' | 'channel' | 'market' | 'productType' | 'ruleId'> & { arms: Array<Pick<ArmRow, 'ruleId'>> }, live: readonly TestRow[], names: Map<string, { name: string }>): string | null {
  const mine = [t.ruleId, ...t.arms.map((a) => a.ruleId)].filter(Boolean)
  for (const o of live) {
    const theirs = [o.ruleId, ...o.arms.map((a) => a.ruleId)].filter(Boolean)
    const words = `${titleOf(o, o.ruleId ? names.get(o.ruleId)?.name ?? null : null)} is ${o.status === 'RUNNING' ? 'running' : o.status === 'WAITING_APPROVAL' ? 'waiting for approval' : 'not started yet'}`
    if (mine.some((id) => theirs.includes(id))) return `${words} with the same rule. End it first.`
    if (t.channel !== o.channel) continue
    const sameMarket = t.market === '*' || o.market === '*' || t.market.toUpperCase() === o.market.toUpperCase()
    if (!sameMarket) continue
    if (t.kind === 'AB' || o.kind === 'AB') return `${words} on the same orders. End it first, or test another market.`
    const a = (t.productType ?? '').toLowerCase()
    const b = (o.productType ?? '').toLowerCase()
    if (!a || !b || a.includes(b) || b.includes(a)) return `${words} on the same orders. Stop it first, or pick another market or product type.`
  }
  return null
}

export interface NewTimingTestBody { market?: unknown; productType?: unknown; days?: unknown; holdoutPct?: unknown; ordersPerArm?: unknown; maxWeeks?: unknown }

/** Validates "New timing test" (throws TimingTestInputError with the first thing to fix). */
export function parseTimingBody(body: unknown): { market: string; productType: string | null; days: number[]; holdoutPct: number; endsWhen: EndsWhen } {
  const b = (body ?? {}) as NewTimingTestBody
  const market = typeof b.market === 'string' ? b.market.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(market)) throw new TimingTestInputError('Pick the Amazon market to test.')
  const productType = typeof b.productType === 'string' && b.productType.trim() ? b.productType.trim().toLowerCase().slice(0, 60) : null
  const days = Array.isArray(b.days) ? [...new Set(b.days.map((d) => Math.round(Number(d))).filter((d) => Number.isFinite(d)))].sort((x, y) => x - y) : []
  if (days.length < MIN_ARMS) throw new TimingTestInputError(`Pick at least ${MIN_ARMS} days to compare.`)
  if (days.length > MAX_ARMS) throw new TimingTestInputError(`Compare at most ${MAX_ARMS} days at once.`)
  if (days.some((d) => d < FIRST_DAY || d > LAST_DAY)) throw new TimingTestInputError(`Each day must be between day ${FIRST_DAY} and day ${LAST_DAY} after delivery (Amazon's window).`)
  const holdoutPct = Math.round(Number(b.holdoutPct ?? 0))
  if (!Number.isFinite(holdoutPct) || holdoutPct < 0 || holdoutPct > HOLDOUT_MAX) throw new TimingTestInputError(`The holdout is 0–${HOLDOUT_MAX}% of the orders.`)
  const opa = b.ordersPerArm == null ? undefined : Number(b.ordersPerArm)
  if (opa != null && (!Number.isFinite(opa) || opa < ORDERS_PER_ARM_MIN || opa > ORDERS_PER_ARM_MAX)) throw new TimingTestInputError(`A group ends at ${ORDERS_PER_ARM_MIN}–${ORDERS_PER_ARM_MAX} orders.`)
  const weeks = b.maxWeeks == null ? undefined : Number(b.maxWeeks)
  if (weeks != null && (!Number.isFinite(weeks) || weeks * 7 < MAX_DAYS_MIN || weeks * 7 > MAX_DAYS_MAX)) throw new TimingTestInputError(`A test runs ${MAX_DAYS_MIN / 7}–${MAX_DAYS_MAX / 7} weeks at most.`)
  return { market, productType, days, holdoutPct, endsWhen: endsWhenOf({ ordersPerArm: opa, maxDays: weeks != null ? weeks * 7 : undefined }) }
}

export interface AskAnswer { test: TimingTestView; approval: { id: string; expiresAt: string | null } | null; words: string | null }

/** Asks for the start of a DRAFT test (the tool's own dry run checks it again). */
async function askStart(id: string, person: UserPrincipal, requester?: Requester): Promise<{ approval: AskAnswer['approval']; words: string | null }> {
  const ask = requester ?? (await defaultRequester())
  const asked = await ask(START_TOOL, { testId: id }, person)
  if (asked.ok && asked.mode === 'queued' && asked.approvalId) {
    await prisma.reviewTimingTest.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'WAITING_APPROVAL', approvalId: asked.approvalId, lastWords: null } })
    return { approval: { id: asked.approvalId, expiresAt: asked.expiresAt ? new Date(asked.expiresAt).toISOString() : null }, words: null }
  }
  const words = asked.error ? `Not sent for approval: ${asked.error}` : 'Not sent for approval: the request was refused.'
  await prisma.reviewTimingTest.updateMany({ where: { id, status: 'DRAFT' }, data: { lastWords: words } })
  return { approval: null, words }
}

async function oneView(id: string, now = new Date()): Promise<TimingTestView> {
  const { tests } = await listTimingTests({}, now)
  const hit = tests.find((t) => t.id === id)
  if (hit) return hit
  const row = await prisma.reviewTimingTest.findUnique({ where: { id }, include: testInclude })
  if (!row) throw new TimingTestInputError('This test does not exist any more.', 404)
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] } }, include: testInclude })
  return viewOf(row, await ruleNames([row.ruleId, ...row.arms.map((a) => a.ruleId)].filter((v): v is string => !!v)), live, now)
}

/** "Start test — send for approval" of the New timing test card: the test is made (not started), then sent. */
export async function createTimingTest(body: unknown, person: UserPrincipal, opts: { requester?: Requester; now?: Date } = {}): Promise<AskAnswer> {
  const now = opts.now ?? new Date()
  const input = parseTimingBody(body)
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] } }, include: testInclude })
  const draft = { kind: 'TIMING', channel: 'AMAZON', market: input.market, productType: input.productType, ruleId: null, arms: [] as Array<{ ruleId: string | null }> }
  const overlap = overlapHeld(draft, live, await ruleNames(live.flatMap((t) => [t.ruleId]).filter((v): v is string => !!v)))
  if (overlap) throw new TimingTestInputError(overlap, 409)
  const current = await currentFirstTry(input.market, input.productType)
  const created = await prisma.reviewTimingTest.create({
    data: {
      kind: 'TIMING', channel: 'AMAZON', market: input.market, productType: input.productType, holdoutPct: input.holdoutPct,
      status: 'DRAFT', endsWhen: asJson(input.endsWhen), createdBy: person.label,
      arms: { create: timingArms(input.days, current.days, input.holdoutPct) },
    },
  })
  const asked = await askStart(created.id, person, opts.requester)
  return { test: await oneView(created.id, now), ...asked }
}

/** The rule pair of an A/B split: A and its "Duplicate as A/B" copy B (`<A> (variant N)`). */
export async function abPair(ruleId: string): Promise<{ a: Prisma.ReviewRuleGetPayload<object>; b: Prisma.ReviewRuleGetPayload<object> } | null> {
  const rule = await prisma.reviewRule.findUnique({ where: { id: ruleId } })
  if (!rule) return null
  const variant = /^(.*) \(variant \d+\)$/.exec(rule.name)
  if (variant) {
    const a = await prisma.reviewRule.findFirst({ where: { name: variant[1], scope: rule.scope, marketplace: rule.marketplace } })
    return a ? { a, b: rule } : null
  }
  const copies = await prisma.reviewRule.findMany({ where: { scope: rule.scope, marketplace: rule.marketplace, name: { startsWith: `${rule.name} (variant ` } }, orderBy: { createdAt: 'asc' } })
  const b = copies.find((c) => /^.* \(variant \d+\)$/.test(c.name) && c.name.slice(0, rule.name.length) === rule.name)
  return b ? { a: rule, b } : null
}

/** The timing fields that make B different from A (an A/B split of two equal rules compares nothing). */
const TIMING_FIELDS = ['sendDelayDays', 'anchor', 'sendHourLocal', 'skipWeekends', 'shiftToBestDay', 'minDaysSinceDelivery', 'maxDaysSinceDelivery', 'useSentimentDiversion', 'fallbackOnNoResponse'] as const

/** Why an A/B split of this pair may not start, or null. */
export function abHeld(a: { isActive: boolean; scope: string; name: string } & Record<string, unknown>, b: { isActive: boolean; name: string } & Record<string, unknown>): string | null {
  if (!ASKED_CHANNELS.includes(SCOPE_CHANNEL[a.scope] ?? '')) return `“${a.name}” asks no buyers Nexus can ask, so a split would compare nothing.`
  if (!a.isActive) return `Turn “${a.name}” (side A) on first: the split takes the orders it decides.`
  if (b.isActive) return `Turn “${b.name}” (side B) off first: during the split it gets half of A’s orders, and while it is on it decides orders by itself.`
  if (TIMING_FIELDS.every((f) => JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null))) return `“${b.name}” has the same timing as A. Change B’s first try, send hour or window first.`
  return null
}

/** "Start A/B test — send for approval" of the rule editor's A/B card: the split is made (not started), then sent. */
export async function createAbTest(body: unknown, person: UserPrincipal, opts: { requester?: Requester; now?: Date } = {}): Promise<AskAnswer> {
  const now = opts.now ?? new Date()
  const ruleId = typeof (body as { ruleId?: unknown })?.ruleId === 'string' ? (body as { ruleId: string }).ruleId.trim() : ''
  if (!ruleId) throw new TimingTestInputError('Name the rule to split.')
  const pair = await abPair(ruleId)
  if (!pair) throw new TimingTestInputError('This rule has no A/B copy. Use “Duplicate as A/B” first.', 404)
  const why = abHeld(pair.a as never, pair.b as never)
  if (why) throw new TimingTestInputError(why, 409)
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] } }, include: testInclude })
  const channel = SCOPE_CHANNEL[pair.a.scope]
  const market = pair.a.marketplace ?? '*'
  const draft = { kind: 'AB', channel, market, productType: null, ruleId: pair.a.id, arms: [{ ruleId: pair.b.id }] }
  const overlap = overlapHeld(draft, live, await ruleNames(live.flatMap((t) => [t.ruleId]).filter((v): v is string => !!v)))
  if (overlap) throw new TimingTestInputError(overlap, 409)
  const created = await prisma.reviewTimingTest.create({
    data: {
      kind: 'AB', channel, market, ruleId: pair.a.id, holdoutPct: 0, status: 'DRAFT', endsWhen: asJson(endsWhenOf({})), createdBy: person.label,
      arms: { create: [{ label: 'A', position: 0, ruleId: pair.a.id }, { label: 'B', position: 1, ruleId: pair.b.id }] },
    },
  })
  const asked = await askStart(created.id, person, opts.requester)
  return { test: await oneView(created.id, now), ...asked }
}

async function testRow(id: string): Promise<TestRow> {
  const row = await prisma.reviewTimingTest.findUnique({ where: { id }, include: testInclude })
  if (!row) throw new TimingTestInputError('This test does not exist any more.', 404)
  return row
}

/** "Start test" again for a test that is not started (its earlier request was declined or expired). */
export async function startTimingTest(id: string, person: UserPrincipal, opts: { requester?: Requester; now?: Date } = {}): Promise<AskAnswer> {
  await syncTimingTestApprovals().catch(() => 0)
  const row = await testRow(id)
  if (row.status === 'WAITING_APPROVAL') throw new TimingTestInputError('It already waits for approval on the Approvals page.', 409)
  if (row.status !== 'DRAFT') throw new TimingTestInputError(row.status === 'RUNNING' ? 'The test is already running.' : 'This test has ended. Make a new one to test again.', 409)
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] }, id: { not: id } }, include: testInclude })
  const overlap = overlapHeld(row, live, await ruleNames(live.flatMap((t) => [t.ruleId]).filter((v): v is string => !!v)))
  if (overlap) throw new TimingTestInputError(overlap, 409)
  const asked = await askStart(id, person, opts.requester)
  return { test: await oneView(id, opts.now), ...asked }
}

/** Withdraws a waiting approval (the test it was for ended). */
async function withdraw(approvalId: string, why: string): Promise<void> {
  await prisma.agentApproval.updateMany({
    where: { id: approvalId, status: { in: ['pending', 'scheduled'] } },
    data: { status: 'rejected', decidedAt: new Date(), executeAfter: null, reason: `withdrawn: ${why}` },
  })
}

/**
 * "Stop test" / "End test": the test ends AT ONCE — no approval, as it only stops a split: new orders are asked by their
 * rule again from the next run. A request still waiting for approval (to start it, or to apply its winner) is withdrawn.
 * Requests the test already queued stay in the queue on their day; the buyers it held out are not asked later.
 */
export async function stopTimingTest(id: string, actor: string | null, now = new Date()): Promise<TimingTestView> {
  const row = await testRow(id)
  if (row.status === 'STOPPED' || row.status === 'DONE') throw new TimingTestInputError('This test has already ended.', 409)
  const last = row.startedAt ? await resultOf(row, now).catch(() => null) : null
  const stored = storedOf(row)
  const done = await prisma.reviewTimingTest.updateMany({
    where: { id, status: row.status },
    data: {
      status: 'STOPPED', endedAt: now, stoppedBy: actor, approvalId: row.status === 'WAITING_APPROVAL' ? null : row.approvalId,
      result: asJson({ ...stored, applyApprovalId: null, last: last ? { at: now.toISOString(), ...last } : stored.last ?? null }),
    },
  })
  if (done.count === 0) throw new TimingTestInputError('The test changed meanwhile. Look again.', 409)
  if (row.status === 'WAITING_APPROVAL' && row.approvalId) await withdraw(row.approvalId, 'the test was stopped before anyone approved it')
  if (stored.applyApprovalId) await withdraw(stored.applyApprovalId, 'the test was stopped before anyone approved it')
  return oneView(id, now)
}

/** "Apply winner — send for approval". */
export async function applyTimingWinner(id: string, person: UserPrincipal, opts: { requester?: Requester; now?: Date } = {}): Promise<AskAnswer> {
  const now = opts.now ?? new Date()
  await syncTimingTestApprovals().catch(() => 0)
  const row = await testRow(id)
  const stored = storedOf(row)
  if (stored.applyApprovalId) throw new TimingTestInputError('Applying the winner already waits for approval on the Approvals page.', 409)
  if (stored.applied) throw new TimingTestInputError('The winner was applied already.', 409)
  const { result } = await resultOf(row, now)
  const held = applyHeld(row, result)
  if (held) throw new TimingTestInputError(held, 409)
  const ask = opts.requester ?? (await defaultRequester())
  const asked = await ask(APPLY_TOOL, { testId: id, armId: result.leaderId }, person)
  if (asked.ok && asked.mode === 'queued' && asked.approvalId) {
    await prisma.reviewTimingTest.updateMany({ where: { id }, data: { result: asJson({ ...storedOf(await testRow(id)), applyApprovalId: asked.approvalId, applyWords: null }) } })
    return { test: await oneView(id, now), approval: { id: asked.approvalId, expiresAt: asked.expiresAt ? new Date(asked.expiresAt).toISOString() : null }, words: null }
  }
  const words = asked.error ? `Not sent for approval: ${asked.error}` : 'Not sent for approval: the request was refused.'
  await prisma.reviewTimingTest.updateMany({ where: { id }, data: { result: asJson({ ...storedOf(await testRow(id)), applyWords: words }) } })
  return { test: await oneView(id, now), approval: null, words }
}

/** "Keep day 4": the person keeps the day in place. Records the decision; changes no rule and no request. */
export async function keepCurrentDay(id: string, actor: string | null, now = new Date()): Promise<TimingTestView> {
  const row = await testRow(id)
  const stored = storedOf(row)
  if (row.status !== 'STOPPED' && row.status !== 'DONE') throw new TimingTestInputError('The test has not finished.', 409)
  if (stored.applied) throw new TimingTestInputError('The winner was applied.', 409)
  if (stored.applyApprovalId) throw new TimingTestInputError('Applying the winner waits for approval. Decline it on the Approvals page first.', 409)
  await prisma.reviewTimingTest.updateMany({ where: { id }, data: { result: asJson({ ...stored, kept: { at: now.toISOString(), by: actor } }) } })
  return oneView(id, now)
}

// ── For the approved tools ───────────────────────────────────────────────────────────────────────────────────────

/** The facts the tools check about one test; null when it is not in this business. */
export async function timingTestFacts(id: string): Promise<{
  row: TestRow
  names: Map<string, { name: string; isActive: boolean }>
  live: TestRow[]
  /** The rules of an A/B split (side A and B), as stored now. */
  rules: Map<string, Record<string, unknown> & { isActive: boolean; scope: string; name: string }>
} | null> {
  const row = await prisma.reviewTimingTest.findUnique({ where: { id }, include: testInclude })
  if (!row) return null
  const live = await prisma.reviewTimingTest.findMany({ where: { status: { in: [...LIVE_STATUSES] }, id: { not: id } }, include: testInclude })
  const names = await ruleNames([row, ...live].flatMap((t) => [t.ruleId, ...t.arms.map((a) => a.ruleId)]).filter((v): v is string => !!v))
  const own = [row.ruleId, ...row.arms.map((a) => a.ruleId)].filter((v): v is string => !!v)
  const rules = own.length ? await prisma.reviewRule.findMany({ where: { id: { in: own } } }) : []
  return { row, names, live, rules: new Map(rules.map((r) => [r.id, r as unknown as Record<string, unknown> & { isActive: boolean; scope: string; name: string }])) }
}

/** The part of a test its approval stands on (never its status or counts: those move while it waits). */
export function testSummary(row: TestRow, names: Map<string, { name: string }>) {
  const ends = endsWhenOf(row.endsWhen)
  return {
    id: row.id,
    kind: row.kind,
    title: titleOf(row, row.ruleId ? names.get(row.ruleId)?.name ?? null : null),
    channel: row.channel,
    market: row.market,
    productType: row.productType,
    groups: row.arms.map((a) => ({ label: a.label, delayDays: a.delayDays, rule: a.ruleId ? names.get(a.ruleId)?.name ?? a.ruleId : null, holdout: a.holdout })),
    holdoutPct: row.holdoutPct,
    ends: endsWords(ends, row.kind as TestKind),
  }
}

/** Why a test may not start now (the tool's dry run), or null. Its own waiting approval is no reason. */
export function startRefusal(row: TestRow, live: readonly TestRow[], names: Map<string, { name: string; isActive: boolean }>, rules: Map<string, Record<string, unknown> & { isActive: boolean; scope: string; name: string }>): string | null {
  if (row.status === 'RUNNING') return 'The test is already running.'
  if (row.status === 'STOPPED' || row.status === 'DONE') return 'This test has ended; it cannot start again. Make a new one.'
  const overlap = overlapHeld(row, live, names)
  if (overlap) return overlap
  if (row.kind === 'AB') {
    const a = row.ruleId ? rules.get(row.ruleId) : undefined
    const bId = row.arms.find((x) => x.position === 1)?.ruleId
    const b = bId ? rules.get(bId) : undefined
    if (!a || !b) return 'A rule of this split was deleted. Make a new split.'
    return abHeld(a, b)
  }
  return null
}

/** Starts an approved test: DRAFT or WAITING_APPROVAL → RUNNING. False when it moved meanwhile. */
export async function markTestRunning(id: string, approvalId: string | null, now = new Date()): Promise<boolean> {
  const done = await prisma.reviewTimingTest.updateMany({
    where: { id, status: { in: ['DRAFT', 'WAITING_APPROVAL'] } },
    data: { status: 'RUNNING', startedAt: now, lastWords: null, ...(approvalId ? { approvalId } : {}) },
  })
  return done.count > 0
}

/** The rule a winner goes into: the active rule for exactly this market and product type, or a new one. */
export async function winnerTarget(row: TestRow): Promise<{ mode: 'update' | 'create'; ruleId: string | null; name: string; fromDays: number | null; fromWords: string; base: Prisma.ReviewRuleGetPayload<object> | null }> {
  const { decideRuleForOrder } = await import('./review-scheduler.service.js')
  const rules = await prisma.reviewRule.findMany({ where: { isActive: true } })
  const type = row.productType?.toLowerCase() ?? null
  const exact = rules.find((r) => r.scope === 'AMAZON_PER_MARKETPLACE' && (r.marketplace ?? '').toUpperCase() === row.market.toUpperCase()
    && (type ? r.productTypes.length === 1 && r.productTypes[0].toLowerCase() === type : r.productTypes.length === 0))
  const current = await currentFirstTry(row.market, row.productType)
  if (exact) return { mode: 'update', ruleId: exact.id, name: exact.name, fromDays: current.days, fromWords: current.words, base: exact }
  const { rule: base } = decideRuleForOrder(rules, { channel: 'AMAZON', marketplace: row.market, totalPrice: 1e9, fulfillmentMethod: null, hasActiveReturn: false, hasRefund: false, productType: row.productType })
  const plain = `${marketWords(row.market) ?? row.market}${row.productType ? ` ${row.productType}` : ''}`
  const taken = await prisma.reviewRule.findFirst({ where: { name: plain, scope: 'AMAZON_PER_MARKETPLACE', marketplace: row.market }, select: { id: true } })
  return { mode: 'create', ruleId: null, name: taken ? `${plain} (timing test)` : plain, fromDays: current.days, fromWords: current.words, base }
}

/**
 * Applies an approved winner: the target rule's first try becomes the group's day (its window widened to hold it), or a
 * new rule for this market and product type is added with the base rule's other settings. Returns what it replaced.
 */
export async function applyWinnerToRule(row: TestRow, armId: string, by: string | null, now = new Date()): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
  const arm = row.arms.find((a) => a.id === armId)
  if (!arm || arm.holdout || arm.delayDays == null) throw new TimingTestInputError('That group is not a first-try day of this test.')
  const days = arm.delayDays
  const target = await winnerTarget(row)
  const stored = storedOf(row)
  let ruleId: string
  let before: AppliedWinner['before']
  if (target.mode === 'update' && target.ruleId && target.base) {
    before = { sendDelayDays: target.base.sendDelayDays, minDays: target.base.minDaysSinceDelivery, maxDays: target.base.maxDaysSinceDelivery, isActive: target.base.isActive }
    await prisma.reviewRule.update({
      where: { id: target.ruleId },
      data: { sendDelayDays: days, minDaysSinceDelivery: Math.min(target.base.minDaysSinceDelivery, days), maxDaysSinceDelivery: Math.max(target.base.maxDaysSinceDelivery, days) },
    })
    ruleId = target.ruleId
  } else {
    const b = target.base
    const sure = stored.last?.result.sure ?? null
    const made = await prisma.reviewRule.create({
      data: {
        name: target.name, scope: 'AMAZON_PER_MARKETPLACE', marketplace: row.market, isActive: true,
        productTypes: row.productType ? [row.productType] : [],
        sendDelayDays: days,
        minDaysSinceDelivery: Math.max(FIRST_DAY, Math.min(b?.minDaysSinceDelivery ?? FIRST_DAY, days)),
        maxDaysSinceDelivery: Math.max(b?.maxDaysSinceDelivery ?? LAST_DAY, days),
        exclusions: b?.exclusions ?? ['has_refund', 'has_active_return'],
        minOrderTotalCents: b?.minOrderTotalCents ?? null,
        useSentimentDiversion: b?.useSentimentDiversion ?? false,
        fallbackOnNoResponse: b?.fallbackOnNoResponse ?? true,
        anchor: 'DELIVERY',
        sendHourLocal: b?.sendHourLocal ?? null,
        skipWeekends: b?.skipWeekends ?? false,
        shiftToBestDay: b?.shiftToBestDay ?? false,
        createdBy: 'timing-test',
        notes: `Added by the timing test of ${shortDate(row.startedAt ?? now)}: day ${days} won${sure != null ? ` (${sure}% sure)` : ''}.`,
      },
    })
    ruleId = made.id
    before = { sendDelayDays: null, minDays: made.minDaysSinceDelivery, maxDays: made.maxDaysSinceDelivery, isActive: false }
  }
  const rule = await prisma.reviewRule.findUnique({ where: { id: ruleId } })
  const applied: AppliedWinner = { armId, label: arm.label, delayDays: days, ruleId, ruleName: rule?.name ?? target.name, created: target.mode === 'create', before, at: now.toISOString(), by }
  await prisma.reviewTimingTest.updateMany({ where: { id: row.id }, data: { result: asJson({ ...stored, applied, applyApprovalId: null, applyWords: null }) } })
  return {
    before: { testId: row.id, armId: BEFORE_ARM, ruleId: target.mode === 'update' ? ruleId : null, created: false, sendDelayDays: before.sendDelayDays, minDays: before.minDays, maxDays: before.maxDays, isActive: before.isActive },
    after: { testId: row.id, armId, ruleId, created: applied.created, sendDelayDays: days, minDays: rule?.minDaysSinceDelivery ?? null, maxDays: rule?.maxDaysSinceDelivery ?? null, isActive: rule?.isActive ?? true },
  }
}

/** Puts back what was there before a winner was applied: the rule's first try and window, or the added rule off. */
export async function putBackBeforeWinner(row: TestRow, now = new Date()): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
  const stored = storedOf(row)
  const applied = stored.applied
  if (!applied) throw new TimingTestInputError('No winner of this test is applied, so there is nothing to put back.')
  const rule = await prisma.reviewRule.findUnique({ where: { id: applied.ruleId } })
  if (!rule) throw new TimingTestInputError(`The rule “${applied.ruleName}” was deleted, so there is nothing to put back.`)
  const before = { testId: row.id, armId: applied.armId, ruleId: rule.id, created: applied.created, sendDelayDays: rule.sendDelayDays, minDays: rule.minDaysSinceDelivery, maxDays: rule.maxDaysSinceDelivery, isActive: rule.isActive }
  const data = applied.created
    ? { isActive: false }
    : { sendDelayDays: applied.before.sendDelayDays, minDaysSinceDelivery: applied.before.minDays, maxDaysSinceDelivery: applied.before.maxDays }
  const next = await prisma.reviewRule.update({ where: { id: rule.id }, data })
  await prisma.reviewTimingTest.updateMany({ where: { id: row.id }, data: { result: asJson({ ...stored, applied: null, applyWords: `Put back ${shortDate(now)}: “${rule.name}” is ${applied.created ? 'off again' : `back to ${applied.before.sendDelayDays == null ? 'the product-type table' : `day ${applied.before.sendDelayDays}`}`}.` }) } })
  return {
    before,
    after: { testId: row.id, armId: BEFORE_ARM, ruleId: rule.id, created: applied.created, sendDelayDays: next.sendDelayDays, minDays: next.minDaysSinceDelivery, maxDays: next.maxDaysSinceDelivery, isActive: next.isActive },
  }
}

/** What is stored now for an applied winner's rule, in the shape of the tool's change (undo's `current`). */
export async function winnerRuleNow(testId: string, ruleId: string | null): Promise<Record<string, unknown> | null> {
  const row = await prisma.reviewTimingTest.findUnique({ where: { id: testId } })
  if (!row) return null
  const applied = storedOf(row).applied
  const id = ruleId ?? applied?.ruleId ?? null
  const rule = id ? await prisma.reviewRule.findUnique({ where: { id } }) : null
  return {
    testId, armId: applied?.armId ?? BEFORE_ARM, ruleId: rule?.id ?? null, created: applied?.created ?? false,
    sendDelayDays: rule?.sendDelayDays ?? null, minDays: rule?.minDaysSinceDelivery ?? null, maxDays: rule?.maxDaysSinceDelivery ?? null, isActive: rule?.isActive ?? false,
  }
}

export { DAY_CHOICES }
