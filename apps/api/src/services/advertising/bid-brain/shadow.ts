/**
 * BID BRAIN BB-3 — one run: for every keyword of the allowlisted Sponsored Products campaigns in IT and DE, decide the
 * bid (decide.ts) and store the decision next to what today's writers set. For a campaign the brain does not own it
 * never calls a write path: no mutation, no queue, no gate, no Amazon — the only rows it writes are its own
 * (BidBrainDecision, mode SHADOW).
 *
 * BB-6 — a campaign the brain OWNS (live.ts: the env ceiling `live` and a LIVE or HELD enrollment) has its `write`
 * decisions sent through the one bid path (live-writer.ts), inside the account dial and the brain's own caps; its rows
 * are stored with mode LIVE and what became of each write (`evidence.sent`). The markets are IT and DE plus every
 * market of an owned campaign.
 *
 *   stored    a decision that differs from the keyword's last one (action, layer, today's bid or the decided bid),
 *             plus the day's first decision of each keyword as a snapshot — so a run on unchanged facts writes nothing
 *   kept      30 days (older rows are deleted at the end of each run: Neon cost)
 *   mode      NEXUS_BID_BRAIN_MODE: off (no run) · shadow (default) · live (owned campaigns are written; the rest shadow)
 *   AB-2      the stop recipe of each owned campaign (stop-recipe.ts): while a stop or a Min-bid hour holds the whole
 *             campaign, every lane at 0 % and "up and down" switched to "down only"; when it ends, both back from the
 *             stop's memory in the same tick as the bids. The Owner's locks are read first (unreadable: the lanes and the
 *             strategy wait, the bids still go); the recipe's words join the why of the campaign's decisions
 *   AB-14     a step of the product cycle (brain/cycle-steps.ts): `scope` decides one product's own campaigns in its market
 *             (or, for the full run, leaves them), `raiseCaps` holds the raises the cycle's earlier steps hold (a pause, a
 *             budget cut, the money brake) beside the spend guard; the run counts its moves by direction (`moves`)
 *   BB-15     NEXUS_BID_BRAIN_NOWCAST=shadow (the default): each full run also decides the same keywords from the window
 *             that ends yesterday, maturity-weighted (nowcast.ts); the decisions and every write stay the settled ones,
 *             and where the two differ the stored why gains " · nowcast to …: would …" and the run's line counts them.
 *             The nowcast reads the run's step anchors re-keyed to its own data day (nowcast.ts nowcastLastSteps): a
 *             keyword the settled run already stepped today takes no second step there — in shadow, nor switched on
 *   BB-17     NEXUS_BID_BRAIN_INTRADAY=shadow (the default): the intraday brakes of the owned campaigns are read and the same
 *             keywords decided again with them (intradayEffects); the decisions and every write stay the ones without, the
 *             stored why of one a brake would change gains " · intraday (shadow): would …", and the run's line counts them.
 *             on: the brakes are in the facts (facts.ts), and the line counts what they changed
 *   BB-22     NEXUS_BID_BRAIN_HOUR_FACTORS=shadow (the default): each full run learns the hour factors of the products of
 *             the owned campaigns whose plan holds an hour (once a day, hour-factors-store.ts) and says beside the plan's
 *             what the learned one would do to this hour's cell; on: the cell's lanes move inside its limits where the
 *             product's brain owns the hours lever; off: nothing read
 *   BB-19     NEXUS_BID_BRAIN_RESPONSE=shadow (the default): each full run also finds each keyword's profit-best bid inside
 *             its band and the marginal ACoS of the last euro (response-explore.ts); the decisions stay the goal's, the
 *             stored why gains " · profit-best …", `evidence.response` the numbers, the run's line the count
 *   BB-20     NEXUS_BID_BRAIN_EXPLORE=shadow (the default): each full run also plans the day's explore and revive bids
 *             inside the market's explore budget (response-explore.ts) and logs them the same way; `on`: the picked
 *             keywords' decisions become layer explore / revive and are acted on like any other (the rest stay the goal's)
 *   BB-21     NEXUS_BID_BRAIN_PROBES=shadow (the default): each full run also steps, measures and plans the switchback
 *             probes that measure ε (probe.ts, probe-store.ts: the BidProbe ledger) and says what they would bid; `on`:
 *             a LIVE probe's arm (a campaign the brain owns) is the decision, layer probe, acted on like any other
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { publishEvent } from '../../../lib/events/publish.js'
import { engineGuardNote, openEngineGuard, type EngineGuard, type EngineGuardReport } from '../ads-engine-guard.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { applyLaneDirectives, laneWords, type LaneName } from './recipe.js'
import { buildFacts, isPlanFloorMark, STRATEGY_HOLD_KIND, type CampaignRow, type MarketRows, type RunRows } from './facts.js'
import { BRAIN_ACTOR, brainOwnedCampaignIds } from './live.js'
import {
  placementReportWords, strategyReportWords, writeOwnedDecisions, writeOwnedPlacements, writeOwnedStrategies, writeReportWords,
  type PlacementReport, type PlacementWrite, type StrategyReport, type StrategyWrite, type WriteReport,
} from './live-writer.js'
import { laneOf, minBidLanes, type PlanHour } from './plan-hour.js'
import { stampPlanReceipts } from './plans.js'
import { ownerLeverLocks, type LeverLocks } from '../brain/owner-brakes.js'
import { campaignKills, killWords } from '../brain/kill-switch.js'
import { campaignStopOf, fullLanes, strategyStep, type CampaignStop } from './stop-recipe.js'
import { strategySwitchesToday } from './stop-memory.js'
import { loadMarket, loadNowcastEvidence, loadRun, SHADOW_MARKETS, type LastWrite, type LoadedMarket, type PreviousDecision } from './load.js'
import { compareNowcast, nowcastLastSteps, nowcastMode, nowcastOnNotes, nowcastSummaryWords, runForRows, youngPctOf, type NowcastShadowSummary } from './nowcast.js'
import { anyBrake, compareIntraday, intradaySummaryWords, type IntradaySummary } from './intraday.js'
import { hourFactorsForRun } from './hour-factors-store.js'
import { upgradesShadow, type UpgradesSummary } from './response-explore.js'
import { responseSummaryWords } from './response.js'
import { exploreSummaryWords } from './explore.js'
import { probeSummaryWords } from './probe.js'

export type BrainMode = 'off' | 'shadow' | 'live'

/** BB-10 — one write the brain sent to a campaign it owns, as the run-completed event carries it (auto-undo's interface). */
export interface BrainWriteRecord { campaignId: string; actionLogId: string | null; entityId: string; field: 'bid' | 'placementBidding'; from: number | null; to: number | null }
/** Decisions are kept this many days. */
export const DECISION_DAYS_KEPT = 30

/**
 * ONE BRAIN AB-14 — which campaigns one run decides. `campaignIds` + `market`: only these, in that market (a product cycle's
 * own campaigns); `skipCampaignIds`: all but these (the full run, while a product cycle runs them). Absent: every
 * allowlisted one. The market is read whole either way, so every pooled estimate stays the full run's.
 */
export interface BrainRunScope { campaignIds?: ReadonlySet<string>; skipCampaignIds?: ReadonlySet<string>; market?: string }

/** AB-14 — a campaign's raise cap: the spend guard's why and the cycle's, joined (either alone when the other is absent). Pure. */
export function mergeRaiseCaps(guard: ReadonlyMap<string, string> | undefined, caps: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map(guard ?? [])
  for (const [campaignId, why] of caps) out.set(campaignId, out.has(campaignId) ? `${out.get(campaignId)}; ${why}` : why)
  return out
}

/** The env ceiling. Anything unrecognised is shadow (never live by accident). */
export function bidBrainMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_MODE): BrainMode {
  const v = (env ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' ? 'off' : v === 'live' ? 'live' : 'shadow'
}

export interface ShadowRun {
  runId: string
  mode: BrainMode
  /** BB-6 — `owned`: the market's campaigns the brain owns this run; `writes`: what became of their write decisions. */
  markets: Array<{ market: string; decided: number; stored: number; byAction: Record<string, number>; byLayer: Record<string, number>; brakes: string[]; /** AB-14 — the market's run failed (its words; also in brakes). */ error?: string; /** AB-14 — a product cycle's run: which way its write decisions go. */ moves?: { raise: number; lower: number; raisedBy: Record<string, number> }; owned?: number; writes?: WriteReport | null; placements?: PlacementReport; strategies?: StrategyReport; brainWrites?: BrainWriteRecord[]; nowcast?: NowcastShadowSummary; nowcastOn?: { dataDay: string; curve: string; youngPct: number }; /** BB-19 / BB-20 */ upgrades?: UpgradesSummary; /** BB-17 — what the intraday brakes hold and change (on) or would (shadow). */ intraday?: IntradaySummary }>
  pruned: number
  /** BB-6 — the dial and the caps the live writes ran under (absent: nothing owned had to move). */
  guard?: EngineGuardReport
}

function count(rows: readonly Decision[], key: 'action' | 'layer'): Record<string, number> {
  const acc: Record<string, number> = {}
  for (const d of rows) acc[d[key]] = (acc[d[key]] ?? 0) + 1
  return acc
}

/** Whether a decision is worth a row: it changed since the keyword's last one, or it is the day's first. */
export function rowKind(d: Decision, prev: PreviousDecision | undefined, now: Date): 'change' | 'snapshot' | null {
  if (!prev || prev.action !== d.action || prev.layer !== d.layer || prev.currentCents !== d.currentCents || prev.decidedCents !== d.bidCents) return 'change'
  return prev.createdAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10) ? 'snapshot' : null
}

/**
 * The step the next run anchors on: this decision's own, else the last one of the same data day. BB-15 follow-up — the
 * last one as the run read it (`run.lastSteps`: the previous decision's, re-keyed to the nowcast's data day when the rows
 * were read with the nowcast on), so a step re-keyed on the day the switch goes on is carried, not dropped.
 */
function carriedStep(d: Decision, last: { dataDay: string; fromCents: number; toCents: number } | undefined) {
  if (d.step) return d.step
  return last && last.dataDay === d.dataDay ? last : null
}

const dec = (x: number | null | undefined, places = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places)

/**
 * Decide and store one market; BB-6 — and send the write decisions of the campaigns the brain owns. BB-7 — their hourly
 * plan's hour too: its placement % (one write per campaign), its Min-bid floors (an entry recorded for the anti-flap),
 * and the plan's receipt. `onlyOwned`: a between-slots tick decides only the campaigns the brain owns.
 */
export async function shadowMarket(market: string, ctx: { runId: string; mode: BrainMode; now: Date; clockNow?: Date; onlyOwned?: boolean; guard?: () => Promise<EngineGuard>; scope?: BrainRunScope; raiseCaps?: ReadonlyMap<string, string> }): Promise<ShadowRun['markets'][number]> {
  // AB-14 — a product cycle decides its product's own campaigns; the full run leaves the ones a cycle runs. The market is
  // read whole either way, so every pooled estimate is the one the full run makes.
  const inScope = (campaignId: string) => (!ctx.scope?.campaignIds || ctx.scope.campaignIds.has(campaignId)) && !ctx.scope?.skipCampaignIds?.has(campaignId)
  // BB-7 review — a between-slots tick reads the campaigns the brain owns only, and no evidence (load.ts loadMarket).
  const ownedAll = ctx.onlyOwned ? await brainOwnedCampaignIds() : null
  if (ownedAll && !ownedAll.size) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const rows = await loadMarket(market, { now: ctx.now, ...(ownedAll ? { campaignIds: ownedAll, light: true } : {}) })
  if (!rows.targets.length) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  // BB-6 — the campaigns the brain owns write their decisions; every other campaign stays shadow, whatever the env says.
  const allowlisted = [...rows.campaigns.values()].filter((c) => c.allowlisted && inScope(c.id)).map((c) => c.id)
  if (ctx.scope?.campaignIds && !allowlisted.length) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const owned = ctx.mode === 'live' && allowlisted.length ? await brainOwnedCampaignIds(allowlisted) : new Set<string>()
  if (ctx.onlyOwned && !owned.size) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const loaded = await loadRun(rows, ctx.now, { owned, clockNow: ctx.clockNow })
  const { lastWrites, previous } = loaded
  // BB-15 follow-up — read with the nowcast on, the step anchors are re-keyed to its data day (no second step that day).
  const anchored = runForRows(rows, loaded.run)
  // AB-14 — the raises an earlier step of the product cycle holds (a pause it makes, a budget it cuts, the money brake),
  // beside the brain's own spend guard: decide.ts lets no goal raise through, and no placement % rises.
  const capped = ctx.raiseCaps?.size ? { ...anchored, spendGuard: mergeRaiseCaps(anchored.spendGuard, ctx.raiseCaps) } : anchored
  // BB-22 — the learned hour factors (NEXUS_BID_BRAIN_HOUR_FACTORS off · shadow, the default: their moves said in the why,
  // nothing changed · on: the approved plan's lanes moved inside each cell's limits where the product's brain owns hours).
  const hourFactors = await hourFactorsForRun(market, capped, { now: ctx.now, clockNow: ctx.clockNow ?? ctx.now, light: !!rows.light })
  const run = hourFactors.run
  const groupOf = new Map(rows.targets.map((t) => [t.id, t.adGroupId]))
  const campaignOf = (targetId: string): string => {
    const adGroupId = groupOf.get(targetId)
    return adGroupId ? rows.adGroups.get(adGroupId)?.campaignId ?? '' : ''
  }
  const facts = buildFacts(rows, run).filter((f) => inScope(campaignOf(f.targetId)) && (!ctx.onlyOwned || owned.has(campaignOf(f.targetId))))
  const decided = facts.map((f) => decide(f))
  // BB-19 / BB-20 — the profit-best bid beside the goal's, and the day's explore plan (full runs only): words and evidence
  // for the stored rows; the decisions stay the goal's unless NEXUS_BID_BRAIN_EXPLORE=on picks a keyword. A run that decides
  // only some campaigns plans over the whole market (`marketFacts`), so the picks of all runs fit one budget.
  const partial = !!ctx.scope?.campaignIds || !!ctx.scope?.skipCampaignIds || !!ctx.raiseCaps?.size
  const upgrades = rows.light ? null : await upgradesShadow(rows, {
    facts, decisions: decided, campaignOf, now: ctx.now, lastWrites, owned, runId: ctx.runId, ...(partial ? { marketFacts: () => buildFacts(rows, anchored) } : {}),
  })
  const decisions = upgrades?.decisions ?? decided
  // BB-15 — the nowcast in shadow (full runs only): words for the stored why; the decisions above are the ones that count.
  // Switched on (the rows were read with it): the why of a decision resting on young days says how much they carry.
  const nowcast = !rows.light && nowcastMode() === 'shadow'
    ? await nowcastShadow(rows, run, facts, decided, ctx.now)
    : rows.nowcast ? { notes: nowcastOnNotes(decisions, rows.nowcast.youngShare, rows.dataDay), summary: null } : null
  // BB-17 — the intraday brakes: switched on they are in the facts already (the decisions carry them, in their why); in
  // shadow the decisions stay without them, and where one would change the stored why says so. Both count in the line.
  // Compared on decide's own decisions (before BB-20's explore picks, which never take a braked keyword when on).
  const intraday = run.intraday ? intradayEffects(rows, run, facts, decided, campaignOf) : null
  const toWrite = owned.size
    ? decisions.filter((d) => d.action === 'write' && owned.has(campaignOf(d.targetId))).map((decision) => ({ campaignId: campaignOf(decision.targetId), market, decision }))
    : []
  const guard = owned.size && ctx.guard ? await ctx.guard() : null
  // ONE BRAIN AB-15 — the Owner's kill switch: a lever he stopped gets no write from the bid brain (each decision deferred,
  // the kill in its words); the gate refuses it as well. Nothing stopped in the business: one remembered query, no change.
  const killed = guard ? await readBidBrainKills([...owned]) : NO_KILLS
  const sent = toWrite.length && guard ? await writeOwnedDecisions(killed.size ? toWrite.filter((w) => !killed.get(w.campaignId)?.bids) : toWrite, { runId: ctx.runId, guard }) : null
  if (sent && killed.size) deferKilled(sent, toWrite, killed)
  // AB-2 — the stop recipe of each owned campaign: which stop holds it whole, and the Owner's locks on its lanes and strategy.
  const recipeOn = !!guard && !run.marketBrakes.length
  const states = recipeOn ? campaignStates(facts, decisions, owned, campaignOf, run.planHours) : new Map<string, CampaignState>()
  const locks = recipeOn ? await readLeverLocks([...states.keys()]) : new Map<string, LeverLocks>()
  // BB-7 — the plan's hour of each owned campaign: its placements (none while braked or paused; all at 0 % in a Min-bid hour
  // or a stop, AB-2; given back from the stop's memory when it ends) …
  const placementList = recipeOn ? notKilled(placementWrites(rows, facts, decisions, owned, campaignOf, run.planHours, { locks, states }), killed, 'placements') : []
  const placed = recipeOn ? await writeOwnedPlacements(placementList, { runId: ctx.runId, guard: guard! }) : null
  // … AB-2: the bidding strategy, down only for the stop and back after it (the anti-flap counts today's switches) …
  const strategyList = recipeOn ? notKilled(strategyWrites(rows, states, locks, await strategySwitchesToday(restoreCandidates(rows, states), ctx.clockNow ?? ctx.now), strategyHolds(run.holds)), killed, 'biddingStrategy') : []
  const switched = strategyList.length ? await writeOwnedStrategies(strategyList, { runId: ctx.runId, guard: guard! }) : null
  const recipe = recipeWords(placementList, strategyList)
  // … a new Min-bid entry for each campaign the brain floored this run (rank-defend's anti-flap, its count shared) …
  if (sent) await recordMinBidEntries(rows, decisions, sent, run, campaignOf)
  // … the floors' memory, where the old engines' give-back reads it, so a hand-back never strands a bid at the floor …
  if (sent) await rememberFloors(rows, decisions, sent, run.planHours, campaignOf, ctx.clockNow ?? ctx.now)
  // … and the plan's receipt (what it holds now), as rank-defend stamps its own.
  if (run.planHours?.size) await stampPlanReceipts(run.planHours, ctx.clockNow ?? ctx.now)
  const data = decisions.flatMap((d) => {
    // A light tick has no goal: its no_goal holds say nothing new and are not stored (the full run's decision stands).
    if (rows.light && d.layer === 'no_goal') return []
    const prev = previous.get(d.targetId)
    const kind = rowKind(d, prev, ctx.now)
    if (!kind) return []
    const adGroupId = groupOf.get(d.targetId) ?? null
    const campaignId = campaignOf(d.targetId)
    const last: LastWrite | undefined = lastWrites.get(d.targetId)
    const outcome = sent?.byTarget.get(d.targetId)
    return [{
      runId: ctx.runId,
      mode: owned.has(campaignId) ? 'LIVE' : 'SHADOW', kind, marketplace: market, campaignId, adGroupId, targetId: d.targetId,
      action: d.action, layer: d.layer, currentCents: d.currentCents, decidedCents: d.bidCents, goalBidCents: d.goalBidCents,
      aim: dec(d.goal?.aim), bandLo: dec(d.goal?.lo), bandHi: dec(d.goal?.hi), expectedAcos: dec(d.expectedAcos), confidence: dec(d.confidence),
      dataDay: new Date(`${d.dataDay}T00:00:00Z`), lastWriter: last?.actor ?? null, lastWriteAt: last?.at ?? null, why: withNote(withNote(withNote(withNote(recipe.has(campaignId) ? `${d.why} · ${recipe.get(campaignId)}` : d.why, upgrades?.notes.get(d.targetId)), nowcast?.notes.get(d.targetId)), hourFactors.notes.get(campaignId)), intraday?.notes.get(d.targetId)),
      evidence: { step: d.step, lastStep: carriedStep(d, run.lastSteps.get(d.targetId)), clash: d.clash, placements: d.placements.length ? d.placements : undefined, sent: outcome, ...upgrades?.evidence.get(d.targetId) } as unknown as Prisma.InputJsonObject,
      createdAt: ctx.now,
    }]
  })
  if (data.length) await prisma.bidBrainDecision.createMany({ data })
  return {
    market, decided: decisions.length, stored: data.length, byAction: count(decisions, 'action'), byLayer: count(decisions, 'layer'), brakes: run.marketBrakes as string[],
    ...(ctx.scope?.campaignIds ? { moves: movesOf(decisions, campaignOf) } : {}),
    ...(owned.size ? { owned: owned.size, writes: sent, ...(placed && (placed.written || placed.refused || placed.deferred || placed.locked || placed.waiting) ? { placements: placed } : {}), ...(switched && switched.byCampaign.size ? { strategies: switched } : {}) } : {}),
    ...(owned.size ? { brainWrites: brainWriteRecords(decisions, sent, placed, campaignOf) } : {}),
    ...(nowcast?.summary ? { nowcast: nowcast.summary } : {}),
    ...(rows.nowcast ? { nowcastOn: { dataDay: rows.dataDay, curve: rows.nowcast.curve, youngPct: youngPctOf(rows.nowcast.totals) } } : {}),
    ...(upgrades?.summary ? { upgrades: upgrades.summary } : {}),
    ...(intraday ? { intraday: intraday.summary } : {}),
  }
}

/**
 * BB-17 — the intraday brakes' effect on one market's run: the same keywords decided without them and with them, matched by
 * target (intraday.ts compareIntraday). Switched on, the run's own decisions carry them and the plain ones are decided again
 * from facts built without them; in shadow the run's decisions are the plain ones and the braked ones are decided from facts
 * built with them switched on. Nothing is stored or sent here: the notes go into the stored why, the counts into the line.
 */
export function intradayEffects(rows: MarketRows, run: RunRows, facts: readonly TargetFacts[], decisions: readonly Decision[], campaignOf: (targetId: string) => string): ReturnType<typeof compareIntraday> {
  const ir = run.intraday!
  if (![...ir.brakes.values()].some(anyBrake)) return compareIntraday(decisions, decisions, ir, campaignOf)
  const wanted = new Set(facts.map((f) => f.targetId))
  const rebuilt = buildFacts(rows, { ...run, intraday: ir.mode === 'on' ? undefined : { ...ir, mode: 'on' } }).filter((f) => wanted.has(f.targetId)).map((f) => decide(f))
  return ir.mode === 'on' ? compareIntraday(rebuilt, decisions, ir, campaignOf) : compareIntraday(decisions, rebuilt, ir, campaignOf)
}

/** AB-14 — which way the run's write decisions go (stored or not), and how many raises per campaign. Pure. */
export function movesOf(decisions: readonly Decision[], campaignOf: (targetId: string) => string): { raise: number; lower: number; raisedBy: Record<string, number> } {
  const out = { raise: 0, lower: 0, raisedBy: {} as Record<string, number> }
  for (const d of decisions) {
    if (d.action !== 'write') continue
    if (d.bidCents > d.currentCents) {
      out.raise++
      const c = campaignOf(d.targetId)
      out.raisedBy[c] = (out.raisedBy[c] ?? 0) + 1
    } else if (d.bidCents < d.currentCents) out.lower++
  }
  return out
}

/** BB-15 — a stored why with the nowcast's words after it (none: the why unchanged). */
const withNote = (why: string, note: string | undefined) => (note ? `${why} · ${note}` : why)

/**
 * BB-15 — the nowcast in shadow: the same keywords decided again from the window that ends yesterday, every keyword-day
 * weighted by its copy's maturity (load.ts loadNowcastEvidence), with the run's other facts unchanged (the TACoS ad sales
 * stay the settled window's, as the family sales they are compared with). Null with no usable curve for the market; a
 * failure is logged and changes nothing — the settled decisions stand.
 */
async function nowcastShadow(rows: LoadedMarket, run: RunRows, facts: readonly TargetFacts[], decisions: readonly Decision[], now: Date): Promise<{ notes: Map<string, string>; summary: NowcastShadowSummary } | null> {
  try {
    const nc = await loadNowcastEvidence(rows, { now, settledUntil: new Date(`${rows.dataDay}T00:00:00Z`) })
    if (!nc) return null
    const wanted = new Set(facts.map((f) => f.targetId))
    // The step anchors keyed to the settled day are this run-day's steps: re-keyed to the nowcast's day, so a keyword the
    // settled run already stepped today takes no second step here (it would count as a false "differ").
    const nowRun = { ...run, lastSteps: nowcastLastSteps(run.lastSteps, rows.dataDay, nc.dataDay) }
    const nowFacts = buildFacts({ ...rows, evidence: nc.evidence, dataDay: nc.dataDay }, nowRun).filter((f) => wanted.has(f.targetId))
    const youngPct = youngPctOf(nc.totals)
    return compareNowcast(
      facts.map((f, i) => ({ facts: f, decision: decisions[i] })),
      nowFacts.map((f) => ({ facts: f, decision: decide(f) })),
      nc.youngShare,
      { dataDay: nc.dataDay, curve: nc.curve, youngPct },
    )
  } catch (err) {
    logger.warn('[bid-brain] nowcast shadow failed — the settled decisions stand, nothing changes', { market: rows.market, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** A bid write's recorded `bidCents` (an action log's payload), or null. */
const bidOf = (payload: unknown): number | null => {
  const v = payload && typeof payload === 'object' ? Number((payload as { bidCents?: unknown }).bidCents) : NaN
  return Number.isFinite(v) ? v : null
}

/** BB-10 — what this market's run sent: each queued keyword bid (its action-log row) and each placement write. Pure. */
export function brainWriteRecords(decisions: readonly Decision[], sent: WriteReport | null, placed: PlacementReport | null, campaignOf: (targetId: string) => string): BrainWriteRecord[] {
  const out: BrainWriteRecord[] = []
  for (const d of decisions) {
    const o = sent?.byTarget.get(d.targetId)
    if (o?.sent !== 'queued') continue
    out.push({ campaignId: campaignOf(d.targetId), actionLogId: o.actionLogId, entityId: d.targetId, field: 'bid', from: d.currentCents, to: d.bidCents })
  }
  for (const [campaignId, p] of placed?.byCampaign ?? []) {
    if (p.sent === 'written') out.push({ campaignId, actionLogId: null, entityId: campaignId, field: 'placementBidding', from: null, to: null })
  }
  return out
}

/** AB-2 — one owned campaign this tick: a fact of it (its plan and limits), its highest bid, braked, and the stop holding it whole. */
export interface CampaignState {
  f: TargetFacts
  /** The higher of today's bid and the decided one, the campaign's highest: what each lane's ceiling is measured against. */
  maxBid: number
  /** Every keyword braked (a paused campaign, or every ad group paused): nothing is written for the campaign. */
  braked: boolean
  /** The stop (or the plan's Min-bid hour) holding every keyword that is not braked; null: it serves (stop-recipe.ts). */
  stop: CampaignStop | null
}

/** AB-2 — each owned campaign with a keyword decided this tick, and the stop that holds it whole. Pure. */
export function campaignStates(facts: readonly TargetFacts[], decisions: readonly Decision[], owned: ReadonlySet<string>, campaignOf: (targetId: string) => string, hours: ReadonlyMap<string, PlanHour> | undefined): Map<string, CampaignState> {
  const byCampaign = new Map<string, { f: TargetFacts; maxBid: number; braked: boolean; items: Array<{ f: TargetFacts; d: Decision }> }>()
  facts.forEach((f, i) => {
    const campaignId = campaignOf(f.targetId)
    if (!owned.has(campaignId)) return
    const d = decisions[i]
    // The higher of today's bid and the decided one: a lowering waits in the 5-minute queue (or is refused), and the
    // placement must stay within the ceiling against the bid Amazon may still hold.
    const bid = d.action === 'write' ? Math.max(d.currentCents, d.bidCents) : d.currentCents
    // A paused ad group brakes its own keywords only: the campaign's placements wait only when every keyword is braked.
    const braked = !!f.brakes?.length
    const e = byCampaign.get(campaignId)
    if (!e) byCampaign.set(campaignId, { f, maxBid: bid, braked, items: [{ f, d }] })
    else { e.maxBid = Math.max(e.maxBid, bid); e.braked &&= braked; e.items.push({ f, d }) }
  })
  return new Map([...byCampaign].map(([campaignId, e]) => [campaignId, { f: e.f, maxBid: e.maxBid, braked: e.braked, stop: campaignStopOf(e.items, !!hours?.get(campaignId)?.key) }]))
}

/** The key a stop-recipe placement write is recorded under when no plan hour names one. */
const STOP_RECIPE_KEY = 'stop-recipe'

const pinWords = (what: string, c: Pick<CampaignRow, 'pinnedBy'>) => `held by its ${what} pin${c.pinnedBy ? ` (${c.pinnedBy})` : ''}`
/** AB-2 — "hands off the placements" (Campaign.pinPlacement): the gate refuses an automatic placement write, so none is sent. */
export const placementPin = (c: Pick<CampaignRow, 'pinPlacement' | 'pinnedBy'>): string | null => (c.pinPlacement ? pinWords('placements', c) : null)
/** AB-2 — "hands off the bids" (Campaign.pinBids; the strategy is a bids setting): the gate refuses an automatic strategy write. */
export const strategyPin = (c: Pick<CampaignRow, 'pinBids' | 'pinnedBy'>): string | null => (c.pinBids ? pinWords('bids', c) : null)
const UNREADABLE_WAIT = 'the Owner\'s locks could not be read: the give-back waits for the next tick (the saved placements are kept)'

/** The saved lanes with the Owner's locked value over them (a lane his value names; the others as saved). Pure. */
function ownerValue(base: ReadonlyArray<{ placement: string; percentage: number }>, value: Partial<Record<string, number>> | null): Array<{ placement: string; percentage: number }> {
  if (!value) return [...base]
  return base.map((b) => { const v = value[laneOf(b.placement)]; return typeof v === 'number' && MANAGED.has(b.placement) ? { placement: b.placement, percentage: v } : b })
}
const MANAGED: ReadonlySet<string> = new Set(['PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH'])

/**
 * BB-7 — each owned campaign whose hourly plan sets placements this hour, with its highest base bid after this run. AB-2 —
 * and the stop recipe's lanes: a campaign a stop or the plan's Min-bid hour holds whole gets every lane at 0 % (the lanes
 * live saved first) — past the Owner's lock, as a stop beats a pinned bid; one whose stop ended gets the saved lanes back in
 * one write, the hour's own lanes over them, except a lane the Owner locked: it goes back to his value. The placements pin
 * holds every write (the gate would refuse it); locks that cannot be read hold the give-back (live-writer.ts writes none).
 */
export function placementWrites(
  rows: { market: string; campaigns: ReadonlyMap<string, CampaignRow> }, facts: readonly TargetFacts[], decisions: readonly Decision[], owned: ReadonlySet<string>,
  campaignOf: (targetId: string) => string, hours: ReadonlyMap<string, PlanHour> | undefined,
  opts: { locks?: ReadonlyMap<string, LeverLocks>; states?: ReadonlyMap<string, CampaignState> } = {},
): PlacementWrite[] {
  const out: PlacementWrite[] = []
  const states = opts.states ?? campaignStates(facts, decisions, owned, campaignOf, hours)
  for (const [campaignId, e] of states) {
    const hour = hours?.get(campaignId)
    const c = rows.campaigns.get(campaignId)
    if (e.braked || !c || c.status !== 'ENABLED') continue
    const own = opts.locks?.get(campaignId)
    const pinned = placementPin(c)
    const common = { campaignId, market: rows.market, current: c.placements ?? [], maxBidCents: e.maxBid, dataDay: e.f.dataDay, raiseCap: e.f.raiseCap ?? null, ...(pinned ? { pinned } : {}) }
    const ownedLocks = !!own?.placements || !!own?.lanes.size
    // Live fix 10-08 — the plan's Min-bid hour: every placement lane to 0 % in the same tick as the keyword floors (the
    // previous hour's % stayed and lifted the floor: 3¢ × (1 + 300 %) = 12¢ at top of search). AB-2 — every stop that holds
    // the whole campaign too (the plan's serving hour would otherwise set its lanes over the stop's 3¢), the Owner's lock
    // passed. No placement rule raises a lane here. A Min-bid floor with no plan hour (a mark) still writes none.
    if (e.stop) {
      const note = e.stop.kind === 'min_bid_hour' ? e.f.planNote ?? 'Min-bid hour — every placement at 0 %' : `${e.stop.words} — every placement at 0 %`
      const passes = ownedLocks ? ' — the stop passes the Owner\'s lock, as a stop passes a pinned bid; his value comes back when it ends' : ''
      out.push({ ...common, lanes: minBidLanes(c.biddingStrategy), recipe: 'stop', key: hour?.key ?? STOP_RECIPE_KEY, note: `${note}${passes}`, recipeWhy: pinned ? `stop recipe: placements ${pinned}: not set to 0 %` : `stop recipe: every placement at 0 %${passes}` })
      continue
    }
    // BB-9's placement rules shape the plan's lanes first (as decide does); a rule's floor may add a lane on its own.
    const lanes = applyLaneDirectives(e.f.lanes ?? [], e.f.laneDirectives)
    const planned = (!!hour?.key || !!e.f.laneDirectives?.length) && lanes.length > 0
    const planWords = e.f.planNote ?? (hour ? `hourly plan ${hour.name}` : 'placement rules')
    // AB-2 — the stop ended: the lanes saved when it began come back, the hour's own lanes over them, in one write — a lane
    // the Owner locked to his value (his lock's, else the saved one), never the plan's. Unreadable locks: it waits.
    if (c.savedPlacements) {
      const key = hour?.key ?? (planned ? 'placement-rules' : STOP_RECIPE_KEY)
      if (pinned) {
        out.push({ ...common, lanes: [], base: fullLanes(c.savedPlacements), recipe: 'restore', key, note: 'the stop ended', recipeWhy: `stop ended: placements ${pinned}: left as they are until the pin is lifted (the saved ones are kept)` })
        continue
      }
      if (own?.unreadable) {
        out.push({ ...common, lanes: [], base: fullLanes(c.savedPlacements), recipe: 'restore', key, note: 'the stop ended', wait: UNREADABLE_WAIT, recipeWhy: `stop ended: ${UNREADABLE_WAIT}` })
        continue
      }
      if (own?.placements) {
        out.push({ ...common, lanes: [], base: ownerValue(fullLanes(c.savedPlacements), own.placements.value), recipe: 'restore', key, note: `the stop ended — the placements go back to the Owner's value (${own.placements.words})`, recipeWhy: `stop ended: the placements go back to the Owner's value (${own.placements.words})` })
        continue
      }
      const lockedLanes = [...(own?.lanes ?? new Map<string, string>())]
      const mine = planned ? lanes.filter((l) => !own?.lanes.has(l.lane)) : []
      const lockWords = lockedLanes.length ? ` (${lockedLanes.map(([lane, by]) => `${laneWords(lane as LaneName)} ${by}: back to its value before the stop`).join(', ')})` : ''
      out.push({ ...common, lanes: mine, base: fullLanes(c.savedPlacements), ...(lockedLanes.length ? { fixedLanes: lockedLanes.map(([lane]) => lane) } : {}), recipe: 'restore', key, note: `the stop ended — the placements saved when it began come back${mine.length ? ` under ${planWords}` : ''}${lockWords}`, recipeWhy: `stop ended: the placements saved when it began come back${lockWords}` })
      continue
    }
    if (!planned) continue
    // The hour's plan: a placements lever the Owner locked is not written, a locked lane keeps its %; unreadable locks: it waits.
    out.push({ ...common, lanes, key: hour?.key ?? 'placement-rules', note: planWords, ...(own ? { locks: own } : {}), ...(own?.unreadable ? { wait: 'the Owner\'s locks could not be read: the hour\'s placements wait for the next tick' } : {}) })
  }
  return out
}

let locksUnreadableSaid = false
/**
 * AB-2 — the Owner's locks of the owned campaigns' lanes and strategies. Unreadable: every campaign is marked so — its
 * give-back and its plan's placements wait, nothing is dropped, a stop still lowers — logged once until a read succeeds.
 */
/** AB-15 — per owned campaign, the levers of the bid brain the Owner's kill switch stopped, each with the kill in words. */
export type BidBrainKills = Map<string, Partial<Record<'bids' | 'placements' | 'biddingStrategy', string>>>
const NO_KILLS: BidBrainKills = new Map()
let killsUnreadableSaid = false

/**
 * AB-15 — the kill switches on the bid brain's levers of its owned campaigns. A failed read holds every write of these
 * campaigns this tick (as the gate would: it cannot tell either) — tried again next tick, nothing dropped.
 */
export async function readBidBrainKills(campaignIds: readonly string[]): Promise<BidBrainKills> {
  if (!campaignIds.length) return NO_KILLS
  try {
    const kills = await campaignKills(campaignIds, ['bids', 'placements', 'biddingStrategy'])
    killsUnreadableSaid = false
    if (!kills.size) return NO_KILLS
    return new Map([...kills].map(([id, k]) => [id, Object.fromEntries(Object.entries(k).map(([lever, kill]) => [lever, killWords(kill!)]))]))
  } catch (err) {
    if (!killsUnreadableSaid) logger.warn('[bid-brain] could not read the kill switches — the owned campaigns\' writes wait this tick (nothing dropped)', { error: err instanceof Error ? err.message : String(err) })
    killsUnreadableSaid = true
    const why = 'the kill switches could not be read: the write waits for the next tick'
    return new Map(campaignIds.map((id) => [id, { bids: why, placements: why, biddingStrategy: why }]))
  }
}

/** AB-15 — the writes of a list whose campaign's lever is not stopped. Pure. */
export function notKilled<T extends { campaignId: string }>(list: T[], killed: BidBrainKills, lever: 'placements' | 'biddingStrategy'): T[] {
  return killed.size ? list.filter((w) => !killed.get(w.campaignId)?.[lever]) : list
}

/** AB-15 — each keyword write of a stopped campaign recorded as deferred, with the kill as its why. */
export function deferKilled(sent: WriteReport, writes: ReadonlyArray<{ campaignId: string; decision: Decision }>, killed: BidBrainKills): void {
  for (const w of writes) {
    const why = killed.get(w.campaignId)?.bids
    if (!why || w.decision.action !== 'write' || w.decision.bidCents === w.decision.currentCents) continue
    sent.deferred++
    sent.byTarget.set(w.decision.targetId, { sent: 'deferred', why })
  }
}

export async function readLeverLocks(campaignIds: readonly string[]): Promise<Map<string, LeverLocks>> {
  if (!campaignIds.length) return new Map()
  try {
    const out = await ownerLeverLocks(campaignIds)
    locksUnreadableSaid = false
    return out
  } catch (err) {
    if (!locksUnreadableSaid) logger.warn('[bid-brain] could not read the Owner\'s locks — the stop recipe\'s give-backs wait (nothing dropped); tried again each tick', { error: err instanceof Error ? err.message : String(err) })
    locksUnreadableSaid = true
    return new Map(campaignIds.map((id) => [id, { unreadable: true as const, placements: null, lanes: new Map<string, string>(), biddingStrategy: null }]))
  }
}

/** AB-2 — the campaigns whose switch back after a stop the anti-flap must count: no stop now, a strategy saved. */
export function restoreCandidates(rows: { campaigns: ReadonlyMap<string, CampaignRow> }, states: ReadonlyMap<string, CampaignState>): string[] {
  return [...states].filter(([id, e]) => !e.stop && !!rows.campaigns.get(id)?.savedStrategy).map(([id]) => id)
}

/** AB-2 — a person's own bidding strategy per campaign (an open STRATEGY hold), in words: "user:x until 2026-12-07". */
export function strategyHolds(holds: ReadonlyArray<{ campaignId: string; targetId: string | null; kind: string; by: string; until: Date | null }>): Map<string, string> {
  return new Map(holds.filter((h) => h.kind === STRATEGY_HOLD_KIND && h.targetId == null).map((h) => [h.campaignId, `${h.by}${h.until ? ` until ${h.until.toISOString().slice(0, 10)}` : ''}`]))
}

/**
 * AB-2 — each owned campaign's bidding-strategy step (stop-recipe.ts strategyStep): down only while a stop holds it whole
 * (past the Owner's lock; not past a person's own strategy or the bids pin), back after it (to the Owner's value where he
 * locked it), the anti-flap obeyed. None while it is braked or not enabled (the memory waits). Pure.
 */
export function strategyWrites(
  rows: { market: string; campaigns: ReadonlyMap<string, CampaignRow> }, states: ReadonlyMap<string, CampaignState>, locks: ReadonlyMap<string, LeverLocks>,
  switches: ReadonlyMap<string, number>, held: ReadonlyMap<string, string> = new Map(),
): StrategyWrite[] {
  const out: StrategyWrite[] = []
  for (const [campaignId, e] of states) {
    const c = rows.campaigns.get(campaignId)
    if (e.braked || !c || c.status !== 'ENABLED') continue
    const own = locks.get(campaignId)
    const step = strategyStep({
      stop: e.stop, current: c.biddingStrategy ?? null, saved: c.savedStrategy ?? null, lock: own?.biddingStrategy ?? null, locksUnreadable: !!own?.unreadable,
      pinned: strategyPin(c), held: held.get(campaignId) ?? null, switchesToday: switches.get(campaignId) ?? 0,
    })
    if (!step) continue
    out.push({ campaignId, market: rows.market, from: c.biddingStrategy ?? null, step, layer: e.stop ? e.stop.kind : 'restore', dataDay: e.f.dataDay })
  }
  return out
}

/** AB-2 — the stop recipe of each campaign it acts on this tick, in words for the why of its decisions. Pure. */
export function recipeWords(placements: readonly PlacementWrite[], strategies: readonly StrategyWrite[]): Map<string, string> {
  const parts = new Map<string, string[]>()
  const add = (id: string, words: string) => parts.set(id, [...(parts.get(id) ?? []), words])
  for (const w of placements) if (w.recipeWhy) add(w.campaignId, w.recipeWhy)
  for (const s of strategies) add(s.campaignId, s.step.why)
  return new Map([...parts].map(([id, list]) => [id, list.join('; ')]))
}

/** The layers whose write floors a keyword: the bid before is remembered for a give-back. */
const FLOORING_LAYERS: ReadonlySet<string> = new Set(['min_bid_hour', 'stop', 'stock', 'phase'])

/**
 * BB-7 review — the floors' memory, kept where the old engines' give-back reads it, so handing a campaign back (op shadow,
 * give-back, or the server switch off / shadow) never strands its bids at 2–3¢:
 *   floored    each keyword the brain floored this run remembers its bid before (`AdTarget.suppressedFromBidCents`,
 *              the no-pause memory `restoreCampaignBids` puts back; an older memory is kept); a Min-bid floor also marks
 *              the campaign as floored by its plan's schedule (`bidsSuppressedAt` / `…FloorCents` / `…By =
 *              automation:rank-defend-<schedule>`), so rank-defend's serving hour, once it runs the campaign again,
 *              gives every bid back (firstWriteIntent `restore`). A stop's floor keeps its owner's mark (BB-8): its owner's
 *              lift gives the bids back from this memory after a hand-back, and clears it while the brain still runs.
 *   given back each keyword the brain gave back forgets it; when every keyword the plan floored was given back this run
 *              (none still at a Min-bid floor, no give-back left waiting), the plan's floor mark goes too. A keyword's
 *              own older stop keeps its memory and its owner.
 * While the brain runs the campaign, facts.ts reads the plan's own mark and memory as its record (the plan's hour
 * decides). Never fails the run.
 */
async function rememberFloors(rows: { campaigns: ReadonlyMap<string, CampaignRow> }, decisions: readonly Decision[], sent: WriteReport, hours: ReadonlyMap<string, PlanHour> | undefined, campaignOf: (targetId: string) => string, now: Date): Promise<void> {
  try {
    const flooredCampaigns = new Map<string, number>()
    const gaveBack = new Set<string>()
    for (const d of decisions) {
      if (sent.byTarget.get(d.targetId)?.sent !== 'queued') continue
      if (FLOORING_LAYERS.has(d.layer) && d.bidCents < d.currentCents) {
        await prisma.adTarget.updateMany({ where: { id: d.targetId, suppressedFromBidCents: null }, data: { suppressedFromBidCents: d.currentCents } })
        if (d.layer === 'min_bid_hour') flooredCampaigns.set(campaignOf(d.targetId), d.bidCents)
      } else if (d.layer === 'restore') {
        await prisma.adTarget.updateMany({ where: { id: d.targetId, suppressedFromBidCents: { not: null } }, data: { suppressedFromBidCents: null } })
        gaveBack.add(campaignOf(d.targetId))
      }
    }
    for (const [campaignId, floorCents] of flooredCampaigns) {
      const hour = hours?.get(campaignId)
      if (!hour) continue
      await prisma.campaign.updateMany({ where: { id: campaignId, bidsSuppressedAt: null }, data: { bidsSuppressedAt: now, bidsSuppressedFloorCents: floorCents, bidsSuppressedBy: `automation:rank-defend-${hour.scheduleId}` } })
    }
    for (const campaignId of gaveBack) {
      const c = rows.campaigns.get(campaignId)
      if (!c?.bidsSuppressedAt || !isPlanFloorMark(c.bidsSuppressedBy) || flooredCampaigns.has(campaignId)) continue
      const mine = decisions.filter((d) => campaignOf(d.targetId) === campaignId)
      const waiting = mine.some((d) => d.layer === 'min_bid_hour' || (d.layer === 'restore' && d.bidCents !== d.currentCents && sent.byTarget.get(d.targetId)?.sent !== 'queued'))
      if (!waiting) await prisma.campaign.updateMany({ where: { id: campaignId, bidsSuppressedBy: c.bidsSuppressedBy }, data: { bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null } })
    }
  } catch (err) {
    logger.warn('[bid-brain] could not keep the floors\' memory', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** BB-7 — record a Min-bid entry for each owned campaign that entered a Min-bid hour this run (its floors were queued). */
async function recordMinBidEntries(rows: { adGroups: ReadonlyMap<string, { campaignId: string }>; targets: ReadonlyArray<{ id: string; adGroupId: string }> }, decisions: readonly Decision[], sent: WriteReport, run: { lowered?: ReadonlyMap<string, { layer: string }>; minBidEntries?: ReadonlyMap<string, number> }, campaignOf: (targetId: string) => string): Promise<void> {
  const entered = new Map<string, number>()
  for (const d of decisions) {
    if (d.layer !== 'min_bid_hour' || sent.byTarget.get(d.targetId)?.sent !== 'queued') continue
    entered.set(campaignOf(d.targetId), d.bidCents)
  }
  if (!entered.size) return
  const already = new Set(rows.targets.filter((t) => run.lowered?.get(t.id)?.layer === 'min_bid_hour').map((t) => rows.adGroups.get(t.adGroupId)?.campaignId))
  const { recordMinBidEntry } = await import('../../../jobs/ad-rank-defend.job.js')
  for (const [campaignId, floorCents] of entered) {
    if (already.has(campaignId)) continue
    await recordMinBidEntry(campaignId, BRAIN_ACTOR, floorCents, (run.minBidEntries?.get(campaignId) ?? 0) + 1)
  }
}

/**
 * BB-6 — the markets a run decides: IT and DE, and every market of a campaign the brain owns. BB-7 — `onlyOwned`: the
 * markets of the campaigns it owns only (a between-slots tick).
 */
export async function brainMarkets(opts: { onlyOwned?: boolean } = {}): Promise<string[]> {
  const owned = await brainOwnedCampaignIds()
  if (!owned.size) return opts.onlyOwned ? [] : [...SHADOW_MARKETS]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: [...owned] } }, select: { marketplace: true } })
  const extra = campaigns.map((c) => strategyMarket(c.marketplace)).filter((m): m is string => !!m)
  return [...new Set<string>([...(opts.onlyOwned ? [] : SHADOW_MARKETS), ...extra])]
}

/**
 * One run over the brain's markets, then the 30-day prune. BB-7 — `onlyOwned`: a between-slots tick (every 15 minutes,
 * ads-bid-brain.job.ts) that decides only the campaigns the brain owns, so their hourly plan's hours are carried out on
 * time; it prunes nothing. `clockNow`: the database clock a plan's hour is read on.
 */
export async function runShadowOnce(opts: { now?: Date; mode?: BrainMode; onlyOwned?: boolean; clockNow?: Date; /** AB-14 */ scope?: BrainRunScope; /** AB-14 — per campaign: why its raises wait (a product cycle's earlier steps). */ raiseCaps?: ReadonlyMap<string, string> } = {}): Promise<ShadowRun> {
  const now = opts.now ?? new Date()
  const mode = opts.mode ?? bidBrainMode()
  const runId = `bb-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const out: ShadowRun = { runId, mode, markets: [], pruned: 0 }
  if (mode === 'off') return out
  // BB-6 — the dial and the brain's own caps, read once per run and only when an owned campaign has a write to ask.
  let guard: EngineGuard | null = null
  const openGuard = async (): Promise<EngineGuard> => (guard ??= await openEngineGuard('bid-brain', { now }))
  const onlyOwned = opts.onlyOwned === true
  if (onlyOwned && mode !== 'live') return out
  // AB-14 — a product cycle's run reads its own market only, and only when the brain decides there today.
  const markets = (mode === 'live' ? await brainMarkets({ onlyOwned }) : [...SHADOW_MARKETS]).filter((m) => !opts.scope?.market || m === opts.scope.market)
  const scoped = opts.scope?.campaignIds || opts.scope?.skipCampaignIds ? { scope: opts.scope } : {}
  const capped = opts.raiseCaps?.size ? { raiseCaps: opts.raiseCaps } : {}
  for (const market of markets) {
    try {
      out.markets.push(await shadowMarket(market, { runId, mode, now, clockNow: opts.clockNow, onlyOwned, guard: openGuard, ...scoped, ...capped }))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('[bid-brain] market run failed', { market, error })
      out.markets.push({ market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [`failed: ${error}`], error })
    }
  }
  // The 30-day prune belongs to the full run (a product cycle's run of a few campaigns leaves it).
  if (!onlyOwned && !opts.scope?.campaignIds) {
    const pruned = await prisma.bidBrainDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_DAYS_KEPT * 86_400_000) } } })
    out.pruned = pruned.count
  }
  const report = (guard as EngineGuard | null)?.report()
  if (report) out.guard = report
  // BB-10 — what the run wrote, for auto-undo and every other reader (packages/events/catalog.ts, hard rule 8).
  const writes = out.markets.flatMap((m) => m.brainWrites ?? [])
  if (writes.length) {
    try {
      // BB-10 review — `from` / `to` as the bid write recorded them (its action-log row): the bid actually written, after the
      // mutation layer's own clamps, not the decision.
      const logIds = writes.map((w) => w.actionLogId).filter((id): id is string => !!id)
      const logged = new Map((logIds.length ? await prisma.advertisingActionLog.findMany({ where: { id: { in: logIds } }, select: { id: true, payloadBefore: true, payloadAfter: true } }) : [])
        .map((l) => [l.id, { from: bidOf(l.payloadBefore), to: bidOf(l.payloadAfter) }]))
      for (const w of writes) {
        const l = w.actionLogId ? logged.get(w.actionLogId) : undefined
        if (l) { w.from = l.from ?? w.from; w.to = l.to ?? w.to }
      }
      await publishEvent(prisma, 'ads.bid-brain.run-completed', {
        runId, mode, campaignIds: [...new Set(writes.map((w) => w.campaignId))].sort(),
        writes: writes.map(({ actionLogId, entityId, field, from, to }) => ({ actionLogId, entityId, field, from, to })),
      })
    } catch (err) {
      logger.warn('[bid-brain] could not publish the run-completed event', { runId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

const BRAIN_GUARD_WORDS = { suggest: 'nothing is written; it says what it would have written', stopped: 'nothing is written' }

/** The run's summary line: "mode=shadow IT decided=120 stored=14 write=30 hold=88 brake=2 · DE …". */
export function shadowSummaryLine(r: ShadowRun): string {
  if (r.mode === 'off') return 'mode=off (NEXUS_BID_BRAIN_MODE) — nothing decided'
  const parts = r.markets.map((m) => {
    const actions = Object.entries(m.byAction).map(([k, v]) => `${k}=${v}`).join(' ')
    const words = [writeReportWords(m.writes), placementReportWords(m.placements), strategyReportWords(m.strategies)].filter(Boolean).join(' ')
    const live = m.owned ? ` owned=${m.owned}${words ? ` ${words}` : ''}` : ''
    const nowcast = m.nowcast ? ` · ${nowcastSummaryWords(m.nowcast)}` : m.nowcastOn ? ` · nowcast on to ${m.nowcastOn.dataDay} (${m.nowcastOn.curve}), young days ${m.nowcastOn.youngPct}%` : ''
    const upgrades = [m.upgrades?.response ? responseSummaryWords(m.upgrades.response) : '', m.upgrades?.explore ? exploreSummaryWords(m.upgrades.explore) : '', probeSummaryWords(m.upgrades?.probes)].filter(Boolean).map((w) => ` · ${w}`).join('')
    const intraday = m.intraday ? ` · ${intradaySummaryWords(m.intraday)}` : ''
    return `${m.market} decided=${m.decided} stored=${m.stored}${actions ? ` ${actions}` : ''}${live}${m.brakes.length ? ` brakes: ${m.brakes.join('; ')}` : ''}${nowcast}${upgrades}${intraday}`
  })
  const owned = r.markets.reduce((n, m) => n + (m.owned ?? 0), 0)
  const mode = r.mode === 'live' && !owned ? 'live (no campaign enrolled LIVE: shadow)' : r.mode
  return `mode=${mode} ${parts.join(' · ')} pruned=${r.pruned}${engineGuardNote(r.guard, BRAIN_GUARD_WORDS)}`
}
