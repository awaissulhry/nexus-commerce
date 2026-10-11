/**
 * ONE BRAIN AB-11 — the harvest's writes (design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9, §3, §4 step 4; hard rule 4).
 * Every write goes through Nexus's existing paths, which ask the write gate and send through the channel gateway: the
 * keyword through the ad group's own create (ads-create.service.ts createKeywordLocal / createTargetLocal, `requireAmazon`:
 * nothing is written unless Amazon took it), each source negative through the one negative write service
 * (ads-negative-kw.service.ts), an undo through the mutation layer (the queue) and the negative retire service.
 *
 *   one change set  the keyword in the destination AND the negative exact in every source, as ONE pair: both halves are
 *                   asked of the write gate first (as the writer they run as) — any refusal, and neither is written; then
 *                   the keyword; a source is negated only once the keyword stands (so the term is never left without a
 *                   home). A negative that still fails then leaves the pair HALF_DONE: the keyword stands, the failed
 *                   negatives are retried by the next run (a refusal is the gate's or the Owner's word: it is named, not
 *                   retried). The record says which half landed, with Amazon's ids.
 *   claim           a pair is claimed (its status set to WRITING in one update) before anything is sent, so the daily run,
 *                   a retry and an approved request never write it twice; the create services' own dedupe makes a rerun
 *                   after a crash write nothing twice either.
 *   who             AUTO and the retries: the brain's actor (HARVEST_ACTOR; the gate passes it on a lever the product's
 *                   brain owns and refuses it on one the Owner locked). An approved request: the person who approved it
 *                   (`manual`), its approval the change set of every write.
 *   requests        PROPOSE asks a person through the normal approval gate, as auto-undo does: apply-brain-harvest for a
 *                   pair or its undo, create-ad-campaign (a Nexus builder) for a new campaign — always a person, never by
 *                   rule (D1 = B).
 *   undo            the pair put back as a pair (undoHarvest): the gate asked for both halves first, the source negatives
 *                   retired, then the keyword paused — never a keyword paused while a source still blocks the term.
 *   landing         (harvest fix B1 + B10, harvest-landing-guard.ts) before anything is written: an archived keyword of the
 *                   term or a negative that blocks it in the destination, or a destination that does not serve, holds the
 *                   pair (HELD, nothing written, decided again by the next run); an enabled one is the keyword (nothing
 *                   created). A paused one is switched on again at the start bid (held as a create's) instead of a create —
 *                   but that is no landing yet: the pair is HALF_DONE with every source still owed, and the next run sends
 *                   them once Amazon confirmed the switch. A keyword that already stands is asked again before an owed
 *                   source negative is sent: one paused, unconfirmed, stopped or blocked since sends none (the term would
 *                   serve nowhere) — the negatives stay owed and the next run tries again.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { blocksOf, undoHarvestWrite, writeHarvest, type UndoOutcome } from '../harvest/write.js'
import { HARVEST_ACTOR, JUDGE_AFTER_MS, type HarvestStatus, type NewCampaignPlan, type SourcePlan } from './harvest.js'

/** The tool a person approves for a pair or its undo (services/agents/tools/ads-brain-harvest.tools.ts). */
export const HARVEST_TOOL = 'apply-brain-harvest'
/** The Nexus builder a new campaign goes through (services/agents/tools/ads-create.tools.ts). */
export const CAMPAIGN_TOOL = 'create-ad-campaign'
/** A WRITING claim older than this was left by a run that died: it is taken up again (the writes are idempotent). */
export const WRITING_LEASE_MS = 30 * 60_000

/** Who writes, and for which approval (the engine's: harvest/write.ts). */
export type { Who, UndoOutcome } from '../harvest/write.js'
import type { Who } from '../harvest/write.js'

export const brainWho = (reason: string, changeSetId: string | null = null): Who => ({ actor: HARVEST_ACTOR, manual: false, changeSetId, reason })

/** A source as the record keeps it: the plan, and what became of its negative. */
export interface SourceState extends SourcePlan {
  negativeTargetId?: string | null
  result?: 'landed' | 'failed' | 'refused'
  error?: string | null
}

export const sourcesOf = (raw: unknown): SourceState[] => (Array.isArray(raw) ? raw as SourceState[] : [])
const json = (v: unknown) => v as Prisma.InputJsonValue

export interface PairOutcome {
  status: HarvestStatus
  /** `confirmed` false: switched on again, Amazon has not confirmed it yet (the judging clock waits); `bidCents`: written. */
  keyword: { targetId: string | null; externalTargetId: string | null; existed: boolean; confirmed?: boolean; bidCents?: number | null } | null
  sources: SourceState[]
  why: string
  error: string | null
}

/**
 * Write a pair (or what is left of it): the gate asked for both halves first, then the keyword (when it is not there
 * yet), then each source negative still owed. Pure of the record: the caller stores the outcome. HARVEST ENGINE — the
 * engine's one writer (harvest/write.ts writeHarvest): EXACT, no funnel blocks (the brain's negatives lever owns those).
 */
export async function writePair(p: { term: string; isAsin: boolean; destAdGroupId: string; bidCents: number; keywordTargetId: string | null; sources: readonly SourceState[]; retryRefused?: boolean }, who: Who): Promise<PairOutcome> {
  const o = await writeHarvest({ term: p.term, isAsin: p.isAsin, match: 'EXACT', destAdGroupId: p.destAdGroupId, bidCents: p.bidCents, keywordTargetId: p.keywordTargetId, sources: p.sources, funnel: [], retryRefused: p.retryRefused, metric: 'brainHarvest', noServeWords: 'the brain never harvests into a destination that does not serve' }, who)
  return { status: o.status, keyword: o.keyword, sources: o.sources as SourceState[], why: o.why, error: o.error }
}

/**
 * The fields a pair's outcome writes onto its record. `landedAt` (the judging clock) starts once the keyword stands and
 * serves: when the pair first becomes DONE or HALF_DONE (a built campaign's keyword: when its sources are negated, after
 * the campaign went live).
 */
export function outcomeData(o: PairOutcome, now: Date, landedBefore: Date | null = null): Prisma.AdsBrainHarvestUpdateInput {
  // A switch-on Amazon has not confirmed is no landing yet: the clock starts with the pair the next run completes.
  const stands = o.status === 'DONE' || (o.status === 'HALF_DONE' && o.keyword?.confirmed !== false)
  return {
    status: o.status,
    ...(o.status === 'HELD' ? { heldBy: o.error } : {}),
    sources: json(o.sources),
    ...(o.keyword?.targetId ? { keywordTargetId: o.keyword.targetId } : {}),
    ...(o.keyword?.bidCents != null ? { bidCents: o.keyword.bidCents } : {}),
    ...(stands && !landedBefore ? { landedAt: now, judgeAfter: new Date(now.getTime() + JUDGE_AFTER_MS), verdict: 'WAITING' } : {}),
    lastError: o.error,
    why: o.why,
    changedAt: now,
  }
}

/**
 * Claim a harvest for writing: one update from one of `from` to WRITING (a stale WRITING claim is taken up too). False when
 * another run, a retry or an approved request holds it, or it is no longer in a state to write.
 */
export async function claimHarvest(id: string, from: readonly HarvestStatus[], now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - WRITING_LEASE_MS)
  const claimed = await prisma.adsBrainHarvest.updateMany({
    where: { id, OR: [{ status: { in: [...from] } }, { status: 'WRITING', changedAt: { lt: stale } }] },
    data: { status: 'WRITING', changedAt: now, attempts: { increment: 1 } },
  })
  return claimed.count === 1
}

/**
 * Write a claimed harvest's pair (AUTO, an approved request, a retry, a built campaign's sources) and store what became
 * of it. The caller claimed it (claimHarvest).
 */
export async function executeClaimedPair(id: string, who: Who, now: Date, opts: { retryRefused?: boolean } = {}): Promise<PairOutcome> {
  const r = await prisma.adsBrainHarvest.findUniqueOrThrow({ where: { id } })
  if (!r.destAdGroupId || r.bidCents == null) {
    const o: PairOutcome = { status: 'REFUSED', keyword: null, sources: sourcesOf(r.sources), why: 'the harvest names no destination ad group or start bid: nothing was written', error: 'no destination' }
    await prisma.adsBrainHarvest.update({ where: { id }, data: outcomeData(o, now, r.landedAt) })
    return o
  }
  let o: PairOutcome
  try {
    o = await writePair({ term: r.term, isAsin: r.isAsin, destAdGroupId: r.destAdGroupId, bidCents: r.bidCents, keywordTargetId: r.keywordTargetId, sources: sourcesOf(r.sources), retryRefused: opts.retryRefused }, who)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    o = { status: r.keywordTargetId ? 'HALF_DONE' : 'FAILED', keyword: null, sources: sourcesOf(r.sources), why: `the write failed (${msg}): ${r.keywordTargetId ? 'the keyword stands; the negatives are retried' : 'nothing was written'}`, error: msg }
  }
  await prisma.adsBrainHarvest.update({ where: { id }, data: { ...outcomeData(o, now, r.landedAt), ...(who.changeSetId && !r.approvalId ? { approvalId: who.changeSetId } : {}) } })
  logger.info('[ads-brain-harvest] pair', { id, term: r.term, status: o.status, actor: who.actor })
  return o
}

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Put a harvest back AS A PAIR (batch 2 fix; Owner 10-08: the safety net restores the source): every source negative it
 * made retired, so the term runs where it ran before, then the new keyword paused (it stays at Amazon). Both halves are
 * asked of the write gate first, as the writer they run as — any refusal and neither is written. The keyword is paused only
 * once every source runs the term again: a retire that fails leaves the keyword running (the term is never left without a
 * home), named, and the undo can be sent again (it writes only what is left). Through the mutation layer (the queue) and
 * the negative retire service: as the approver (his approval the change set), or as auto-undo (a safety owner at the gate).
 */
export async function undoHarvest(id: string, who: Who): Promise<UndoOutcome> {
  const r = await prisma.adsBrainHarvest.findUniqueOrThrow({ where: { id } })
  // HARVEST ENGINE — the engine's one undo (harvest/write.ts undoHarvestWrite): its funnel blocks too (the page's and
  // Claude's harvests), and the keyword paused only when this harvest made or enabled it (one that stood before stays).
  const before = ((r.evidence ?? {}) as { keywordBefore?: string }).keywordBefore
  return undoHarvestWrite({ keywordTargetId: r.keywordTargetId, pauseKeyword: before !== 'stood', blocks: [...sourcesOf(r.sources), ...blocksOf((r as { funnel?: unknown }).funnel)] }, who)
}

// ── Requests a person decides ───────────────────────────────────────────────────────────────────────────────────

/** Queue one request through the normal approval gate as Nexus's ads brain (forceAsk: always a person). */
async function ask(tool: string, args: Record<string, unknown>): Promise<{ approvalId: string } | { error: string }> {
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-brain-harvest', trigger: 'schedule', status: 'running', input: json({ tool, args }) } })
  const asked = await runOrQueueTool(tool, args, systemPrincipal('Nexus ads brain'), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: json({ mode: 'queued', approvalId: asked.approvalId ?? null }) } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** A waiting request for this harvest (op), other than `except`; null when none. */
async function waiting(harvestId: string, op: 'harvest' | 'undo') {
  return prisma.agentApproval.findFirst({
    where: { toolName: HARVEST_TOOL, status: { in: ['pending', 'scheduled', 'executing'] }, AND: [{ args: { path: ['harvestId'], equals: harvestId } }, { args: { path: ['op'], equals: op } }] },
    select: { id: true },
  })
}

/** PROPOSE: the pair as one request a person approves (apply-brain-harvest op harvest). */
export async function proposePair(harvestId: string, why: string) {
  const open = await waiting(harvestId, 'harvest')
  if (open) return { approvalId: open.id }
  return ask(HARVEST_TOOL, { op: 'harvest', harvestId, why: why.slice(0, 300) })
}

/** A worse harvest: its undo as one request a person approves (apply-brain-harvest op undo). */
export async function proposeUndo(harvestId: string, why: string) {
  const open = await waiting(harvestId, 'undo')
  if (open) return { approvalId: open.id }
  return ask(HARVEST_TOOL, { op: 'undo', harvestId, why: why.slice(0, 300) })
}

/** No destination: a new campaign through a Nexus builder (create-ad-campaign), a request a person approves (D1 = B). */
export async function proposeCampaign(market: string, plan: NewCampaignPlan, why: string) {
  return ask(CAMPAIGN_TOOL, {
    market, name: plan.name, skus: plan.skus, dailyBudgetCents: plan.dailyBudgetCents, defaultBidCents: plan.defaultBidCents,
    ...(plan.keywords.length ? { keywords: plan.keywords } : { productTargets: plan.productTargets }),
    // HARVEST ENGINE (10-08 N2: one portfolio per product) — the new campaign is born in the product's portfolio.
    ...(plan.portfolioId ? { portfolioId: plan.portfolioId } : {}),
    biddingStrategy: 'down',
    why: why.slice(0, 300),
  })
}
