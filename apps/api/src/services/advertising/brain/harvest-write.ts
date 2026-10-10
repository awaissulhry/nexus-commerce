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
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { createKeywordLocal, createTargetLocal } from '../ads-create.service.js'
import { checkLanding, enableLanding, servingLandings, switchOnBid } from '../harvest-landing-guard.js'
import { writeNegativeKeyword, writeNegativeProductTarget } from '../ads-negative-kw.service.js'
import { HARVEST_ACTOR, JUDGE_AFTER_MS, type HarvestStatus, type NewCampaignPlan, type SourcePlan } from './harvest.js'

/** The tool a person approves for a pair or its undo (services/agents/tools/ads-brain-harvest.tools.ts). */
export const HARVEST_TOOL = 'apply-brain-harvest'
/** The Nexus builder a new campaign goes through (services/agents/tools/ads-create.tools.ts). */
export const CAMPAIGN_TOOL = 'create-ad-campaign'
/** A WRITING claim older than this was left by a run that died: it is taken up again (the writes are idempotent). */
export const WRITING_LEASE_MS = 30 * 60_000

/** Who writes, and for which approval. */
export interface Who {
  actor: string
  /** A person's approval (passes the allowlist and pins, as his own click); false for the brain. */
  manual: boolean
  confirmOwnLimits?: boolean
  changeSetId: string | null
  reason: string
}

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

/** The gate's answer for each half, as the writer that will run it (nothing is written). */
export async function preflightPair(p: { term: string; isAsin: boolean; destAdGroupId: string | null; bidCents: number | null; keywordPending: boolean; sources: readonly SourceState[] }, who: Who): Promise<{ ok: true } | { half: 'keyword' | 'negative'; adGroupId: string; refusal: string; deniedAt: string }> {
  const ids = [...new Set([...(p.keywordPending && p.destAdGroupId ? [p.destAdGroupId] : []), ...p.sources.map((s) => s.adGroupId)])]
  const groups = new Map((ids.length ? await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, campaignId: true, campaign: { select: { marketplace: true, adProduct: true } } } }) : []).map((g) => [g.id, g]))
  const person = who.manual ? { manual: true, ...(who.confirmOwnLimits ? { confirmOwnLimits: true } : {}) } : {}
  if (p.keywordPending && p.destAdGroupId) {
    const g = groups.get(p.destAdGroupId)
    if (!g) return { half: 'keyword', adGroupId: p.destAdGroupId, deniedAt: 'not_found', refusal: `the destination ad group ${p.destAdGroupId} is no longer in Nexus` }
    const bid = p.bidCents ?? 0
    const gate = await checkAdsWriteGate({
      marketplace: g.campaign.marketplace, campaignId: g.campaignId, adGroupId: g.id, field: 'bid', fields: ['bid'], intendedValueCents: bid, payloadValueCents: bid,
      adProduct: g.campaign.adProduct, dimension: 'keywords', actor: who.actor, ...person,
    } as never)
    if (gate.allowed === false) return { half: 'keyword', adGroupId: g.id, deniedAt: gate.deniedAt, refusal: gate.reason }
  }
  for (const s of p.sources) {
    if (s.action !== 'negate' || s.result === 'landed') continue
    const g = groups.get(s.adGroupId)
    if (!g) return { half: 'negative', adGroupId: s.adGroupId, deniedAt: 'not_found', refusal: `the source ad group ${s.adGroupId} is no longer in Nexus` }
    const gate = await checkAdsWriteGate({
      marketplace: g.campaign.marketplace, campaignId: g.campaignId, payloadValueCents: 0, isNegation: true,
      keywordText: p.isAsin ? p.term.toUpperCase() : p.term, ...(p.isAsin ? {} : { negativeMatchType: 'NEGATIVE_EXACT' }),
      adProduct: g.campaign.adProduct, dimension: 'negatives', actor: who.actor, ...person,
    } as never)
    if (gate.allowed === false) return { half: 'negative', adGroupId: g.id, deniedAt: gate.deniedAt, refusal: gate.reason }
  }
  return { ok: true }
}

/** The keyword (or product target) in the destination; its result as the record keeps it. */
async function addKeyword(p: { term: string; isAsin: boolean; destAdGroupId: string; bidCents: number }, who: Who) {
  const common = { adGroupId: p.destAdGroupId, bidEur: p.bidCents / 100, userId: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, requireAmazon: true }
  const made = p.isAsin
    ? await createTargetLocal({ ...common, kind: 'PRODUCT', value: p.term.toUpperCase() })
    : await createKeywordLocal({ ...common, keywordText: p.term, matchType: 'EXACT', evidence: { metric: 'brainHarvest', note: who.reason } as never })
  const outcome = (made as { outcome?: string }).outcome
  const landed = !!made.id && !!made.externalTargetId && (outcome === 'created' || outcome === 'already_existed' || outcome == null)
  const reason = (made as { reason?: string | null }).reason ?? (made as { denied?: { reason?: string } }).denied?.reason ?? (made as { pushError?: string }).pushError ?? null
  return { landed, targetId: made.id, externalTargetId: made.externalTargetId, existed: outcome === 'already_existed' || (made as { existed?: boolean }).existed === true, refused: outcome === 'refused' || outcome === 'needs_confirmation', reason }
}

/** One source negative: negative exact (an ASIN: a negative product target) in the source ad group. */
async function negateSource(term: string, isAsin: boolean, s: SourceState, who: Who): Promise<SourceState> {
  const out = isAsin
    ? await writeNegativeProductTarget({ adGroupId: s.adGroupId, asin: term.toUpperCase(), userId: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, evidence: { metric: 'brainHarvest', note: who.reason } as never })
    : await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: s.adGroupId, keywordText: term, matchType: 'EXACT', userId: who.actor, manual: who.manual, changeSetId: who.changeSetId, evidence: { metric: 'brainHarvest', note: who.reason } as never })
  if ((out.outcome === 'created' || out.outcome === 'local' || out.outcome === 'already_existed') && out.adTargetId) return { ...s, negativeTargetId: out.adTargetId, result: 'landed', error: null }
  if (out.outcome === 'refused') return { ...s, result: 'refused', error: `${out.refusal?.deniedAt ?? 'refused'}: ${out.refusal?.reason ?? 'refused'}` }
  return { ...s, result: 'failed', error: out.error ?? 'the negative did not reach Amazon' }
}

/**
 * Write a pair (or what is left of it): the gate asked for both halves first, then the keyword (when it is not there
 * yet), then each source negative still owed. Pure of the record: the caller stores the outcome.
 */
export async function writePair(p: { term: string; isAsin: boolean; destAdGroupId: string; bidCents: number; keywordTargetId: string | null; sources: readonly SourceState[]; retryRefused?: boolean }, who: Who): Promise<PairOutcome> {
  const keywordPending = !p.keywordTargetId
  // A negative the gate or the Owner refused is named, not retried by the brain; a person's approval asks for it again.
  const owes = (s: SourceState) => s.action === 'negate' && s.result !== 'landed' && (p.retryRefused === true || s.result !== 'refused')
  // Harvest fix B1 + B10 — the landing guard (see the header): nothing is written where the term could not serve.
  const landing = keywordPending ? await checkLanding({ adGroupId: p.destAdGroupId, term: p.term, match: p.isAsin ? 'PRODUCT' : 'EXACT' }) : null
  if (landing && (landing.kind === 'hold' || (landing.kind !== 'enable' && !landing.serves))) {
    const why = landing.kind === 'hold' ? landing.why : `${landing.why}: the brain never harvests into a destination that does not serve`
    return { status: 'HELD', keyword: null, sources: [...p.sources], why: `held — ${why}`, error: why }
  }
  if (!keywordPending && p.sources.some(owes) && !(await servingLandings([{ adTargetId: p.keywordTargetId!, term: p.term }])).size) {
    const why = `the ${p.isAsin ? 'product target' : 'keyword'} is not enabled at Amazon (or its switch-on is not confirmed yet) in a serving ad group now, or a negative there blocks the term: no source is negated (the term would serve nowhere)`
    const sources = p.sources.map((s) => (owes(s) ? { ...s, result: 'failed' as const, error: why } : s))
    // Not serving now: no landing, so the judging clock does not start here (a pair that landed before keeps its own).
    return { status: 'HALF_DONE', keyword: { targetId: p.keywordTargetId, externalTargetId: null, existed: true, confirmed: false }, sources, why: `the keyword stands, but ${why}; retried by the next run`, error: why }
  }
  const pre = await preflightPair({ ...p, keywordPending, sources: p.sources.filter(owes) }, who)
  if (!('ok' in pre)) {
    const why = `the write gate refuses the ${pre.half === 'keyword' ? 'keyword' : 'source negative'} (${pre.deniedAt}: ${pre.refusal})`
    if (keywordPending) return { status: 'REFUSED', keyword: null, sources: [...p.sources], why: `nothing was written — ${why}; the pair is written whole or not at all`, error: why }
    const sources = p.sources.map((s) => (s.adGroupId === pre.adGroupId && owes(s) ? { ...s, result: 'refused' as const, error: `${pre.deniedAt}: ${pre.refusal}` } : s))
    return { status: 'HALF_DONE', keyword: { targetId: p.keywordTargetId, externalTargetId: null, existed: true }, sources, why: `the keyword stands; ${why}`, error: why }
  }
  let keyword: PairOutcome['keyword'] = { targetId: p.keywordTargetId, externalTargetId: null, existed: true }
  if (keywordPending && landing?.kind === 'enable') {
    // A paused keyword of the term in the destination: switched on again at the start bid (the bid the request showed).
    // No landing yet: every source stays owed until Amazon confirmed the switch (the next run, servingLandings above).
    const sw = await switchOnBid({ targetId: landing.targetId, wantCents: p.bidCents, who })
    const on = await enableLanding(landing.targetId, sw.cents, { actor: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, reason: `${who.reason} — ${landing.why}` })
    if (!on.ok) {
      const why = `${landing.why} — but the switch was refused (${on.why}): nothing was negated, nothing changed`
      return { status: 'REFUSED', keyword: null, sources: [...p.sources], why, error: on.why }
    }
    const kw = { targetId: landing.targetId, externalTargetId: landing.externalTargetId, existed: true, confirmed: false, bidCents: on.bidCents }
    const wait = 'waiting for Amazon to confirm the switch-on: sent by the next run'
    const sources = p.sources.map((s) => (owes(s) ? { ...s, result: 'failed' as const, error: wait } : s))
    const owedNow = sources.filter((s) => s.action === 'negate' && s.result !== 'landed').length
    return owedNow
      ? { status: 'HALF_DONE', keyword: kw, sources, why: `the paused ${p.isAsin ? 'product target' : 'keyword'} was switched on again${sw.held ? ` (its bid ${sw.held})` : ''}; ${owedNow === 1 ? 'its source negative waits' : `its ${owedNow} source negatives wait`} for Amazon to confirm the switch-on: sent by the next run`, error: wait }
      : { status: 'DONE', keyword: kw, sources, why: `the paused ${p.isAsin ? 'product target' : 'keyword'} was switched on again${sw.held ? ` (its bid ${sw.held})` : ''}; no source to negate`, error: null }
  } else if (keywordPending && landing?.kind === 'landed') {
    // An enabled keyword of the term already runs there: it is the keyword (the row the guard found, never another).
    keyword = { targetId: landing.targetId, externalTargetId: landing.externalTargetId, existed: true }
  } else if (keywordPending) {
    const k = await addKeyword(p, who)
    if (!k.landed) {
      const why = `the ${p.isAsin ? 'product target' : 'keyword'} did not reach Amazon (${k.reason ?? 'no id came back'}): nothing was negated, nothing changed`
      return { status: k.refused ? 'REFUSED' : 'FAILED', keyword: null, sources: [...p.sources], why, error: k.reason ?? 'not created' }
    }
    keyword = { targetId: k.targetId, externalTargetId: k.externalTargetId, existed: k.existed }
  }
  const sources: SourceState[] = []
  for (const s of p.sources) sources.push(owes(s) ? await negateSource(p.term, p.isAsin, s, who) : s)
  const owed = sources.filter((s) => s.action === 'negate' && s.result !== 'landed')
  if (!owed.length) {
    const landed = sources.filter((s) => s.action === 'negate').length
    return { status: 'DONE', keyword, sources, why: `${keywordPending ? `the ${p.isAsin ? 'product target' : 'keyword'} landed` : 'the keyword stands'}${landed ? ` and its ${landed === 1 ? 'source is' : `${landed} sources are`} negated exact` : ''}: one change set, whole`, error: null }
  }
  const errors = owed.map((s) => `ad group ${s.adGroupId}: ${s.error ?? 'not landed'}`).join('; ')
  return { status: 'HALF_DONE', keyword, sources, why: `the keyword stands, ${owed.length === 1 ? 'one source negative' : `${owed.length} source negatives`} did not land (${errors}): ${owed.some((s) => s.result === 'failed') ? 'retried by the next run' : 'refused — named, not retried'}`, error: errors }
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

export interface UndoOutcome {
  paused: boolean
  retired: number
  problems: string[]
  /** Nothing of the harvest stands any more: the keyword not enabled and no source negative standing. */
  complete: boolean
  /**
   * Batch 2 re-review fix — the halves of the pair already back before this call (a source negative no longer standing, the
   * keyword no longer enabled): above 0 with `complete` false, the pair is half put back (auto-undo keeps it open).
   */
  alreadyBack: number
  /** The action-log rows the undo wrote (the keyword's pause first, then each retire). */
  actionLogIds: string[]
}

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
  const negatives = sourcesOf(r.sources).map((s) => s.negativeTargetId).filter((x): x is string => !!x)
  const ids = [...(r.keywordTargetId ? [r.keywordTargetId] : []), ...negatives]
  const rows = ids.length
    ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, isNegative: true, status: true, adGroup: { select: { campaignId: true, campaign: { select: { name: true, marketplace: true, adProduct: true } } } } } })
    : []
  const keyword = rows.find((t) => t.id === r.keywordTargetId && !t.isNegative && String(t.status) === 'ENABLED') ?? null
  const standing = rows.filter((t) => t.isNegative && String(t.status) !== 'ARCHIVED')
  const alreadyBack = negatives.filter((n) => !standing.some((t) => t.id === n)).length + (r.keywordTargetId && !keyword ? 1 : 0)
  const out: UndoOutcome = { paused: false, retired: 0, problems: [], complete: false, actionLogIds: [], alreadyBack }
  if (!keyword && !standing.length) return { ...out, complete: true }

  // Both halves asked of the gate first, as the writer that will run them (nothing is written).
  const person = who.manual ? { manual: true, ...(who.confirmOwnLimits ? { confirmOwnLimits: true } : {}) } : {}
  const halves = [
    ...standing.map((t) => ({ half: 'the source negative', t, ctx: { dimension: 'negatives' } })),
    ...(keyword ? [{ half: 'the keyword\'s pause', t: keyword, ctx: { isSuppression: true } }] : []),
  ]
  for (const { half, t, ctx } of halves) {
    const g = t.adGroup
    const gate = await checkAdsWriteGate({
      marketplace: g?.campaign.marketplace ?? null, campaignId: g?.campaignId ?? null, payloadValueCents: 0, field: 'status', fields: ['status'],
      adProduct: g?.campaign.adProduct ?? null, actor: who.actor, ...ctx, ...person,
    } as never)
    if (gate.allowed === false) {
      return { ...out, problems: [`nothing was put back — the write gate refuses ${half} in campaign "${g?.campaign.name ?? '?'}" (${gate.deniedAt}: ${gate.reason}): the undo is written whole or not at all`] }
    }
  }

  // 1. The source negatives retired: the term runs where it ran before.
  if (standing.length) {
    const { retireNegatives } = await import('../negatives-retire.service.js')
    const res = await retireNegatives({ adTargetIds: standing.map((t) => t.id), actor: who.actor as never, retireReason: who.reason, changeSetId: who.changeSetId, manual: who.manual })
    for (const o of res.outcomes) {
      if (o.kind === 'retired' || o.kind === 'removed_local') { out.retired++; if (o.actionLogId) out.actionLogIds.push(o.actionLogId) }
      else if (o.kind !== 'skipped') out.problems.push(`a source negative was not retired (${o.reason ?? o.kind})`)
    }
  }
  // 2. The keyword paused, only once every source runs the term again (never left without a home).
  if (keyword && out.problems.length) out.problems.push('the keyword was left running: a source still blocks the term, so pausing it now would leave the term without a home — send the undo again')
  else if (keyword) {
    const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
    const res = await updateAdTargetWithSync({ adTargetId: keyword.id, patch: { status: 'PAUSED' }, actor: who.actor as never, reason: who.reason, changeSetId: who.changeSetId, manual: who.manual, letsGo: true, askGate: true })
    if (res.ok) { out.paused = true; if (res.actionLogId) out.actionLogIds.unshift(res.actionLogId) }
    else out.problems.push(`the keyword was not paused (${res.error ?? 'refused'}): the term runs in its sources and its exact keyword until the undo is sent again`)
  }
  out.complete = !out.problems.length
  return out
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
    biddingStrategy: 'down',
    why: why.slice(0, 300),
  })
}
