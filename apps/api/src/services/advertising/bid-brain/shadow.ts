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
import { engineGuardNote, openEngineGuard, type EngineGuard, type EngineGuardReport } from '../ads-engine-guard.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { decide, type Decision } from './decide.js'
import { buildFacts } from './facts.js'
import { brainOwnedCampaignIds } from './live.js'
import { writeOwnedDecisions, writeReportWords, type WriteReport } from './live-writer.js'
import { loadMarket, loadRun, SHADOW_MARKETS, type LastWrite, type PreviousDecision } from './load.js'

export type BrainMode = 'off' | 'shadow' | 'live'
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
  markets: Array<{ market: string; decided: number; stored: number; byAction: Record<string, number>; byLayer: Record<string, number>; brakes: string[]; owned?: number; writes?: WriteReport | null }>
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

/** Decide and store one market; BB-6 — and send the write decisions of the campaigns the brain owns. */
export async function shadowMarket(market: string, ctx: { runId: string; mode: BrainMode; now: Date; guard?: () => Promise<EngineGuard> }): Promise<ShadowRun['markets'][number]> {
  const rows = await loadMarket(market, { now: ctx.now })
  if (!rows.targets.length) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const { run, lastWrites, previous } = await loadRun(rows, ctx.now)
  const facts = buildFacts(rows, run)
  const decisions = facts.map((f) => decide(f))
  const groupOf = new Map(rows.targets.map((t) => [t.id, t.adGroupId]))
  const campaignOf = (targetId: string): string => {
    const adGroupId = groupOf.get(targetId)
    return adGroupId ? rows.adGroups.get(adGroupId)?.campaignId ?? '' : ''
  }
  // BB-6 — the campaigns the brain owns write their decisions; every other campaign stays shadow, whatever the env says.
  const allowlisted = [...rows.campaigns.values()].filter((c) => c.allowlisted).map((c) => c.id)
  const owned = ctx.mode === 'live' && allowlisted.length ? await brainOwnedCampaignIds(allowlisted) : new Set<string>()
  const toWrite = owned.size
    ? decisions.filter((d) => d.action === 'write' && owned.has(campaignOf(d.targetId))).map((decision) => ({ campaignId: campaignOf(decision.targetId), market, decision }))
    : []
  const sent = toWrite.length && ctx.guard ? await writeOwnedDecisions(toWrite, { runId: ctx.runId, guard: await ctx.guard() }) : null
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
    ...(owned.size ? { owned: owned.size, writes: sent } : {}),
  }
}

/** BB-6 — the markets a run decides: IT and DE, and every market of a campaign the brain owns. */
export async function brainMarkets(): Promise<string[]> {
  const owned = await brainOwnedCampaignIds()
  if (!owned.size) return [...SHADOW_MARKETS]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: [...owned] } }, select: { marketplace: true } })
  const extra = campaigns.map((c) => strategyMarket(c.marketplace)).filter((m): m is string => !!m)
  return [...new Set<string>([...SHADOW_MARKETS, ...extra])]
}

/** One run over the brain's markets, then the 30-day prune. */
export async function runShadowOnce(opts: { now?: Date; mode?: BrainMode } = {}): Promise<ShadowRun> {
  const now = opts.now ?? new Date()
  const mode = opts.mode ?? bidBrainMode()
  const runId = `bb-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const out: ShadowRun = { runId, mode, markets: [], pruned: 0 }
  if (mode === 'off') return out
  // BB-6 — the dial and the brain's own caps, read once per run and only when an owned campaign has a write to ask.
  let guard: EngineGuard | null = null
  const openGuard = async (): Promise<EngineGuard> => (guard ??= await openEngineGuard('bid-brain', { now }))
  const markets = mode === 'live' ? await brainMarkets() : [...SHADOW_MARKETS]
  for (const market of markets) {
    try {
      out.markets.push(await shadowMarket(market, { runId, mode, now, guard: openGuard }))
    } catch (err) {
      logger.error('[bid-brain] market run failed', { market, error: err instanceof Error ? err.message : String(err) })
      out.markets.push({ market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [`failed: ${err instanceof Error ? err.message : String(err)}`] })
    }
  }
  const pruned = await prisma.bidBrainDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_DAYS_KEPT * 86_400_000) } } })
  out.pruned = pruned.count
  const report = (guard as EngineGuard | null)?.report()
  if (report) out.guard = report
  return out
}

const BRAIN_GUARD_WORDS = { suggest: 'nothing is written; it says what it would have written', stopped: 'nothing is written' }

/** The run's summary line: "mode=shadow IT decided=120 stored=14 write=30 hold=88 brake=2 · DE …". */
export function shadowSummaryLine(r: ShadowRun): string {
  if (r.mode === 'off') return 'mode=off (NEXUS_BID_BRAIN_MODE) — nothing decided'
  const parts = r.markets.map((m) => {
    const actions = Object.entries(m.byAction).map(([k, v]) => `${k}=${v}`).join(' ')
    const live = m.owned ? ` owned=${m.owned}${writeReportWords(m.writes) ? ` ${writeReportWords(m.writes)}` : ''}` : ''
    return `${m.market} decided=${m.decided} stored=${m.stored}${actions ? ` ${actions}` : ''}${live}${m.brakes.length ? ` brakes: ${m.brakes.join('; ')}` : ''}`
  })
  const owned = r.markets.reduce((n, m) => n + (m.owned ?? 0), 0)
  const mode = r.mode === 'live' && !owned ? 'live (no campaign enrolled LIVE: shadow)' : r.mode
  return `mode=${mode} ${parts.join(' · ')} pruned=${r.pruned}${engineGuardNote(r.guard, BRAIN_GUARD_WORDS)}`
}
