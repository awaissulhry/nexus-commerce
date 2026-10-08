/**
 * ONE BRAIN AB-12 — one run of the state brain (brain/state.ts decides, brain/state-load.ts reads): for every product
 * whose state lever is OBSERVE or higher, each of its campaigns' state decided and acted on at its level, and logged
 * (AdsBrainStateDecision).
 *
 *   OBSERVE   logged only (SHADOW): what the brain would pause, resume or propose to archive
 *   PROPOSE   an approval request per product and action, through the normal approval gate (the auto-undo pattern,
 *             ads-auto-undo.service.ts proposeUndo): pause-ads, enable-ads (with includePeoplesPauses when it lifts the
 *             brain's own AUTO pause — Nexus's own request: a person's normal approval lifts it, batch 2 fix) or
 *             archive-ads, asked as "Nexus ads brain"; a request still waiting is never asked twice; a person approves or
 *             declines it in Nexus
 *   AUTO      the status written as the brain (BRAIN_STATE_ACTOR) through the normal campaign path —
 *             updateCampaignWithSync asks the write gate before anything is written (askGate), then the queue, the gate
 *             again at dispatch, the channel gateway (hard rule 4). The gate lets it through only where a product's brain
 *             owns the campaign's state lever; a lock, an exclusion, a lever at OBSERVE or a shadow ceiling refuse it. An
 *             archive is a request at AUTO too: never alone
 *   caps      ≤ 3 pauses a UTC day per market (state.ts MAX_PAUSES_PER_MARKET_DAY), counted from the log: the ones that act
 *             (asked or queued) and the shadow's apart
 *   log       a row when a campaign's decision changes (decisionHash), plus the UTC day's first for a campaign the brain
 *             paused or has a request waiting for — the memory of its own pause rides on the newest row; rows older than
 *             30 days are deleted at every run, also when nothing is watched (Neon cost)
 *   no-op     no enrolled product with the state lever at OBSERVE or higher (production today): one read and the prune
 * Each product is decided on its own; one that fails is named in the run and the others still run.
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { readEnginePosture } from '../ads-engine-guard.js'
import { BRAIN_STATE_ACTOR } from '../ads-write-gate.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { loadProductStateFacts, stateWatchProducts, type AskedRecord, type StateWatched } from './state-load.js'
import { campaignHoldWhy, leverHolds } from './lever-holds.js'
import {
  DECLINE_DAYS, decideState, MAX_PAUSES_PER_MARKET_DAY, STATE_DECISION_DAYS_KEPT, stateDecisionHash, stateRowKind, type StateContext, type StateDecision,
} from './state.js'

const DAY_MS = 86_400_000
/** What the brain's requests are asked as, in Nexus's approval queue. */
export const STATE_REQUESTER = 'Nexus ads brain'
const TOOL_OF = { pause: 'pause-ads', resume: 'enable-ads', archive: 'archive-ads' } as const

/** The final outcome a row records. */
export type StateOutcome = 'shadow' | 'queued' | 'asked' | 'waiting' | 'capped' | 'refused' | 'held' | 'none'

/** Ask a person for one change of several campaigns (PROPOSE, or an archive): its approval, or why it was not asked. */
export type AskFn = (tool: 'pause-ads' | 'enable-ads' | 'archive-ads', args: Record<string, unknown>) => Promise<{ approvalId: string } | { error: string }>
/** Write one campaign's status as the brain (AUTO): queued, or why not. */
export type WriteFn = (campaignId: string, status: 'PAUSED' | 'ENABLED', reason: string, runId: string) => Promise<{ queued: boolean; error: string | null }>

export interface StateRunCampaign { campaignId: string; productId: string; market: string; action: string; outcome: StateOutcome; stored: 'change' | 'snapshot' | null; why: string; approvalId?: string | null }

export interface StateRun {
  runId: string
  ran: boolean
  why: string
  campaigns: StateRunCampaign[]
  failed: Array<{ productId: string; market: string; error: string }>
  pruned: number
}

/** The request of a decision: the pause-ads / enable-ads / archive-ads args (a resume of the brain's own AUTO pause also lifts an automation's pause). */
export function requestArgs(action: 'pause' | 'resume' | 'archive', decisions: readonly StateDecision[]): { tool: 'pause-ads' | 'enable-ads' | 'archive-ads'; args: Record<string, unknown> } {
  const lift = action === 'resume' && decisions.some((d) => d.liftsAutomationPause)
  const why = decisions.length === 1 ? decisions[0].why : `${decisions.length} campaigns of one product: ${decisions.map((d) => `${d.name} — ${d.why}`).join(' | ')}`
  return { tool: TOOL_OF[action], args: { campaignIds: decisions.map((d) => d.campaignId), why: `The ads brain: ${why}`.slice(0, 300), ...(lift ? { includePeoplesPauses: true } : {}) } }
}

/** The default ask: through the normal approval gate as "Nexus ads brain", always a request (forceAsk). */
export const askThroughApprovals: AskFn = async (tool, args) => {
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-brain-state', trigger: 'schedule', status: 'running', input: { tool, args } as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(tool, args, systemPrincipal(STATE_REQUESTER), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** The default write: the campaign status path as the brain, asking the gate before anything is written. */
export const writeAsTheBrain: WriteFn = async (campaignId, status, reason, runId) => {
  const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
  const out = await updateCampaignWithSync({ campaignId, patch: { status }, actor: BRAIN_STATE_ACTOR, reason: `The ads brain: ${reason}`.slice(0, 500), askGate: true, changeSetId: runId })
  if (out.ok && out.error !== 'no_changes') return { queued: true, error: null }
  return { queued: false, error: out.ok ? 'already at that status' : out.error ?? 'refused' }
}

/** Delete the logged decisions older than STATE_DECISION_DAYS_KEPT days; how many went. */
export async function pruneStateDecisions(now: Date): Promise<number> {
  return (await prisma.adsBrainStateDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - STATE_DECISION_DAYS_KEPT * DAY_MS) } } })).count
}

/** Campaigns paused this UTC day in one market, from the log (each campaign once): the ones that act (asked or queued) and the shadow's. */
export async function pausesToday(market: string, now: Date): Promise<{ acting: number; shadow: number }> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const rows = await prisma.adsBrainStateDecision.groupBy({
    by: ['outcome', 'campaignId'],
    where: { marketplace: market, action: 'pause', kind: 'change', outcome: { in: ['queued', 'asked', 'shadow'] }, createdAt: { gte: since } },
  })
  const acting = new Set(rows.filter((r) => r.outcome !== 'shadow').map((r) => r.campaignId))
  return { acting: acting.size, shadow: rows.filter((r) => r.outcome === 'shadow').length }
}

const utcDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

/** The request a row carries: one asked now, or the one carried before while it waits or its quiet days run. */
function carriedAsk(d: StateDecision, outcome: StateOutcome, approvalId: string | null, before: (AskedRecord & { status: string | null }) | undefined, now: Date): AskedRecord | null {
  if (outcome === 'asked' && approvalId && (d.action === 'pause' || d.action === 'resume' || d.action === 'archive')) {
    return { action: d.action, approvalId, at: now.toISOString(), ...(d.action === 'pause' && d.startsMemory ? { memory: d.startsMemory } : {}) }
  }
  if (!before) return null
  const status = before.status
  if (status && ['pending', 'scheduled', 'executing'].includes(status)) return { action: before.action, approvalId: before.approvalId, at: before.at, ...(before.memory ? { memory: before.memory } : {}) }
  const declined = !status || ['rejected', 'expired'].includes(status)
  if (declined && now.getTime() - Date.parse(before.at) < (DECLINE_DAYS[before.action] + 1) * DAY_MS) return { action: before.action, approvalId: before.approvalId, at: before.at }
  return null
}

/**
 * One run: the 30-day prune (also when nothing is watched any more), then every watched product, market by market, each
 * campaign decided, acted on at its level and logged. `ask` and `write` are seams for tests (default: the approval gate
 * and the campaign status path).
 */
export async function runStateBrainOnce(opts: { now?: Date; products?: readonly StateWatched[]; ask?: AskFn; write?: WriteFn } = {}): Promise<StateRun> {
  const now = opts.now ?? new Date()
  const runId = `bs-${now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 8)}`
  const ask = opts.ask ?? askThroughApprovals
  const write = opts.write ?? writeAsTheBrain
  const products = opts.products ?? await stateWatchProducts()
  const out: StateRun = { runId, ran: false, why: '', campaigns: [], failed: [], pruned: await pruneStateDecisions(now) }
  if (!products.length) { out.why = 'no enrolled product has its state lever at OBSERVE or higher: nothing decided, nothing written'; return out }
  out.ran = true
  out.why = `${products.length} product${products.length === 1 ? '' : 's'} with the state lever at OBSERVE or higher`
  const ceilingLive = brainLiveCeiling()
  const posture = await readEnginePosture()
  for (const market of [...new Set(products.map((p) => p.market))]) {
    const left = await pausesToday(market, now)
    const pausesLeft = { acting: Math.max(0, MAX_PAUSES_PER_MARKET_DAY - left.acting), shadow: Math.max(0, MAX_PAUSES_PER_MARKET_DAY - left.shadow) }
    for (const p of products.filter((x) => x.market === market)) {
      try {
        const loaded = await loadProductStateFacts(p.productId, market, { now })
        if (!loaded) throw new Error(`product ${p.productId} has no family root in ${market}`)
        const ctx = (): StateContext => ({ now, ceilingLive, posture, pausesLeft })
        // AB-15 — the Owner's kill switch on the state lever, and the hold after an auto-undo (a pause or a resume it put back
        // is not made again for days): what it would do is kept, nothing is asked or written (brain/lever-holds.ts).
        const holds = await leverHolds('state', p.productId, market, now)
        const heldNow = new Map<string, string>()
        // Decide one campaign at a time: a pause takes one of the market's day's pauses before the next is decided.
        const decisions: StateDecision[] = []
        for (const f of loaded.facts) {
          const d = decideState(f, ctx())
          const held = d.outcome === 'ask' || d.outcome === 'write' ? campaignHoldWhy(holds, d.campaignId, d.action) : null
          if (held) { heldNow.set(d.campaignId, held); decisions.push(d); continue }
          if (d.action === 'pause' && (d.outcome === 'ask' || d.outcome === 'write')) pausesLeft.acting--
          if (d.action === 'pause' && d.outcome === 'shadow' && !f.shadowPaused) pausesLeft.shadow--
          decisions.push(d)
        }
        // A write or request refused today is tried again tomorrow (UTC), not every run: its refusal stands meanwhile.
        const final = new Map<string, { outcome: StateOutcome; approvalId: string | null; error: string | null }>()
        for (const [campaignId, why] of heldNow) final.set(campaignId, { outcome: 'held', approvalId: null, error: why })
        for (const d of decisions) {
          const prev = loaded.previous.get(d.campaignId)
          if ((d.outcome === 'ask' || d.outcome === 'write') && prev?.action === d.action && prev.outcome === 'refused' && utcDay(prev.createdAt) === utcDay(now)) {
            final.set(d.campaignId, { outcome: 'refused', approvalId: null, error: `refused at ${prev.createdAt.toISOString().slice(11, 16)} UTC — tried again tomorrow (UTC)` })
          }
        }
        // Act: one request per action for the product's campaigns asked about; one write per campaign written.
        for (const action of ['pause', 'resume', 'archive'] as const) {
          const asking = decisions.filter((d) => d.action === action && d.outcome === 'ask' && !final.has(d.campaignId))
          if (!asking.length) continue
          const { tool, args } = requestArgs(action, asking)
          const r = await ask(tool, args)
          for (const d of asking) final.set(d.campaignId, 'approvalId' in r ? { outcome: 'asked', approvalId: r.approvalId, error: null } : { outcome: 'refused', approvalId: null, error: r.error })
        }
        for (const d of decisions.filter((x) => x.outcome === 'write' && !final.has(x.campaignId))) {
          const r = await write(d.campaignId, d.action === 'pause' ? 'PAUSED' : 'ENABLED', d.why, runId)
          final.set(d.campaignId, r.queued ? { outcome: 'queued', approvalId: null, error: null } : { outcome: 'refused', approvalId: null, error: r.error })
        }
        // Log what changed (and the day's first of what the brain carries).
        const data: Prisma.AdsBrainStateDecisionCreateManyInput[] = []
        for (const d of decisions) {
          const f = final.get(d.campaignId)
          const outcome: StateOutcome = f?.outcome ?? (d.outcome === 'ask' || d.outcome === 'write' ? 'refused' : d.outcome)
          const approvalId = f?.approvalId ?? d.approvalId ?? null
          const why = f?.error ? `${d.why} — not done: ${f.error}` : d.why
          // A pause written starts the brain's memory (one asked for carries it on its request); a resume written ends it;
          // otherwise the pause in force, if any, rides on.
          const memory = d.action === 'pause' && outcome === 'queued' ? d.startsMemory : d.action === 'resume' && outcome === 'queued' ? null : d.memory
          const asked = carriedAsk(d, outcome, approvalId, loaded.asked.get(d.campaignId), now)
          const record = { ...d, outcome, approvalId, why, memory, asked }
          const hash = stateDecisionHash({ ...record, refusedOn: outcome === 'refused' ? utcDay(now) : null })
          const carries = !!memory || !!asked
          const kind = stateRowKind(hash, carries, loaded.previous.get(d.campaignId), now)
          out.campaigns.push({ campaignId: d.campaignId, productId: d.productId, market, action: d.action, outcome, stored: kind, why, approvalId })
          if (!kind) continue
          data.push({
            runId, mode: d.mode, kind, productId: d.productId, marketplace: market, campaignId: d.campaignId, level: d.level, action: d.action, outcome,
            cause: d.cause, status: d.status, expectedEndAt: d.expectedEndAt ? new Date(d.expectedEndAt) : null, horizonHours: d.horizonHours, approvalId,
            decisionHash: hash, decision: record as unknown as Prisma.InputJsonObject, why, createdAt: now,
          })
        }
        if (data.length) await prisma.adsBrainStateDecision.createMany({ data })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        logger.error('[brain-state] product run failed', { productId: p.productId, market, error })
        out.failed.push({ productId: p.productId, market, error })
      }
    }
  }
  const acted = out.campaigns.filter((c) => c.outcome === 'queued' || c.outcome === 'asked')
  if (acted.length) logger.info('[brain-state] the brain acted on campaign states', { runId, acted: acted.map((c) => ({ campaignId: c.campaignId, action: c.action, outcome: c.outcome, approvalId: c.approvalId ?? null })) })
  return out
}

/** The run's summary line: "STATE IT: pause queued 1, archive asked 1, keep 5 · pruned=<n>". */
export function stateSummaryLine(r: StateRun): string {
  if (!r.ran) return `${r.why} · pruned=${r.pruned}`
  const markets = [...new Set(r.campaigns.map((c) => c.market))]
  const parts = markets.map((m) => {
    const counts = new Map<string, number>()
    for (const c of r.campaigns.filter((x) => x.market === m)) {
      const key = c.action === 'keep' || c.action === 'hold' || c.action === 'skip' ? c.action : `${c.action} ${c.outcome}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return `${m}: ${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}`
  })
  const failed = r.failed.map((f) => `${f.market} ${f.productId} failed: ${f.error}`)
  return `STATE ${[...parts, ...failed].join(' · ') || 'no campaign'} · pruned=${r.pruned}`
}
