/**
 * ONE BRAIN AB-14 — each step of the product cycle, run for ONE product × market through its lever's own module (design
 * 2026-10-08-ads-one-brain/DESIGN.md §4, §8 row AB-14). brain/cycle.ts holds the order; brain/cycle-run.ts runs these in
 * it, inside the cycle's change set (ads-evidence.ts inBrainCycle), and stores what each hands back. Nothing here decides
 * a lever: every step is the module that runs it today, with the same rules, the same levels and the same caps — scoped
 * to one product, and given what the steps before it decided.
 *
 *   state      brain/state-run.ts runStateBrainOnce for the product (its state lever, or one campaign's, OBSERVE+). A pause
 *              it queues, asks for or waits on holds the bid raises of that campaign.
 *   terms      brain/terms-shadow.ts, per MARKET: the arbiter needs every due product of the market together (its leads are
 *              stored per market), so the ledger is decided for all of them and stored for the products whose step runs.
 *   negatives  brain/negatives-run.ts runNegativesOnce for the product (its negatives lever OBSERVE+).
 *   harvest    brain/harvest-run.ts runHarvestOnce for the product (its harvest lever OBSERVE+), after its negatives; a pair
 *              the module left half done is a clash in the report.
 *   structure  brain/structure-run.ts runStructureOnce for the product (its structure lever OBSERVE, PROPOSE or locked): every
 *              day what its earlier requests became (built, its go-live asked, live); its new proposals on the weekly day
 *              (Monday in the market's time zone). Never acts on the day's facts: each request waits for a person (AB-16).
 *   money      brain/budget-shadow.ts runMoneyShadowOnce for the product (its budgets lever OBSERVE+). Where the budgets lever
 *              acts, the brake that holds raises (and stronger) holds every own campaign's bid raises, and a campaign whose
 *              budget steps down holds its own: budget before bid, a raise never fights a cut. In shadow the same holds are
 *              only reported as a clash when the bids raise there.
 *   bids       bid-brain/shadow.ts runShadowOnce on the product's own campaigns in its market (the market read whole, so
 *              every pooled estimate is the full run's), with the holds above as raise caps.
 *   hours      brain/hours-proposal.ts runHoursOnce for the product (weekly; it says when it is due, never AUTO).
 *   bidding    AB-17 — brain/bidding-mode-run.ts runBiddingModeOnce for the product (its biddingStrategy lever, or one
 *              campaign's, OBSERVE+): new switches on the weekly run (Monday, Europe/Rome), a switchback test's verdict and
 *              its switch back on any run; a campaign the state step pauses now is a stop, never switched.
 */
import prisma from '../../../db.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { bidBrainMode, runShadowOnce } from '../bid-brain/shadow.js'
import type { StateWatched } from './state-load.js'
import type { ModeWatched } from './bidding-mode-load.js'
import type { MoneyShadowProduct } from './budget-shadow.js'
import type { DueProduct } from './terms-shadow.js'
import { raiseHoldsFor, STEP_WORDS, type CycleStep, type MoneyInOut, type StepOutcome, type StepRecords, type Waiting } from './cycle.js'

/** What one tick read once for every product (no N+1 across products). */
export interface TickFacts {
  /** The database clock (rank-defend's dbNow: a container clock once ran two hours late). */
  now: Date
  dataDay: string
  stateWatch: ReadonlyMap<string, StateWatched>
  moneyWatch: ReadonlyMap<string, MoneyShadowProduct>
  /** Every enrolled product whose negatives or harvest lever is OBSERVE or higher, orchestrated or not. */
  termsDue: readonly DueProduct[]
}

/** One product's step: who, where, what the steps before it decided. */
export interface StepContext {
  productId: string
  market: string
  key: string
  changeSetId: string
  /** The product's own Sponsored Products campaigns in the market (brain/ownership.ts), id → name. */
  own: ReadonlyMap<string, string>
  records: StepRecords
  acts: Readonly<Record<CycleStep, boolean>>
  tick: TickFacts
}

export type StepRunner = (ctx: StepContext) => Promise<StepOutcome>
/** The term ledger runs per market: every product of the market whose step runs, at once. */
export type TermsRunner = (market: string, ctxs: readonly StepContext[]) => Promise<Map<string, StepOutcome>>

export interface CycleRunners {
  state: StepRunner
  terms: TermsRunner
  negatives: StepRunner
  harvest: StepRunner
  structure: StepRunner
  money: StepRunner
  bids: StepRunner
  hours: StepRunner
  bidding: StepRunner
}

const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'AUTO']
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const nameOf = (ctx: StepContext, campaignId: string) => ctx.own.get(campaignId) ?? campaignId
const countsLine = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ')

// ── ① stops and state ────────────────────────────────────────────────────────────────────────────────────────────

const PAUSE_HOLDS: readonly string[] = ['queued', 'asked', 'waiting']

export const stateStep: StepRunner = async (ctx) => {
  const watched = ctx.tick.stateWatch.get(ctx.key)
  if (!watched) return { status: 'off', why: 'the state lever is OFF, locked or excluded for the product and each of its campaigns: no stop decided' }
  const { runStateBrainOnce } = await import('./state-run.js')
  const run = await runStateBrainOnce({ now: ctx.tick.now, products: [watched] })
  const failed = run.failed.find((f) => f.productId === ctx.productId)
  if (failed) return { status: 'failed', why: `the state run failed: ${failed.error}`, runId: run.runId }
  const mine = run.campaigns.filter((c) => c.productId === ctx.productId)
  const counts: Record<string, number> = {}
  for (const c of mine) counts[c.action] = (counts[c.action] ?? 0) + 1
  const holds: Array<[string, string]> = mine.filter((c) => c.action === 'pause' && PAUSE_HOLDS.includes(c.outcome)).map((c) => [c.campaignId, `it pauses ${nameOf(ctx, c.campaignId)} (${c.outcome})`])
  const shadowHolds: Array<[string, string]> = mine.filter((c) => c.action === 'pause' && c.outcome === 'shadow').map((c) => [c.campaignId, `the state step (shadow) would pause ${nameOf(ctx, c.campaignId)}`])
  const waiting: Waiting[] = mine.filter((c) => (c.outcome === 'asked' || c.outcome === 'waiting') && c.approvalId).map((c) => ({ what: `${c.action} ${nameOf(ctx, c.campaignId)}`, approvalId: c.approvalId ?? null }))
  const moves = mine.filter((c) => c.action === 'pause' || c.action === 'resume' || c.action === 'archive')
  const lines = moves.length
    ? moves.map((c) => `${nameOf(ctx, c.campaignId)}: ${c.outcome === 'shadow' ? `would ${c.action} (shadow)` : `${c.action} ${c.outcome}`} — ${c.why}`)
    : [`${plural(mine.length, 'campaign')} decided: ${countsLine(counts) || 'nothing to change'}`]
  return {
    status: 'done', why: `${watched.level}: ${countsLine(counts) || 'no campaign'}`, runId: run.runId, holds, waiting,
    did: { lines, counts: { ...counts, stored: mine.filter((c) => c.stored).length, acted: mine.filter((c) => c.outcome === 'queued' || c.outcome === 'asked').length }, shadowHolds },
  }
}

// ── ② the term ledger (per market) ───────────────────────────────────────────────────────────────────────────────

export const termsStep: TermsRunner = async (market, ctxs) => {
  const out = new Map<string, StepOutcome>()
  const due = ctxs[0]?.tick.termsDue.filter((d) => d.market === market) ?? []
  const dueIds = new Set(due.map((d) => d.productId))
  for (const c of ctxs) if (!dueIds.has(c.productId)) out.set(c.productId, { status: 'off', why: 'the negatives and harvest levers are OFF, locked or excluded: no term to decide' })
  const running = ctxs.filter((c) => dueIds.has(c.productId))
  if (!running.length) return out
  const { decideMarket, loadTermsMarket, storeLeads, storeLedger } = await import('./terms-shadow.js')
  const { stateCounts } = await import('./terms.js')
  const now = running[0].tick.now
  let facts: Awaited<ReturnType<typeof loadTermsMarket>>
  let decided: ReturnType<typeof decideMarket>
  try {
    // The arbiter needs every due product of the market (its leads are stored per market), as the daily run reads it.
    facts = await loadTermsMarket(market, due, now)
    decided = decideMarket(facts, due)
  } catch (err) {
    const why = `the term ledger could not read ${market}: ${err instanceof Error ? err.message : String(err)}`
    for (const c of running) out.set(c.productId, { status: 'failed', why })
    return out
  }
  for (const c of running) {
    const decisions = decided.byProduct.get(c.productId)
    if (!facts.products.has(c.productId) || !decisions) {
      out.set(c.productId, { status: 'skipped', why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no term to decide' })
      continue
    }
    try {
      const stored = await storeLedger({ productId: c.productId, market, decisions, runId: c.changeSetId, dataDay: facts.dataDay, windowDays: facts.windowDays, now })
      const byState = Object.fromEntries(Object.entries(stateCounts(decisions)).filter(([, n]) => n > 0))
      const clashes = decisions.reduce((n, d) => n + d.clashes.length, 0)
      out.set(c.productId, {
        status: 'done', why: `SHADOW: ${plural(decisions.length, 'term')} decided (${countsLine(byState) || 'none'})`, runId: c.changeSetId,
        did: {
          lines: [`${plural(decisions.length, 'term')} over ${facts.windowDays} settled days: ${countsLine(byState) || 'none'} (shadow: the ledger writes nothing at Amazon)`, ...(clashes ? [`the ledger removes ${plural(clashes, 'clash', 'clashes')} (a term harvested and negated at once, a keyword blocked where it is targeted, a sibling's term)`] : [])],
          counts: { ...byState, created: stored.created, changed: stored.changed, removed: stored.removed },
        },
      })
    } catch (err) {
      out.set(c.productId, { status: 'failed', why: `the ledger could not be stored: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  // The market's leads, as the daily run stores them (one transaction; a rerun on the same facts changes nothing).
  try {
    await storeLeads({ market, leads: decided.leads, runId: `cyc-${market}-${running[0].tick.dataDay}`, now })
  } catch (err) {
    const why = `the market's term leads could not be stored: ${err instanceof Error ? err.message : String(err)}`
    for (const c of running) if (out.get(c.productId)?.status === 'done') out.set(c.productId, { status: 'failed', why })
  }
  return out
}

// ── ③ negatives ──────────────────────────────────────────────────────────────────────────────────────────────────

export const negativesStep: StepRunner = async (ctx) => {
  const d = ctx.tick.termsDue.find((p) => p.productId === ctx.productId && p.market === ctx.market)
  if (!d || !ACTS.includes(d.settings.levers.negatives.effective)) return { status: 'off', why: 'the negatives lever is OFF, locked or excluded: no negative decided' }
  const { runNegativesOnce } = await import('./negatives-run.js')
  const s = await runNegativesOnce({ now: ctx.tick.now, due: { due: true, why: 'the product cycle', products: [d] } })
  const skipped = s.skipped.find((k) => k.productId === ctx.productId)
  if (skipped) return /failed/.test(skipped.why) ? { status: 'failed', why: skipped.why, runId: s.runId ?? null } : { status: 'skipped', why: skipped.why, runId: s.runId ?? null }
  const byStatus = s.byStatus as Record<string, number>
  const shadow = d.settings.levers.negatives.effective === 'OBSERVE'
  return {
    status: 'done', why: `${d.settings.levers.negatives.effective}: ${plural(s.planned, 'negative')} planned (${countsLine(byStatus) || 'none'})`, runId: s.runId ?? null,
    waiting: s.proposed.map((approvalId) => ({ what: 'the day\'s negatives (one change plan)', approvalId })),
    did: { lines: [`${plural(s.planned, 'add or retire', 'adds and retires')} planned: ${countsLine(byStatus) || 'none'}${shadow ? ' (shadow: nothing at Amazon)' : ''}`], counts: { planned: s.planned, ...byStatus } },
  }
}

// ── ④ harvest ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of AB-11's run summary (brain/harvest-run.ts HarvestRunSummary) the cycle reads. */
export interface HarvestRunLike {
  ran: boolean
  why: string
  runId?: string
  decided: { pairs: number; newCampaigns: number; held: number }
  acted: { logged: number; proposed: number; written: number; campaignsProposed: number }
  pending: { synced: number; completed: number; retried: number; judged: number; undoProposed: number }
  skipped: Array<{ productId: string; market: string; why: string }>
}

/**
 * The harvest step from AB-11's run: the product's harvest lever OBSERVE or higher, run for it alone inside the change
 * set, after negatives. The pair (the exact keyword and the negative exact in its sources) is the module's own one change
 * set; one left half done (`halfDone`: the module's HALF_DONE harvests of the product after the run) is a clash the report
 * names until the module sends the rest.
 */
export function harvestStepOf(
  run: (opts: { now: Date; due: { due: boolean; why: string; products: DueProduct[] } }) => Promise<HarvestRunLike>,
  halfDone: (productId: string, market: string) => Promise<number> = async () => 0,
): StepRunner {
  return async (ctx) => {
    const d = ctx.tick.termsDue.find((p) => p.productId === ctx.productId && p.market === ctx.market)
    if (!d || !ACTS.includes(d.settings.levers.harvest.effective)) return { status: 'off', why: 'the harvest lever is OFF, locked or excluded: no harvest decided' }
    const s = await run({ now: ctx.tick.now, due: { due: true, why: 'the product cycle', products: [d] } })
    const skipped = s.skipped.find((k) => k.productId === ctx.productId)
    if (skipped) return /fail/.test(skipped.why) ? { status: 'failed', why: skipped.why, runId: s.runId ?? null } : { status: 'skipped', why: skipped.why, runId: s.runId ?? null }
    const counts = { pairs: s.decided.pairs, newCampaigns: s.decided.newCampaigns, held: s.decided.held, logged: s.acted.logged, proposed: s.acted.proposed, written: s.acted.written, retried: s.pending.retried, judged: s.pending.judged }
    const half = await halfDone(ctx.productId, ctx.market)
    return {
      status: 'done', why: `${d.settings.levers.harvest.effective}: ${countsLine(counts) || 'nothing to harvest'}`, runId: s.runId ?? null,
      did: { lines: [`harvest: ${countsLine(counts) || 'nothing to harvest'}${d.settings.levers.harvest.effective === 'OBSERVE' ? ' (shadow: nothing at Amazon)' : ''}`], counts, ...(half ? { clashes: [`${plural(half, 'harvest pair')} half done: the keyword landed, a source negative did not — the harvest sends it again on its next run`] } : {}) },
    }
  }
}

/** The harvests of a product left half done (the keyword landed, a source negative did not). */
const halfDoneOf = (productId: string, market: string) => prisma.adsBrainHarvest.count({ where: { productId, marketplace: market, status: 'HALF_DONE' } })

/** ④ harvest: AB-11's module (brain/harvest-run.ts), loaded at the step. */
export const harvestStep: StepRunner = async (ctx) => {
  const { runHarvestOnce } = await import('./harvest-run.js')
  return harvestStepOf(runHarvestOnce, halfDoneOf)(ctx)
}

// ── structure (weekly, AB-16) ────────────────────────────────────────────────────────────────────────────────────

/** The part of AB-16's run summary (brain/structure-run.ts StructureRunSummary) the cycle reads. */
export interface StructureRunLike {
  ran: boolean
  why: string
  runId?: string
  decided: { skc: number; split: number; portfolio: number; held: number }
  acted: { logged: number; proposed: number }
  pending: { built: number; liveAsked: number; live: number; retireAsked: number; done: number; declined: number; failed: number }
  notDue: number
  skipped: Array<{ productId: string; market: string; why: string }>
  failed: Array<{ productId: string; market: string; error: string }>
}

/**
 * The structure step from AB-16's run, for the product alone: what its requests became every day, its proposals on the
 * weekly day. `waitingOf` names the requests that wait for a person (the build or move, the go-live, a split's low bids).
 */
export function structureStepOf(
  due: (productId: string, market: string) => Promise<{ due: boolean; why: string; products: unknown[] }>,
  run: (opts: { now: Date; due: { due: boolean; why: string; products: unknown[] } }) => Promise<StructureRunLike>,
  waitingOf: (productId: string, market: string) => Promise<Waiting[]> = async () => [],
): StepRunner {
  return async (ctx) => {
    const d = await due(ctx.productId, ctx.market)
    if (!d.due) return { status: 'off', why: 'the structure lever is OFF or excluded for the product: no structure decided' }
    const s = await run({ now: ctx.tick.now, due: d })
    const failed = s.failed.find((x) => x.productId === ctx.productId)
    if (failed) return { status: 'failed', why: `the structure run failed: ${failed.error}`, runId: s.runId ?? null }
    const skipped = s.skipped.find((x) => x.productId === ctx.productId)
    if (skipped) return { status: 'skipped', why: skipped.why, runId: s.runId ?? null }
    const counts = { skc: s.decided.skc, split: s.decided.split, portfolio: s.decided.portfolio, held: s.decided.held, logged: s.acted.logged, proposed: s.acted.proposed, built: s.pending.built, liveAsked: s.pending.liveAsked, live: s.pending.live, done: s.pending.done, declined: s.pending.declined }
    const waiting = await waitingOf(ctx.productId, ctx.market)
    const weekly = s.notDue ? 'not the weekly day (Monday in the market\'s time zone): no new proposal; what earlier requests became, synced' : `decided: ${countsLine(counts) || 'nothing to propose'}`
    return {
      status: 'done', why: weekly, runId: s.runId ?? null, waiting,
      did: { lines: [`structure: ${weekly}${s.acted.logged && !s.acted.proposed ? ' (shadow: nothing asked, nothing at Amazon)' : ''}`], counts },
    }
  }
}

/** The structure requests of a product that wait for a person. */
async function structureWaiting(productId: string, market: string): Promise<Waiting[]> {
  const rows = await prisma.adsBrainStructure.findMany({ where: { productId, marketplace: market, status: { in: ['PROPOSED', 'LIVE_PROPOSED', 'LIVE'] } }, select: { kind: true, key: true, term: true, status: true, approvalId: true, liveApprovalId: true, retireApprovalId: true } })
  const what = (r: (typeof rows)[number]) => (r.kind === 'SKC' ? `the single-keyword campaign for "${r.term}"` : r.kind === 'SPLIT' ? 'the split of a shared campaign' : 'the move into the product\'s portfolio')
  return rows.flatMap((r) => r.status === 'PROPOSED' ? [{ what: `build ${what(r)}`, approvalId: r.approvalId }]
    : r.status === 'LIVE_PROPOSED' ? [{ what: `go-live of ${what(r)}`, approvalId: r.liveApprovalId }]
      : r.retireApprovalId ? [{ what: 'the shared campaign\'s low bids (the split\'s last step)', approvalId: r.retireApprovalId }] : [])
}

/** structure: AB-16's module (brain/structure-run.ts), loaded at the step. */
export const structureStep: StepRunner = async (ctx) => {
  const { structureDue } = await import('./structure-load.js')
  const { runStructureOnce } = await import('./structure-run.js')
  return structureStepOf(
    (productId, market) => structureDue({ productId, market }),
    (opts) => runStructureOnce(opts as Parameters<typeof runStructureOnce>[0]),
    structureWaiting,
  )(ctx)
}

// ── ⑤ money ──────────────────────────────────────────────────────────────────────────────────────────────────────

const HOLDING_BRAKES: readonly string[] = ['hold_raises', 'cut_bids', 'stop_weakest']

export const moneyStep: StepRunner = async (ctx) => {
  const p = ctx.tick.moneyWatch.get(ctx.key)
  if (!p) return { status: 'off', why: 'the budgets lever is OFF, locked or excluded: no money plan' }
  const { runMoneyShadowOnce, newestMoneyDecisions } = await import('./budget-shadow.js')
  const run = await runMoneyShadowOnce({ now: ctx.tick.now, products: [p] })
  const failed = run.failed.find((f) => f.market === ctx.market)
  if (failed) return { status: 'failed', why: `the money plan failed: ${failed.error}`, runId: run.runId }
  const row = run.products.find((x) => x.productId === ctx.productId)
  // No family root in the market: the money shadow plans nothing for it (its own words).
  if (!row || (row.mode === undefined && /no family root/.test(row.why))) return { status: 'skipped', why: row?.why ?? 'nothing planned for the product', runId: run.runId }
  const plan = (await newestMoneyDecisions(ctx.market, [ctx.productId])).get(ctx.productId)?.plan ?? null
  // Budget before bid: the raises this plan holds (every own campaign while the brake holds raises, a campaign whose
  // budget steps down), held for the bids only where the budgets lever acts — in shadow they are a clash to report.
  const holdList: Array<[string, string]> = []
  if (plan) {
    if (HOLDING_BRAKES.includes(plan.brake.level)) for (const id of ctx.own.keys()) holdList.push([id, `the money brake (${plan.brake.level}) holds every raise`])
    for (const c of plan.campaigns) if (c.action === 'lower' && ctx.own.has(c.campaignId) && !holdList.some(([id]) => id === c.campaignId)) holdList.push([c.campaignId, `its budget steps down today: a bid raise would fight the cut`])
  }
  const acting = ctx.acts.money
  const proposals = plan?.actions?.proposals ?? []
  const waiting: Waiting[] = proposals.filter((x) => x.status === 'pending' || x.status === 'scheduled').map((x) => ({ what: x.kind === 'portfolioCap' ? 'the portfolio cap' : `a campaign budget (${x.key})`, approvalId: x.approvalId }))
  const counts = plan ? { raise: plan.counts.raise, lower: plan.counts.lower, keep: plan.counts.keep, hold: plan.counts.hold, ladder: plan.counts.ladder } : {}
  const mode = row.mode ?? 'SHADOW'
  return {
    status: 'done', why: `${mode}: brake ${row.brake}; campaign budgets ${countsLine(counts) || 'unchanged'}`, runId: run.runId,
    ...(acting && holdList.length ? { holds: holdList } : {}), waiting,
    did: {
      lines: [`${mode === 'SHADOW' ? 'shadow — would set' : mode === 'PROPOSE' ? 'asked a person for' : 'set'} the campaign budgets: ${countsLine(counts) || 'nothing to change'}; money brake ${row.brake}`, ...(acting && holdList.length ? [`holds the bid raises on ${plural(holdList.length, 'campaign')} (budget before bid)`] : [])],
      counts,
      ...(!acting && holdList.length ? { shadowHolds: holdList.map(([id, why]) => [id, `the money step (shadow): ${why}`] as [string, string]) } : {}),
      money: { lines: [plan?.why ?? row.why, ...(row.actions ? [row.actions] : [])].filter(Boolean) },
    },
  }
}

// ── ⑥ bids ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const bidsStep: StepRunner = async (ctx) => {
  const mode = bidBrainMode()
  if (mode === 'off') return { status: 'off', why: 'the bid brain is off (NEXUS_BID_BRAIN_MODE=off): no bid decided' }
  if (!ctx.own.size) return { status: 'skipped', why: 'no Sponsored Products campaign of its own in this market: no bid to decide' }
  const own = new Set(ctx.own.keys())
  const caps = raiseHoldsFor(ctx.records, own)
  const run = await runShadowOnce({ clockNow: ctx.tick.now, scope: { campaignIds: own, market: ctx.market }, ...(caps.size ? { raiseCaps: caps } : {}) })
  const m = run.markets.find((x) => x.market === ctx.market)
  if (!m) return { status: 'skipped', why: `the bid brain does not decide ${ctx.market} today (it decides IT and DE, and the markets of the campaigns it owns)`, runId: run.runId }
  if (m.error) return { status: 'failed', why: `the bid run failed: ${m.error}`, runId: run.runId }
  if (!m.decided && !m.owned) return { status: 'skipped', why: 'no keyword of its own campaigns for the bid brain to decide (none on its allowlist, or no enabled keyword)', runId: run.runId }
  // Which way the run's write decisions go (stored or not: an unchanged decision is not stored again the same day).
  const moves = m.moves ?? { raise: 0, lower: 0, raisedBy: {} }
  const raisedOn = new Map(Object.entries(moves.raisedBy))
  const { raise, lower } = moves
  const live = (m.owned ?? 0) > 0
  const verb = live ? '' : 'would '
  const clashes: string[] = []
  for (const step of ['state', 'money'] as const) {
    for (const [campaignId, why] of ctx.records[step]?.did?.shadowHolds ?? []) {
      const n = raisedOn.get(campaignId)
      if (n) clashes.push(`${why}; the bids ${live ? 'raised' : 'would raise'} ${plural(n, 'keyword')} on ${nameOf(ctx, campaignId)}${live ? '' : ' (shadow)'} — when ${STEP_WORDS[step]} acts, those raises wait.`)
    }
  }
  const holds = caps.size ? [`${plural(caps.size, 'campaign')} had their raises held by the steps before (${[...caps.values()].join('; ')})`] : []
  return {
    status: 'done', why: `${live ? `LIVE on ${plural(m.owned ?? 0, 'campaign')}` : 'SHADOW'}: ${plural(m.decided, 'keyword')} decided — ${verb}raise ${raise}, ${verb}lower ${lower}`, runId: run.runId,
    did: {
      lines: [`${plural(m.decided, 'keyword')} decided on ${plural(own.size, 'own campaign')}: ${verb}raise ${raise}, ${verb}lower ${lower}, hold ${Math.max(0, m.decided - raise - lower)}${live ? '' : ' (shadow: nothing at Amazon)'}`, ...holds, ...(m.brakes.length ? [`brakes: ${m.brakes.join('; ')}`] : [])],
      counts: { decided: m.decided, stored: m.stored, raise, lower, ...(m.owned ? { owned: m.owned } : {}) },
      ...(clashes.length ? { clashes } : {}),
    },
  }
}

// ── ⑦ hours ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const hoursStep: StepRunner = async (ctx) => {
  const { runHoursOnce } = await import('./hours-proposal.js')
  const s = await runHoursOnce({ now: ctx.tick.now, productId: ctx.productId, market: ctx.market })
  if (s.failed) return { status: 'failed', why: 'the hourly research failed for the product (logged): tried again on the next run' }
  if (!s.ran || s.off) return { status: 'off', why: 'the hours lever is OFF, locked or excluded (or no plan the brain may paint): nothing researched' }
  if (s.notDue) return { status: 'done', why: 'not due: researched once a week (hourProposalsPerWeek), never while a painted plan waits for a person', did: { lines: ['not due this run (weekly)'] } }
  const last = await prisma.adsBrainHourProposal.findFirst({ where: { productId: ctx.productId, marketplace: ctx.market }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, approvalId: true, why: true } })
  const waiting: Waiting[] = last?.status === 'PROPOSED' ? [{ what: 'the painted hourly plan (apply-brain-hourly-plan)', approvalId: last.approvalId }] : []
  const words = !last ? 'researched' : last.status === 'SHADOW' ? 'researched and painted in shadow (nothing asked)' : last.status === 'PROPOSED' ? 'researched, painted and asked for your approval' : last.status === 'NO_CHANGE' ? 'researched: the plan stays as it is' : `researched: ${last.status.toLowerCase().replace(/_/g, ' ')}`
  // The painting's own sentence may name a cost per click or an ACoS: it stays with the money.
  return {
    status: 'done', why: words, runId: last?.id ?? null, waiting,
    did: { lines: [words], counts: { proposed: s.proposed, shadow: s.shadow, noChange: s.noChange, held: s.held }, ...(last?.why ? { money: { lines: [`The hourly plan: ${last.why}`] } } : {}) },
  }
}

// ── ⑧ the bidding strategy ───────────────────────────────────────────────────────────────────────────────────────

/** The products the bidding-strategy lever watches, read once per tick (the tick object keys it). */
const modeWatchOfTick = new WeakMap<TickFacts, Promise<ModeWatched[]>>()

export const biddingStep: StepRunner = async (ctx) => {
  const { modeWatchProducts } = await import('./bidding-mode-load.js')
  if (!modeWatchOfTick.has(ctx.tick)) modeWatchOfTick.set(ctx.tick, modeWatchProducts())
  const watched = (await modeWatchOfTick.get(ctx.tick)!).find((w) => w.productId === ctx.productId && w.market === ctx.market)
  if (!watched) return { status: 'off', why: 'the bidding-strategy lever is OFF, locked or excluded for the product and each of its campaigns: no strategy decided' }
  const { runBiddingModeOnce } = await import('./bidding-mode-run.js')
  // A pause the state step makes (queued, asked or waiting) is a stop: the strategy is the stop's then.
  const stopping = new Map((ctx.records.state?.holds ?? []).map(([id, why]) => [id, `the product cycle's stops and state step: ${why}`]))
  const run = await runBiddingModeOnce({ now: ctx.tick.now, products: [watched], stopping })
  const failed = run.failed.find((f) => f.productId === ctx.productId)
  if (failed) return { status: 'failed', why: `the bidding-strategy run failed: ${failed.error}`, runId: run.runId }
  const mine = run.campaigns.filter((c) => c.productId === ctx.productId)
  const counts: Record<string, number> = {}
  for (const c of mine) { const k = c.action === 'switch' || c.action === 'revert' ? `${c.action} ${c.outcome}` : c.action; counts[k] = (counts[k] ?? 0) + 1 }
  const waiting: Waiting[] = mine.filter((c) => (c.outcome === 'asked' || c.outcome === 'waiting') && c.approvalId).map((c) => ({ what: `${c.action === 'revert' ? 'switch back' : 'bidding strategy of'} ${nameOf(ctx, c.campaignId)}`, approvalId: c.approvalId ?? null }))
  const moves = mine.filter((c) => c.action === 'switch' || c.action === 'revert')
  const lines = [
    ...(moves.length ? moves.map((c) => `${nameOf(ctx, c.campaignId)}: ${c.outcome === 'shadow' ? `would ${c.action} (shadow)` : `${c.action} ${c.outcome}`} — ${c.why}`) : [`${plural(mine.length, 'campaign')} decided: ${countsLine(counts) || 'nothing to change'}`]),
    ...run.tests.filter((t) => mine.some((c) => c.campaignId === t.campaignId)).map((t) => `${nameOf(ctx, t.campaignId)}: test ${t.status} — ${t.why}`),
    ...(run.weekly ? [] : ['new switches are decided on the weekly run (Monday, Europe/Rome)']),
  ]
  return {
    status: 'done', why: `${watched.level}${run.weekly ? ' (weekly)' : ''}: ${countsLine(counts) || 'no campaign'}`, runId: run.runId, waiting,
    did: { lines, counts: { ...counts, stored: mine.filter((c) => c.stored).length, acted: mine.filter((c) => c.outcome === 'queued' || c.outcome === 'asked').length, tests: run.tests.length } },
  }
}

export const CYCLE_RUNNERS: CycleRunners = { state: stateStep, terms: termsStep, negatives: negativesStep, harvest: harvestStep, structure: structureStep, money: moneyStep, bids: bidsStep, hours: hoursStep, bidding: biddingStep }

// ── The report's money ───────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** Ad sales in against ad spend out for the product's own campaigns: the data day and the 7 settled days to it (one read). */
export async function readMoneyInOut(own: readonly string[], dataDay: string, month: MoneyInOut['month'], planCurrency: string | null): Promise<MoneyInOut | null> {
  if (!own.length) return month ? { currency: planCurrency ?? 'EUR', day: null, week: null, month } : null
  const until = new Date(`${dataDay}T00:00:00Z`)
  const rows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['date', 'currencyCode'],
    where: { entityType: 'CAMPAIGN', adProduct: 'SPONSORED_PRODUCTS', localEntityId: { in: [...own] }, date: { gte: new Date(until.getTime() - 6 * DAY_MS), lte: until }, ...EXCLUDE_AMS_DAILY },
    _sum: { costMicros: true, sales7dCents: true, orders7d: true },
  })
  if (!rows.length && !month) return null
  const sum = (list: typeof rows) => ({
    spendCents: Math.round(list.reduce((n, r) => n + Number(r._sum.costMicros ?? 0n), 0) / 10_000),
    salesCents: list.reduce((n, r) => n + (r._sum.sales7dCents ?? 0), 0),
    orders: list.reduce((n, r) => n + (r._sum.orders7d ?? 0), 0),
  })
  const dayRows = rows.filter((r) => new Date(r.date).toISOString().slice(0, 10) === dataDay)
  const days = new Set(rows.map((r) => new Date(r.date).toISOString().slice(0, 10))).size
  return {
    currency: planCurrency ?? rows[0]?.currencyCode ?? 'EUR',
    day: dayRows.length ? sum(dayRows) : null,
    week: rows.length ? { ...sum(rows), days } : null,
    month,
  }
}
