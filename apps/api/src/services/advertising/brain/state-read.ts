/**
 * ONE BRAIN AB-12 — the `ads-brain` tool's view `state` (design 2026-10-08-ads-one-brain/DESIGN.md §2.4, §6 "caps — used /
 * left"; §10: the Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes
 * nothing, in Nexus or at Amazon, asks nobody and stores nothing.
 *
 *   product × market  each campaign's state decided NOW (a dry run: any product, enrolled or not, at the level its state
 *                     lever has — what the brain would pause, resume, propose to archive or keep, and why), beside the
 *                     newest decision the brain logged for it; the brain's pauses in force with their memory; requests
 *                     waiting; what needs a person (a pause the brain can no longer give back at its lever's level); the
 *                     day's pause cap, used and left
 *   market            the products the state brain watches there, the day's pauses (used / left), the brain's pauses in
 *                     force, its requests waiting, and what needs a person
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { readEnginePosture } from '../ads-engine-guard.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { productFamily } from './ownership.js'
import { loadProductStateFacts, newestStateDecisions, stateWatchProducts } from './state-load.js'
import { pausesToday } from './state-run.js'
import {
  DECLINE_DAYS, decideState, HOLD_DAYS, MAX_PAUSES_PER_MARKET_DAY, MIN_PAUSED_HOURS, MIN_SERVING_HOURS, OPEN_SETTLE_HOURS, STATE_DECISION_DAYS_KEPT,
  type StateDecision,
} from './state.js'

/** MCP.12 — the words every tool uses for a product that is deleted or not in this business (read-map.ts). */
const PRODUCT_NOT_FOUND = 'Product not found'

/** The rules the view states, so a reader never has to guess them. */
export const STATE_RULES = {
  pauseFrom: 'a stop expected to last pauseMinDays (3 by default) or more; a shorter one stays on low bids (the stop recipe, or the stop owner\'s floor), never a pause',
  causes: 'out of stock (dated restock, else the lead time, else open-ended), the month\'s spend cap (lifts on the 1st), a playbook STOP (open-ended), the Owner\'s long stop (longStopUntil)',
  openEnded: `an open-ended stop pauses once it has held ${OPEN_SETTLE_HOURS} h`,
  resume: `when every cause of the brain's own pause has ended, after at least ${MIN_PAUSED_HOURS} h paused; back to the status before (ENABLED) — the stop's memory (bids, lanes, strategy) is given back by its owner`,
  noFlipFlop: `a resumed campaign serves at least ${MIN_SERVING_HOURS} h before another pause; a declined request waits ${DECLINE_DAYS.pause} day (pause, resume) or ${DECLINE_DAYS.archive} days (archive)`,
  holds: `the brain pauses only an ENABLED campaign and resumes only a pause it made; anyone else's status change is a hold for ${HOLD_DAYS} days`,
  archive: 'no impression for archiveDeadWeeks weeks (4 by default): a proposal only, whatever the level',
  cap: `at most ${MAX_PAUSES_PER_MARKET_DAY} pauses a UTC day per market`,
  levels: 'OBSERVE logs; PROPOSE asks a person; AUTO writes as the brain through the write gate (only under the live server switch, while the account\'s ads automation runs)',
  never: 'a bid, a budget, a lane, a strategy or a stock quantity (FBA included): the state lever writes the campaign status only',
} as const

/** One decision as the view shows it. */
export function stateView(d: StateDecision) {
  return {
    campaignId: d.campaignId, name: d.name, status: d.status, level: d.level, action: d.action, wouldDo: d.wouldDo, mode: d.mode, outcome: d.outcome,
    cause: d.cause, causes: d.causes, expectedEndAt: d.expectedEndAt, horizonHours: d.horizonHours, stopSince: d.stopSince,
    ...(d.memory ? { pause: { since: d.memory.pausedAt, via: d.memory.via, approvalId: d.memory.approvalId, causes: d.memory.causes, statusBefore: d.memory.statusBefore, stopMemory: d.memory.stop } } : {}),
    ...(d.hold ? { hold: d.hold } : {}), ...(d.attention ? { attention: d.attention } : {}), ...(d.approvalId ? { approvalId: d.approvalId } : {}),
    why: d.why,
  }
}

/**
 * View state. With productId and market: every campaign decided now (dry run) beside the newest logged decision. With
 * market alone: the products watched, the day's pauses and what waits or needs a person.
 */
export async function brainState(args: { productId?: string; market?: string; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  // The database clock, as the runs read it (rank-defend's dbNow: a container clock once ran two hours late).
  const now = args.now ?? await (await import('../../../jobs/ad-rank-defend.job.js')).dbNow()
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && (!market || !/^[A-Z]{2}$/.test(market))) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view state reads one market' }
  const ceilingLive = brainLiveCeiling()
  const [posture, used] = await Promise.all([readEnginePosture(), pausesToday(market, now)])
  const cap = {
    perDay: MAX_PAUSES_PER_MARKET_DAY,
    used: used.acting, left: Math.max(0, MAX_PAUSES_PER_MARKET_DAY - used.acting),
    shadowUsed: used.shadow, shadowLeft: Math.max(0, MAX_PAUSES_PER_MARKET_DAY - used.shadow),
  }
  const switches = { serverSwitchLive: ceilingLive, adsAutomation: posture.posture, adsAutomationWhy: posture.why }
  if (args.productId) {
    if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
    const family = await productFamily(args.productId)
    if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
    const loaded = await loadProductStateFacts(family.root, market, { now })
    if (!loaded) return { error: `${market} is not a market code` }
    const pausesLeft = { acting: cap.left, shadow: cap.shadowLeft }
    const decisions = loaded.facts.map((f) => {
      const d = decideState(f, { now, ceilingLive, posture, pausesLeft })
      if (d.action === 'pause' && (d.outcome === 'ask' || d.outcome === 'write')) pausesLeft.acting--
      if (d.action === 'pause' && d.outcome === 'shadow' && !f.shadowPaused) pausesLeft.shadow--
      return d
    })
    const kept = await prisma.adsBrainStateDecision.count({ where: { productId: loaded.productId, marketplace: market } })
    return {
      data: {
        view: 'state', scope: { productId: loaded.productId, market }, enrolled: loaded.enrolled, dryRun: true, at: now.toISOString(),
        note: 'decided now from what Nexus holds — not stored, nothing asked, nothing sent; the brain logs and acts only for a campaign whose state lever is OBSERVE or higher (hourly)',
        switches, cap, rules: STATE_RULES,
        campaigns: decisions.map((d) => {
          const last = loaded.previous.get(d.campaignId)
          return { ...stateView(d), logged: last ? { at: last.createdAt.toISOString(), mode: last.mode, action: last.action, outcome: last.outcome, approvalId: last.approvalId, why: last.decision.why } : null }
        }),
        attention: decisions.filter((d) => d.attention).map((d) => ({ campaignId: d.campaignId, name: d.name, attention: d.attention })),
        rowsKept: kept, keptDays: STATE_DECISION_DAYS_KEPT,
      },
    }
  }
  const watched = (await stateWatchProducts()).filter((p) => p.market === market)
  const recent = await prisma.adsBrainStateDecision.findMany({
    where: { marketplace: market, createdAt: { gte: new Date(now.getTime() - STATE_DECISION_DAYS_KEPT * 86_400_000) } },
    select: { campaignId: true }, distinct: ['campaignId'],
  })
  const newest = await newestStateDecisions(recent.map((r) => r.campaignId))
  const rows = [...newest.values()]
  // The newest row carries the brain's memory exactly while its own pause holds (state-run.ts).
  const brainPauses = rows.filter((r) => !!r.decision.memory)
  return {
    data: {
      view: 'state', scope: { market }, at: now.toISOString(), switches, cap, rules: STATE_RULES,
      products: watched.map((p) => ({ productId: p.productId, level: p.level })),
      pausedByTheBrain: brainPauses.map((r) => ({ campaignId: r.campaignId, productId: r.decision.productId, name: r.decision.name, since: r.decision.memory!.pausedAt, causes: r.decision.memory!.causes, expectedEndAt: r.decision.memory!.expectedEndAt, level: r.decision.level, why: r.decision.why })),
      waiting: rows.filter((r) => r.outcome === 'asked' || r.outcome === 'waiting').map((r) => ({ campaignId: r.campaignId, productId: r.decision.productId, name: r.decision.name, action: r.action, approvalId: r.approvalId, at: r.createdAt.toISOString() })),
      attention: rows.filter((r) => r.decision.attention).map((r) => ({ campaignId: r.campaignId, name: r.decision.name, attention: r.decision.attention })),
      next: 'Read one product with productId and market: each campaign decided now (dry run) beside the newest logged decision.',
    },
  }
}
