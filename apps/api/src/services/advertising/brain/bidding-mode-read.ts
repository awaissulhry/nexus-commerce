/**
 * ONE BRAIN AB-17 — the `ads-brain` tool's view `bidding` (design 2026-10-08-ads-one-brain/DESIGN.md §2.11, §6; §10: the
 * Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes nothing, in Nexus or
 * at Amazon, asks nobody and stores nothing.
 *
 *   product × market  each campaign's bidding strategy decided NOW (a dry run: any product, enrolled or not, at the level
 *                     its biddingStrategy lever has — what the brain would switch, test, switch back or keep, the rule and
 *                     its evidence, what holds it), beside the newest decision it logged; the switchback tests (open, and
 *                     the closed ones of 180 days with their verdicts); the N4 clock and until when a switch asks a person;
 *                     the spacing; the rules
 *   market            the products the lever watches there, the tests running, the requests waiting
 * The cents behind the stack check sit under `money` (ad-spend money: hidden without the permission).
 */
import prisma from '../../../db.js'
import { autoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import { readEnginePosture } from '../ads-engine-guard.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import {
  DECISION_DAYS_KEPT, DECLINE_DAYS, decideMode, EXTRA_TEST_WEEKS, HOLD_DAYS, LANE_WINDOW_DAYS, NEW_CAMPAIGN_DAYS, OPEN_TEST_STATUSES, TEST_DAYS_KEPT, TEST_WEEKS,
  THIN_ORDERS_PER_30D, TOS_CR_LIFT, TOS_MIN_ORDERS, weeklyRun, words, type ModeDecision,
} from './bidding-mode.js'
import { loadProductModeFacts, modeWatchProducts } from './bidding-mode-load.js'
import { productFamily } from './ownership.js'

/** MCP.12 — the words every tool uses for a product that is deleted or not in this business (read-map.ts). */
const PRODUCT_NOT_FOUND = 'Product not found'
const DAY_MS = 86_400_000

/** The rules the view states, so a reader never has to guess them. */
export const BIDDING_RULES = {
  strategies: 'fixed (MANUAL: Amazon adjusts nothing), down only (LEGACY_FOR_SALES: Amazon may lower a bid), up and down (AUTO_FOR_SALES: Amazon may also raise it, up to +100 %); rule-based bidding is never chosen (a second brain inside Amazon)',
  order: `exact → fixed where the campaign's hourly plan sets its placement % and the brain writes them; new (under ${NEW_CAMPAIGN_DAYS} days), LAUNCH, thin (under ${THIN_ORDERS_PER_30D} ad orders in 30 settled days) → down only; top of search converting at least ${TOS_CR_LIFT}× the campaign's average over ${TOS_MIN_ORDERS} top-of-search orders (${LANE_WINDOW_DAYS} settled days) AND the stack with Amazon's raise inside the lane CPC ceiling → up and down; else down only`,
  stack: 'the highest bid × (1 + placement %) × Amazon\'s dynamic factor (×2 top of search, ×1.5 elsewhere) must stay within the hourly plan\'s CPC ceiling, and top of search\'s within its sales per click at the band\'s top ACoS; with no ceiling known, never up and down',
  switchback: `each switch is a test: ${TEST_WEEKS} whole weeks at least (as many as the spacing), then the same days of the week after the switch against as many before — AB-15's judge and the band: worse → switched back; too little data → up to ${EXTRA_TEST_WEEKS} more weeks, then up and down goes back and the others stay; else kept`,
  spacing: 'at most one switch per biddingStrategySwitchDays (14) per campaign, anyone\'s switch counted; the stop recipe\'s down only and its give-back never count',
  weekly: 'new switches on the weekly run (Monday, Europe/Rome); a test\'s verdict and its switch back on any run',
  n4: 'for strategyApprovalDays (30) after the lever became the brain\'s on the product, every switch and switch back asks a person, at AUTO too; then AUTO switches alone. strategySwitchMode ALWAYS_PROPOSE or the lever at PROPOSE: always asks',
  holds: `a stop (the stop recipe owns the strategy), a person's own strategy (${HOLD_DAYS} days), the Owner's lock, the bids pin, Amazon's own strategy, the kill switch and auto-undo's hold each stop the brain; a declined switch is not asked again for ${DECLINE_DAYS} days`,
  levels: 'OBSERVE logs; PROPOSE asks a person; AUTO writes as the brain through the write gate (only under the live server switch, while the account\'s ads automation runs, on the live-write allowlist)',
  never: 'a bid, a budget, a placement %, a status or a stock quantity: the lever writes the strategy only',
} as const

/** One decision as the view shows it (cents under `money`). */
export function biddingView(d: ModeDecision) {
  return {
    campaignId: d.campaignId, name: d.name, status: d.status, level: d.level, strategy: d.current, strategyWords: words(d.current),
    action: d.action, mode: d.mode, outcome: d.outcome, rule: d.rule, to: d.to, toWords: d.to ? words(d.to) : null,
    target: d.target, test: d.test, closeTest: d.closeTest ? { status: d.closeTest.status, why: d.closeTest.why } : null,
    asksUntil: d.asksUntil, nextSwitchFrom: d.nextSwitchFrom,
    ...(d.hold ? { hold: d.hold } : {}), ...(d.approvalId ? { approvalId: d.approvalId } : {}),
    ...(d.money ? { money: d.money } : {}),
    why: d.why,
  }
}

const testView = (t: { id: string; campaignId: string; status: string; fromStrategy: string; toStrategy: string; rule: string; level: string; approvalId: string | null; switchedAt: Date | null; verdict: string | null; verdictAt: Date | null; revertApprovalId: string | null; revertedAt: Date | null; testFrom: Date | null; testTo: Date | null; figures: unknown; why: string; createdAt: Date }) => ({
  testId: t.id, campaignId: t.campaignId, status: t.status, from: t.fromStrategy, to: t.toStrategy, rule: t.rule, level: t.level,
  approvalId: t.approvalId, switchedAt: t.switchedAt?.toISOString() ?? null, testDays: t.testFrom && t.testTo ? { from: t.testFrom.toISOString().slice(0, 10), to: t.testTo.toISOString().slice(0, 10) } : null,
  verdict: t.verdict, verdictAt: t.verdictAt?.toISOString() ?? null, revertApprovalId: t.revertApprovalId, revertedAt: t.revertedAt?.toISOString() ?? null,
  ...(t.figures ? { money: { figures: t.figures } } : {}), why: t.why, at: t.createdAt.toISOString(),
})

/**
 * View bidding. With productId and market: every campaign decided now (dry run) beside the newest logged decision, the
 * tests and the N4 clock. With market alone: the products watched, the tests running, the requests waiting.
 */
export async function brainBidding(args: { productId?: string; market?: string; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  // The database clock, as the runs read it (rank-defend's dbNow: a container clock once ran two hours late).
  const now = args.now ?? await (await import('../../../jobs/ad-rank-defend.job.js')).dbNow()
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && (!market || !/^[A-Z]{2}$/.test(market))) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view bidding reads one market' }
  const ceilingLive = brainLiveCeiling()
  const posture = await readEnginePosture()
  const week = weeklyRun(now)
  const switches = { serverSwitchLive: ceilingLive, adsAutomation: posture.posture, adsAutomationWhy: posture.why, weeklyRun: week.weekly, nextWeeklyRun: week.next }
  if (args.productId) {
    if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
    const family = await productFamily(args.productId)
    if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
    const loaded = await loadProductModeFacts(family.root, market, { now })
    if (!loaded) return { error: `${market} is not a market code` }
    // The clock as the run would keep it: stored, else the Owner's choice that made the lever the brain's (never stored here).
    const since = loaded.clock?.since ?? (loaded.owned ? loaded.ownedBy?.at ?? now : null)
    const ctx = { now, ceilingLive, posture, weekly: week.weekly, nextWeekly: week.next, thresholds: autoUndoThresholds(market), settledThrough: loaded.settledThrough }
    const decisions = loaded.facts.map((f) => decideMode({ ...f, clockSince: since }, ctx))
    const tests = await prisma.adsBrainStrategyTest.findMany({
      where: { productId: loaded.productId, marketplace: market, OR: [{ status: { in: [...OPEN_TEST_STATUSES] } }, { updatedAt: { gte: new Date(now.getTime() - TEST_DAYS_KEPT * DAY_MS) } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
    })
    const approvalDays = loaded.facts[0]?.approvalDays ?? 30
    return {
      data: {
        view: 'bidding', scope: { productId: loaded.productId, market }, enrolled: loaded.enrolled, dryRun: true, at: now.toISOString(),
        note: 'decided now from what Nexus holds — not stored, nothing asked, nothing sent; the brain logs and acts only for a campaign whose biddingStrategy lever is OBSERVE or higher (the product cycle\'s weekly step)',
        switches, rules: BIDDING_RULES, settledThrough: loaded.settledThrough,
        n4: {
          owned: loaded.owned, since: since?.toISOString() ?? null, stored: !!loaded.clock, approvalDays,
          asksUntil: since ? new Date(since.getTime() + approvalDays * DAY_MS).toISOString() : null,
          words: !loaded.owned ? 'the lever is not the brain\'s on this product (no PROPOSE or AUTO): no clock' : `the lever is the brain's since ${since!.toISOString().slice(0, 10)}: at AUTO every switch asks a person until ${new Date(since!.getTime() + approvalDays * DAY_MS).toISOString().slice(0, 10)} (N4), unless the Owner set it otherwise`,
        },
        campaigns: decisions.map((d) => {
          const last = loaded.previous.get(d.campaignId)
          return { ...biddingView(d), logged: last ? { at: last.createdAt.toISOString(), mode: last.mode, action: last.action, outcome: last.outcome, approvalId: last.approvalId, testId: last.testId, why: last.why } : null }
        }),
        tests: tests.map(testView),
        rowsKept: await prisma.adsBrainStrategyDecision.count({ where: { productId: loaded.productId, marketplace: market } }), keptDays: DECISION_DAYS_KEPT,
      },
    }
  }
  const watched = (await modeWatchProducts()).filter((p) => p.market === market)
  const open = await prisma.adsBrainStrategyTest.findMany({ where: { marketplace: market, status: { in: [...OPEN_TEST_STATUSES] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
  return {
    data: {
      view: 'bidding', scope: { market }, at: now.toISOString(), switches, rules: BIDDING_RULES,
      products: watched.map((p) => ({ productId: p.productId, level: p.level })),
      testing: open.filter((t) => t.status === 'TESTING').map(testView),
      waiting: open.filter((t) => t.status === 'ASKED' || t.status === 'REVERT_ASKED').map(testView),
      next: 'Read one product with productId and market: each campaign decided now (dry run) beside the newest logged decision, its tests and the N4 clock.',
    },
  }
}
