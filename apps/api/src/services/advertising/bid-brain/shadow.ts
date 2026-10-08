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
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { publishEvent } from '../../../lib/events/publish.js'
import { engineGuardNote, openEngineGuard, type EngineGuard, type EngineGuardReport } from '../ads-engine-guard.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { buildFacts, type CampaignRow } from './facts.js'
import { BRAIN_ACTOR, brainOwnedCampaignIds } from './live.js'
import { placementReportWords, writeOwnedDecisions, writeOwnedPlacements, writeReportWords, type PlacementReport, type PlacementWrite, type WriteReport } from './live-writer.js'
import type { PlanHour } from './plan-hour.js'
import { stampPlanReceipts } from './plans.js'
import { loadMarket, loadRun, SHADOW_MARKETS, type LastWrite, type PreviousDecision } from './load.js'

export type BrainMode = 'off' | 'shadow' | 'live'

/** BB-10 — one write the brain sent to a campaign it owns, as the run-completed event carries it (auto-undo's interface). */
export interface BrainWriteRecord { campaignId: string; actionLogId: string | null; entityId: string; field: 'bid' | 'placementBidding'; from: number | null; to: number | null }
/** Decisions are kept this many days. */
export const DECISION_DAYS_KEPT = 30

/** The env ceiling. Anything unrecognised is shadow (never live by accident). */
export function bidBrainMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_MODE): BrainMode {
  const v = (env ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' ? 'off' : v === 'live' ? 'live' : 'shadow'
}

export interface ShadowRun {
  runId: string
  mode: BrainMode
  /** BB-6 — `owned`: the market's campaigns the brain owns this run; `writes`: what became of their write decisions. */
  markets: Array<{ market: string; decided: number; stored: number; byAction: Record<string, number>; byLayer: Record<string, number>; brakes: string[]; owned?: number; writes?: WriteReport | null; placements?: PlacementReport; brainWrites?: BrainWriteRecord[] }>
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

/** The step the next run anchors on: this decision's own, else the last one of the same data day. */
function carriedStep(d: Decision, prev: PreviousDecision | undefined) {
  if (d.step) return d.step
  return prev?.lastStep && prev.lastStep.dataDay === d.dataDay ? prev.lastStep : null
}

const dec = (x: number | null | undefined, places = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places)

/**
 * Decide and store one market; BB-6 — and send the write decisions of the campaigns the brain owns. BB-7 — their hourly
 * plan's hour too: its placement % (one write per campaign), its Min-bid floors (an entry recorded for the anti-flap),
 * and the plan's receipt. `onlyOwned`: a between-slots tick decides only the campaigns the brain owns.
 */
export async function shadowMarket(market: string, ctx: { runId: string; mode: BrainMode; now: Date; clockNow?: Date; onlyOwned?: boolean; guard?: () => Promise<EngineGuard> }): Promise<ShadowRun['markets'][number]> {
  const rows = await loadMarket(market, { now: ctx.now })
  if (!rows.targets.length) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  // BB-6 — the campaigns the brain owns write their decisions; every other campaign stays shadow, whatever the env says.
  const allowlisted = [...rows.campaigns.values()].filter((c) => c.allowlisted).map((c) => c.id)
  const owned = ctx.mode === 'live' && allowlisted.length ? await brainOwnedCampaignIds(allowlisted) : new Set<string>()
  if (ctx.onlyOwned && !owned.size) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const { run, lastWrites, previous } = await loadRun(rows, ctx.now, { owned, clockNow: ctx.clockNow })
  const groupOf = new Map(rows.targets.map((t) => [t.id, t.adGroupId]))
  const campaignOf = (targetId: string): string => {
    const adGroupId = groupOf.get(targetId)
    return adGroupId ? rows.adGroups.get(adGroupId)?.campaignId ?? '' : ''
  }
  const facts = buildFacts(rows, run).filter((f) => !ctx.onlyOwned || owned.has(campaignOf(f.targetId)))
  const decisions = facts.map((f) => decide(f))
  const toWrite = owned.size
    ? decisions.filter((d) => d.action === 'write' && owned.has(campaignOf(d.targetId))).map((decision) => ({ campaignId: campaignOf(decision.targetId), market, decision }))
    : []
  const guard = owned.size && ctx.guard ? await ctx.guard() : null
  const sent = toWrite.length && guard ? await writeOwnedDecisions(toWrite, { runId: ctx.runId, guard }) : null
  // BB-7 — the plan's hour of each owned campaign: its placements (none while braked, paused or in a Min-bid hour) …
  const placed = guard && !run.marketBrakes.length ? await writeOwnedPlacements(placementWrites(rows, facts, decisions, owned, campaignOf, run.planHours), { runId: ctx.runId, guard }) : null
  // … a new Min-bid entry for each campaign the brain floored this run (rank-defend's anti-flap, its count shared) …
  if (sent) await recordMinBidEntries(rows, decisions, sent, run, campaignOf)
  // … and the plan's receipt (what it holds now), as rank-defend stamps its own.
  if (run.planHours?.size) await stampPlanReceipts(run.planHours, ctx.clockNow ?? ctx.now)
  const data = decisions.flatMap((d) => {
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
      dataDay: new Date(`${d.dataDay}T00:00:00Z`), lastWriter: last?.actor ?? null, lastWriteAt: last?.at ?? null, why: d.why,
      evidence: { step: d.step, lastStep: carriedStep(d, prev), clash: d.clash, placements: d.placements.length ? d.placements : undefined, sent: outcome } as unknown as Prisma.InputJsonObject,
      createdAt: ctx.now,
    }]
  })
  if (data.length) await prisma.bidBrainDecision.createMany({ data })
  return {
    market, decided: decisions.length, stored: data.length, byAction: count(decisions, 'action'), byLayer: count(decisions, 'layer'), brakes: run.marketBrakes as string[],
    ...(owned.size ? { owned: owned.size, writes: sent, ...(placed && (placed.written || placed.refused || placed.deferred) ? { placements: placed } : {}) } : {}),
    ...(owned.size ? { brainWrites: brainWriteRecords(decisions, sent, placed, campaignOf) } : {}),
  }
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

/** BB-7 — each owned campaign whose hourly plan sets placements this hour, with its highest base bid after this run. */
export function placementWrites(rows: { market: string; campaigns: ReadonlyMap<string, CampaignRow> }, facts: readonly TargetFacts[], decisions: readonly Decision[], owned: ReadonlySet<string>, campaignOf: (targetId: string) => string, hours: ReadonlyMap<string, PlanHour> | undefined): PlacementWrite[] {
  const out: PlacementWrite[] = []
  const byCampaign = new Map<string, { f: TargetFacts; maxBid: number; floored: boolean; braked: boolean }>()
  facts.forEach((f, i) => {
    const campaignId = campaignOf(f.targetId)
    if (!owned.has(campaignId)) return
    const d = decisions[i]
    const bid = d.action === 'write' ? d.bidCents : d.currentCents
    const e = byCampaign.get(campaignId)
    const floored = d.layer === 'min_bid_hour' || !!f.overrides?.minBidHour
    // A paused ad group brakes its own keywords only: the campaign's placements wait only when every keyword is braked.
    const braked = !!f.brakes?.length
    if (!e) byCampaign.set(campaignId, { f, maxBid: bid, floored, braked })
    else { e.maxBid = Math.max(e.maxBid, bid); e.floored ||= floored; e.braked &&= braked }
  })
  for (const [campaignId, e] of byCampaign) {
    const hour = hours?.get(campaignId)
    const c = rows.campaigns.get(campaignId)
    if (!hour?.key || !e.f.lanes?.length || e.floored || e.braked || !c || c.status !== 'ENABLED') continue
    out.push({ campaignId, market: rows.market, lanes: e.f.lanes, current: c.placements ?? [], maxBidCents: e.maxBid, key: hour.key, note: e.f.planNote ?? `hourly plan ${hour.name}`, dataDay: e.f.dataDay, raiseCap: e.f.raiseCap ?? null })
  }
  return out
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
export async function runShadowOnce(opts: { now?: Date; mode?: BrainMode; onlyOwned?: boolean; clockNow?: Date } = {}): Promise<ShadowRun> {
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
  const markets = mode === 'live' ? await brainMarkets({ onlyOwned }) : [...SHADOW_MARKETS]
  for (const market of markets) {
    try {
      out.markets.push(await shadowMarket(market, { runId, mode, now, clockNow: opts.clockNow, onlyOwned, guard: openGuard }))
    } catch (err) {
      logger.error('[bid-brain] market run failed', { market, error: err instanceof Error ? err.message : String(err) })
      out.markets.push({ market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [`failed: ${err instanceof Error ? err.message : String(err)}`] })
    }
  }
  if (!onlyOwned) {
    const pruned = await prisma.bidBrainDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_DAYS_KEPT * 86_400_000) } } })
    out.pruned = pruned.count
  }
  const report = (guard as EngineGuard | null)?.report()
  if (report) out.guard = report
  // BB-10 — what the run wrote, for auto-undo and every other reader (packages/events/catalog.ts, hard rule 8).
  const writes = out.markets.flatMap((m) => m.brainWrites ?? [])
  if (writes.length) {
    await publishEvent(prisma, 'ads.bid-brain.run-completed', {
      runId, mode, campaignIds: [...new Set(writes.map((w) => w.campaignId))].sort(),
      writes: writes.map(({ actionLogId, entityId, field, from, to }) => ({ actionLogId, entityId, field, from, to })),
    }).catch((err) => logger.warn('[bid-brain] could not publish the run-completed event', { runId, error: err instanceof Error ? err.message : String(err) }))
  }
  return out
}

const BRAIN_GUARD_WORDS = { suggest: 'nothing is written; it says what it would have written', stopped: 'nothing is written' }

/** The run's summary line: "mode=shadow IT decided=120 stored=14 write=30 hold=88 brake=2 · DE …". */
export function shadowSummaryLine(r: ShadowRun): string {
  if (r.mode === 'off') return 'mode=off (NEXUS_BID_BRAIN_MODE) — nothing decided'
  const parts = r.markets.map((m) => {
    const actions = Object.entries(m.byAction).map(([k, v]) => `${k}=${v}`).join(' ')
    const words = [writeReportWords(m.writes), placementReportWords(m.placements)].filter(Boolean).join(' ')
    const live = m.owned ? ` owned=${m.owned}${words ? ` ${words}` : ''}` : ''
    return `${m.market} decided=${m.decided} stored=${m.stored}${actions ? ` ${actions}` : ''}${live}${m.brakes.length ? ` brakes: ${m.brakes.join('; ')}` : ''}`
  })
  const owned = r.markets.reduce((n, m) => n + (m.owned ?? 0), 0)
  const mode = r.mode === 'live' && !owned ? 'live (no campaign enrolled LIVE: shadow)' : r.mode
  return `mode=${mode} ${parts.join(' · ')} pruned=${r.pruned}${engineGuardNote(r.guard, BRAIN_GUARD_WORDS)}`
}
