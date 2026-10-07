/**
 * BID BRAIN BB-3 — one shadow run: for every keyword of the allowlisted Sponsored Products campaigns in IT and DE,
 * decide the bid (decide.ts) and store the decision next to what today's writers set. 🔴 It never calls a write path:
 * no mutation, no queue, no gate, no Amazon. The only rows it writes are its own (BidBrainDecision).
 *
 *   stored    a decision that differs from the keyword's last one (action, layer, today's bid or the decided bid),
 *             plus the day's first decision of each keyword as a snapshot — so a run on unchanged facts writes nothing
 *   kept      30 days (older rows are deleted at the end of each run: Neon cost)
 *   mode      NEXUS_BID_BRAIN_MODE: off (no run) · shadow (default) · live (= shadow until BB-6 ships the writer)
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { decide, type Decision } from './decide.js'
import { buildFacts } from './facts.js'
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
  markets: Array<{ market: string; decided: number; stored: number; byAction: Record<string, number>; byLayer: Record<string, number>; brakes: string[] }>
  pruned: number
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

/** Decide and store one market. */
export async function shadowMarket(market: string, ctx: { runId: string; mode: BrainMode; now: Date }): Promise<ShadowRun['markets'][number]> {
  const rows = await loadMarket(market, { now: ctx.now })
  if (!rows.targets.length) return { market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [] }
  const { run, lastWrites, previous } = await loadRun(rows, ctx.now)
  const facts = buildFacts(rows, run)
  const decisions = facts.map((f) => decide(f))
  const groupOf = new Map(rows.targets.map((t) => [t.id, t.adGroupId]))
  const data = decisions.flatMap((d) => {
    const prev = previous.get(d.targetId)
    const kind = rowKind(d, prev, ctx.now)
    if (!kind) return []
    const adGroupId = groupOf.get(d.targetId) ?? null
    const campaignId = adGroupId ? rows.adGroups.get(adGroupId)?.campaignId ?? '' : ''
    const last: LastWrite | undefined = lastWrites.get(d.targetId)
    return [{
      runId: ctx.runId, // No live writer in this build: every decision is a shadow one, whatever the env says.
      mode: 'SHADOW', kind, marketplace: market, campaignId, adGroupId, targetId: d.targetId,
      action: d.action, layer: d.layer, currentCents: d.currentCents, decidedCents: d.bidCents, goalBidCents: d.goalBidCents,
      aim: dec(d.goal?.aim), bandLo: dec(d.goal?.lo), bandHi: dec(d.goal?.hi), expectedAcos: dec(d.expectedAcos), confidence: dec(d.confidence),
      dataDay: new Date(`${d.dataDay}T00:00:00Z`), lastWriter: last?.actor ?? null, lastWriteAt: last?.at ?? null, why: d.why,
      evidence: { step: d.step, lastStep: carriedStep(d, prev), clash: d.clash, placements: d.placements.length ? d.placements : undefined } as unknown as Prisma.InputJsonObject,
      createdAt: ctx.now,
    }]
  })
  if (data.length) await prisma.bidBrainDecision.createMany({ data })
  return { market, decided: decisions.length, stored: data.length, byAction: count(decisions, 'action'), byLayer: count(decisions, 'layer'), brakes: run.marketBrakes as string[] }
}

/** One shadow run over the shadow markets, then the 30-day prune. */
export async function runShadowOnce(opts: { now?: Date; mode?: BrainMode } = {}): Promise<ShadowRun> {
  const now = opts.now ?? new Date()
  const mode = opts.mode ?? bidBrainMode()
  const runId = `bb-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const out: ShadowRun = { runId, mode, markets: [], pruned: 0 }
  if (mode === 'off') return out
  for (const market of SHADOW_MARKETS) {
    try {
      out.markets.push(await shadowMarket(market, { runId, mode, now }))
    } catch (err) {
      logger.error('[bid-brain] shadow market failed', { market, error: err instanceof Error ? err.message : String(err) })
      out.markets.push({ market, decided: 0, stored: 0, byAction: {}, byLayer: {}, brakes: [`failed: ${err instanceof Error ? err.message : String(err)}`] })
    }
  }
  const pruned = await prisma.bidBrainDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DECISION_DAYS_KEPT * 86_400_000) } } })
  out.pruned = pruned.count
  return out
}

/** The run's summary line: "mode=shadow IT decided=120 stored=14 write=30 hold=88 brake=2 · DE …". */
export function shadowSummaryLine(r: ShadowRun): string {
  if (r.mode === 'off') return 'mode=off (NEXUS_BID_BRAIN_MODE) — nothing decided'
  const parts = r.markets.map((m) => {
    const actions = Object.entries(m.byAction).map(([k, v]) => `${k}=${v}`).join(' ')
    return `${m.market} decided=${m.decided} stored=${m.stored}${actions ? ` ${actions}` : ''}${m.brakes.length ? ` brakes: ${m.brakes.join('; ')}` : ''}`
  })
  return `mode=${r.mode}${r.mode === 'live' ? ' (no live writer yet: shadow)' : ''} ${parts.join(' · ')} pruned=${r.pruned}`
}
