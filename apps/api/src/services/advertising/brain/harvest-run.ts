/**
 * ONE BRAIN AB-11 — the harvest run (design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9, §4 step 4, §5, §8 row AB-11).
 * Once a day (jobs/ads-brain-harvest.job.ts), inside one business, for every product whose harvest lever is OBSERVE or
 * higher. Per product, in this order:
 *
 *   1 pending   what earlier runs started: a request a person approved, declined or let expire; a campaign the builder made
 *               (CAMPAIGN_BUILT) whose sources are negated once it is live; a HALF_DONE pair whose failed negatives are
 *               sent again; a WRITING claim a dead run left; a harvest past the attribution window + 72 h, judged (a worse
 *               one gets its undo proposed). Written only at PROPOSE or AUTO under a live ceiling; judging writes nothing
 *               to Amazon and always runs.
 *   2 decide    the ledger's harvest candidates (brain/terms-shadow.ts decideMarket, the same decision the daily ledger
 *               stores), one harvest decision each (brain/harvest.ts decideHarvests), inside the day's and week's caps.
 *   3 act       OBSERVE (or a shadow ceiling): stored as SHADOW, what it would do in words. PROPOSE: the pair as one request a
 *               person approves (apply-brain-harvest). AUTO: the pair written now as the brain (brain/harvest-write.ts). A
 *               new campaign: a create-ad-campaign request a person approves, at PROPOSE and AUTO alike (D1 = B). Held:
 *               stored as HELD with why.
 *   store       one row per product × market × term (AdsBrainHarvest): an unchanged shadow or held decision is only
 *               stamped; a term in flight or placed is never decided again (one harvest per term — a winner is never moved).
 *   kept        shadow and held rows no run checked for 30 days, and ended ones (declined, refused, failed, undone) older
 *               than 90 days, are deleted; placed harvests stay (the term's history and its cooldown).
 */
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@nexus/database'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { settledEnd } from '../ads-settled-window.js'
import { termKey } from './terms.js'
import { harvestDue, loadHarvestMarket, type HarvestDue } from './harvest-load.js'
import { decideHarvests, GRADUATION_COOLDOWN_DAYS, judgeHarvest, type HarvestDecision, type HarvestEvidence, type HarvestProductFacts, type HarvestStatus } from './harvest.js'
import { brainWho, claimHarvest, executeClaimedPair, proposeCampaign, proposePair, proposeUndo, sourcesOf, WRITING_LEASE_MS, HARVEST_TOOL } from './harvest-write.js'

export const HARVEST_DAYS_KEPT = 30
export const ENDED_DAYS_KEPT = 90
const DAY = 86_400_000

const json = (v: unknown) => v as Prisma.InputJsonValue
const digestOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22)
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** Approval statuses that end a request without running it. */
const NOT_RUN = ['rejected', 'expired', 'superseded', 'cancelled', 'failed']
const OPEN = ['pending', 'scheduled', 'approved', 'executing']

export interface HarvestRunSummary {
  ran: boolean
  why: string
  runId?: string
  products: number
  markets: string[]
  decided: { pairs: number; newCampaigns: number; held: number }
  acted: { logged: number; proposed: number; written: number; campaignsProposed: number }
  pending: { synced: number; completed: number; retried: number; judged: number; undoProposed: number }
  skipped: Array<{ productId: string; market: string; why: string }>
  pruned: number
}

const blank = (): Pick<HarvestRunSummary, 'decided' | 'acted' | 'pending'> => ({
  decided: { pairs: 0, newCampaigns: 0, held: 0 },
  acted: { logged: 0, proposed: 0, written: 0, campaignsProposed: 0 },
  pending: { synced: 0, completed: 0, retried: 0, judged: 0, undoProposed: 0 },
})

/** The record's evidence: the candidate's, the destination's and the bid's why (money under `money` keys). */
export function recordEvidence(d: HarvestDecision): Record<string, unknown> {
  const dest = d.destination
  return {
    ...d.evidence,
    destination: dest.kind === 'NEW_CAMPAIGN'
      ? { kind: dest.kind, how: dest.how, why: dest.why, name: dest.plan.name, skus: dest.plan.skus.length, budgetWhy: dest.plan.budgetWhy, money: { dailyBudgetCents: dest.plan.dailyBudgetCents } }
      : dest.kind === 'EXISTING' ? { kind: dest.kind, how: dest.how, why: dest.why, keywords: dest.keywords, ...(dest.tie ? { tie: dest.tie } : {}) } : { kind: 'NONE', why: dest.why },
    act: d.act,
    bidWhy: d.bid?.why ?? null,
    ...(dest.kind === 'NEW_CAMPAIGN' ? { campaignPlan: { name: dest.plan.name, skus: dest.plan.skus, keywords: dest.plan.keywords.map((k) => ({ text: k.text, matchType: k.matchType })), productTargets: dest.plan.productTargets } } : {}),
  }
}

const statusOf = (d: HarvestDecision): HarvestStatus =>
  d.act === 'none' ? 'HELD' : d.act === 'log' ? 'SHADOW' : d.act === 'write' ? 'WRITING' : d.outcome === 'new-campaign' ? 'CAMPAIGN_PROPOSED' : 'PROPOSED'

/**
 * Store one decision on its term's row (one per product × market × term). A shadow or held decision that did not change
 * is only stamped; anything else rewrites the row as this cycle's harvest (a new decidedAt). Returns the row's id.
 */
export async function storeDecision(args: { productId: string; market: string; d: HarvestDecision; runId: string; now: Date }): Promise<{ id: string; changed: boolean }> {
  const { productId, market, d, runId, now } = args
  const status = statusOf(d)
  const dest = d.destination
  const content = {
    term: d.term, isAsin: d.isAsin, status, level: d.level ?? 'OBSERVE', destinationKind: dest.kind,
    destHow: dest.kind === 'NONE' ? null : dest.how,
    destCampaignId: dest.kind === 'EXISTING' ? dest.campaignId : null, destAdGroupId: dest.kind === 'EXISTING' ? dest.adGroupId : null,
    bidCents: d.bid?.cents ?? null, sources: d.sources, heldBy: d.heldBy, why: d.why.slice(0, 2000), evidence: recordEvidence(d),
  }
  const digest = digestOf({ ...content, evidence: { ...content.evidence, impressions: undefined } })
  const key = { product_market_term: workspaceKey({ productId, marketplace: market, term: d.term }) }
  const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true, digest: true, status: true } })
  if (was && was.digest === digest && was.status === status && (status === 'SHADOW' || status === 'HELD')) {
    await prisma.adsBrainHarvest.update({ where: { id: was.id }, data: { runId, checkedAt: now } })
    return { id: was.id, changed: false }
  }
  const data = {
    ...content, sources: json(content.sources), evidence: json(content.evidence), digest, runId, decidedAt: now, checkedAt: now, changedAt: now,
    // A new cycle of this term: nothing of an earlier one carries over.
    approvalId: null, undoApprovalId: null, keywordTargetId: null, landedAt: null, attempts: 0, lastError: null,
    judgeAfter: null, judgedAt: null, verdict: null, judgement: Prisma.DbNull,
  }
  const row = was
    ? await prisma.adsBrainHarvest.update({ where: { id: was.id }, data, select: { id: true } })
    : await prisma.adsBrainHarvest.create({ data: { productId, marketplace: market, ...data }, select: { id: true } })
  return { id: row.id, changed: true }
}

/** Act on one decision: store it, then ask a person or write as the decision says. */
async function actOn(productId: string, market: string, d: HarvestDecision, runId: string, now: Date, s: ReturnType<typeof blank>) {
  if (d.outcome === 'pair') s.decided.pairs++
  else if (d.outcome === 'new-campaign') s.decided.newCampaigns++
  else s.decided.held++
  const { id, changed } = await storeDecision({ productId, market, d, runId, now })
  if (d.act === 'log') { if (changed) s.acted.logged++; return }
  if (d.act === 'none') return
  if (d.act === 'write') {
    // Stored as WRITING: the row is this run's claim. The pair goes out as the brain.
    await executeClaimedPair(id, brainWho(`Ads brain harvest: ${d.why}`.slice(0, 500)), now)
    s.acted.written++
    return
  }
  const asked = d.outcome === 'new-campaign' && d.destination.kind === 'NEW_CAMPAIGN'
    ? await proposeCampaign(market, d.destination.plan, `Ads brain harvest of "${d.term}": no exact ad group of the product can take it, so a new campaign (D1 = B).`)
    : await proposePair(id, `Ads brain harvest of "${d.term}": the keyword and its source negatives in one change set.`)
  if ('approvalId' in asked) {
    await prisma.adsBrainHarvest.update({ where: { id }, data: { approvalId: asked.approvalId } })
    if (d.outcome === 'new-campaign') s.acted.campaignsProposed++
    else s.acted.proposed++
  } else {
    await prisma.adsBrainHarvest.update({ where: { id }, data: { status: 'HELD', heldBy: `the request could not be queued: ${asked.error}`, changedAt: now } })
  }
}

/** The keyword's own record in its destination since it landed (settled days only). */
async function postEvidence(r: { term: string; destAdGroupId: string | null; landedAt: Date }, now: Date) {
  const g = r.destAdGroupId ? await prisma.adGroup.findUnique({ where: { id: r.destAdGroupId }, select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true } } } }) : null
  const since = new Date(startOfUtcDay(r.landedAt).getTime() + DAY)
  const until = settledEnd('SPONSORED_PRODUCTS', { now }).until
  const settledDays = Math.max(0, Math.floor((startOfUtcDay(until).getTime() - since.getTime()) / DAY) + 1)
  const post = { impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0 }
  if (g?.externalAdGroupId && g.campaign?.externalCampaignId && settledDays > 0) {
    const rows = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query'],
      where: { campaignId: g.campaign.externalCampaignId, adGroupId: g.externalAdGroupId, date: { gte: since, lte: until } },
      _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
    })
    for (const row of rows) {
      if (termKey(row.query) !== r.term && row.query.trim().toLowerCase() !== r.term) continue
      post.impressions += row._sum.impressions ?? 0
      post.clicks += row._sum.clicks ?? 0
      post.orders += row._sum.orders7d ?? 0
      post.salesCents += row._sum.sales7dCents ?? 0
      post.spendCents += Math.round(Number(row._sum.costMicros ?? 0n) / 10_000)
    }
  }
  return { post, settledDays }
}

/** Is the built campaign live: enabled, on the allowlist, its bids not suppressed, its keyword at Amazon and enabled. */
async function liveNow(campaignId: string | null, keywordTargetId: string | null): Promise<string | null> {
  if (!campaignId || !keywordTargetId) return 'the built campaign or its keyword is not known yet'
  const [c, t] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, liveBidWritesEnabled: true, bidsSuppressedAt: true } }),
    prisma.adTarget.findUnique({ where: { id: keywordTargetId }, select: { status: true, externalTargetId: true } }),
  ])
  if (!c || !t) return 'the built campaign or its keyword is no longer in Nexus'
  if (String(c.status) !== 'ENABLED') return `the new campaign is ${String(c.status).toLowerCase()}`
  if (!c.liveBidWritesEnabled) return 'the new campaign is not on the live-write allowlist yet (set-campaign-live-writes)'
  if (c.bidsSuppressedAt) return 'the new campaign still sits at the floor it was born at (restore-campaign starts it)'
  if (!t.externalTargetId || String(t.status) !== 'ENABLED') return 'its keyword is not live at Amazon'
  return null
}

/** What earlier runs started (see the header, step 1). */
async function pendingWork(productId: string, market: string, facts: HarvestProductFacts, now: Date, s: ReturnType<typeof blank>) {
  const records = await prisma.adsBrainHarvest.findMany({
    where: { productId, marketplace: market, status: { in: ['PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'UNDO_PROPOSED', 'HALF_DONE', 'WRITING', 'DONE'] } },
  })
  if (!records.length) return
  const level = facts.ctx.levers.harvest
  const mayWrite = facts.ceiling.live && (level === 'PROPOSE' || level === 'AUTO')
  const why = mayWrite ? null : facts.ceiling.live ? `the harvest lever is ${level} for this product: it writes nothing now` : facts.ceiling.why
  const approvalIds = [...new Set(records.flatMap((r) => [r.approvalId, r.undoApprovalId]).filter((x): x is string => !!x))]
  const approvals = new Map((approvalIds.length ? await prisma.agentApproval.findMany({ where: { id: { in: approvalIds } }, select: { id: true, status: true, reason: true } }) : []).map((a) => [a.id, a]))
  const openFor = async (harvestId: string, op: 'harvest' | 'undo') => prisma.agentApproval.findFirst({
    where: { toolName: HARVEST_TOOL, status: { in: OPEN }, AND: [{ args: { path: ['harvestId'], equals: harvestId } }, { args: { path: ['op'], equals: op } }] }, select: { id: true },
  })
  for (const r of records) {
    const update = async (data: Prisma.AdsBrainHarvestUpdateInput) => { await prisma.adsBrainHarvest.update({ where: { id: r.id }, data: { ...data, changedAt: now, checkedAt: now } }); s.pending.synced++ }
    const a = r.approvalId ? approvals.get(r.approvalId) : undefined
    if (r.status === 'PROPOSED') {
      if (!a || NOT_RUN.includes(a.status)) {
        const other = await openFor(r.id, 'harvest')
        if (other) await update({ approvalId: other.id })
        else await update({ status: 'DECLINED', why: `the request ${r.approvalId ?? ''} was ${a?.status ?? 'not found'}: not proposed again for ${GRADUATION_COOLDOWN_DAYS} days`.replace('  ', ' ') })
      } else if (a.status === 'executed') {
        // The approved request ran but never claimed the pair (its fresh check refused it): said, and the cooldown starts.
        await update({ status: 'REFUSED', why: `the approved request ${a.id} did not run the pair: ${a.reason ?? 'its fresh check refused it'}` })
      }
      continue
    }
    if (r.status === 'CAMPAIGN_PROPOSED') {
      if (!a || NOT_RUN.includes(a.status)) { await update({ status: 'DECLINED', why: `the new campaign's request ${r.approvalId ?? ''} was ${a?.status ?? 'not found'}`.replace('  ', ' ') }); continue }
      if (a.status !== 'executed') continue
      const change = await prisma.agentChange.findFirst({ where: { approvalId: a.id }, select: { after: true } })
      const campaignId = (change?.after as { campaignId?: string } | null)?.campaignId ?? null
      const group = campaignId ? await prisma.adGroup.findFirst({ where: { campaignId }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null
      const target = group ? await prisma.adTarget.findFirst({ where: { adGroupId: group.id, isNegative: false, kind: r.isAsin ? 'PRODUCT' : 'KEYWORD', expressionValue: { equals: r.term, mode: 'insensitive' } }, select: { id: true } }) : null
      if (!campaignId || !group || !target) { await update({ status: 'FAILED', why: `the approved request ${a.id} ran, but the new campaign or its keyword is not in Nexus: nothing to negate` }); continue }
      await update({ status: 'CAMPAIGN_BUILT', destCampaignId: campaignId, destAdGroupId: group.id, keywordTargetId: target.id, why: 'the new campaign is built (born at the floor, off the live-write allowlist): its sources are negated once it is live' })
      r.status = 'CAMPAIGN_BUILT'; r.destCampaignId = campaignId; r.destAdGroupId = group.id; r.keywordTargetId = target.id
    }
    if (r.status === 'CAMPAIGN_BUILT') {
      const notLive = await liveNow(r.destCampaignId, r.keywordTargetId)
      if (notLive) { if (r.heldBy !== `waiting: ${notLive}`) await update({ heldBy: `waiting: ${notLive}` }); continue }
      if (!mayWrite) { if (r.heldBy !== why) await update({ heldBy: why }); continue }
      if (await claimHarvest(r.id, ['CAMPAIGN_BUILT'], now)) {
        await executeClaimedPair(r.id, brainWho(`Ads brain harvest of "${r.term}": the new campaign is live, its sources negated`, r.approvalId), now)
        s.pending.completed++
      }
      continue
    }
    if (r.status === 'UNDO_PROPOSED') {
      const u = r.undoApprovalId ? approvals.get(r.undoApprovalId) : undefined
      if (!u || NOT_RUN.includes(u.status) || u.status === 'executed') {
        // Declined (or ran without putting it back): the harvest stays, and its undo is not proposed again.
        const judgement = { ...((r.judgement ?? {}) as Record<string, unknown>), undoDeclined: true }
        await update({ status: 'DONE', judgement: json(judgement), why: `the undo request ${r.undoApprovalId ?? ''} was ${u?.status ?? 'not found'}: the harvest stays`.replace('  ', ' ') })
      }
      continue
    }
    const stale = r.status === 'WRITING' && now.getTime() - r.changedAt.getTime() > WRITING_LEASE_MS
    const failedOwed = r.status === 'HALF_DONE' && sourcesOf(r.sources).some((x) => x.action === 'negate' && x.result === 'failed')
    if (stale || failedOwed) {
      if (mayWrite && await claimHarvest(r.id, ['HALF_DONE'], now)) {
        await executeClaimedPair(r.id, brainWho(`Ads brain harvest of "${r.term}": the pair completed`, r.approvalId), now)
        s.pending.retried++
      }
      continue
    }
    if ((r.status === 'DONE' || r.status === 'HALF_DONE') && r.landedAt && r.judgeAfter && r.judgeAfter <= now && (r.verdict == null || r.verdict === 'WAITING')) {
      const ev = (r.evidence ?? {}) as Partial<HarvestEvidence>
      const { post, settledDays } = await postEvidence({ term: r.term, destAdGroupId: r.destAdGroupId, landedAt: r.landedAt }, now)
      const j = judgeHarvest({
        landedAt: r.landedAt, now, settledDays, post, bandTop: facts.ctx.bandTop?.value ?? null,
        pre: { clicks: ev.clicks ?? 0, orders: ev.orders ?? 0, spendCents: ev.money?.spendCents ?? 0, salesCents: ev.money?.salesCents ?? 0, cr: ev.cr ?? 0 },
      })
      const judgement = { why: j.why, final: j.final, numbers: j.numbers }
      s.pending.judged++
      if (j.verdict !== 'WORSE') { await update({ verdict: j.verdict, judgedAt: now, judgement: json(judgement) }); continue }
      if (!mayWrite) { await update({ verdict: 'WORSE', judgedAt: now, judgement: json({ ...judgement, wouldUndo: true }), heldBy: `${why}: it would propose the undo` }); continue }
      const asked = await proposeUndo(r.id, `Ads brain judgement of the harvest of "${r.term}": ${j.why}`)
      if ('approvalId' in asked) {
        await update({ status: 'UNDO_PROPOSED', verdict: 'WORSE', judgedAt: now, judgement: json(judgement), undoApprovalId: asked.approvalId })
        s.pending.undoProposed++
      } else await update({ verdict: 'WORSE', judgedAt: now, judgement: json(judgement), heldBy: `the undo request could not be queued: ${asked.error}` })
    }
  }
}

/** Delete shadow and held rows no run checked for 30 days, and ended ones older than 90 days. */
export async function pruneHarvests(now: Date): Promise<number> {
  const [a, b] = await Promise.all([
    prisma.adsBrainHarvest.deleteMany({ where: { status: { in: ['SHADOW', 'HELD'] }, checkedAt: { lt: new Date(now.getTime() - HARVEST_DAYS_KEPT * DAY) } } }),
    prisma.adsBrainHarvest.deleteMany({ where: { status: { in: ['DECLINED', 'REFUSED', 'FAILED', 'UNDONE'] }, changedAt: { lt: new Date(now.getTime() - ENDED_DAYS_KEPT * DAY) } } }),
  ])
  return a.count + b.count
}

/** One run in the business the caller is in. Nothing due: nothing read past the enrollments, nothing written but the prune. */
export async function runHarvestOnce(opts: { now?: Date; due?: HarvestDue } = {}): Promise<HarvestRunSummary> {
  const now = opts.now ?? new Date()
  const due = opts.due ?? await harvestDue()
  if (!due.due) return { ran: false, why: due.why, products: 0, markets: [], ...blank(), skipped: [], pruned: await pruneHarvests(now) }
  const runId = randomUUID()
  const s = blank()
  const skipped: HarvestRunSummary['skipped'] = []
  const byMarket = new Map<string, typeof due.products>()
  for (const d of due.products) byMarket.set(d.market, [...(byMarket.get(d.market) ?? []), d])
  let products = 0
  for (const [market, list] of [...byMarket].sort(([a], [b]) => a.localeCompare(b))) {
    const m = await loadHarvestMarket(market, list, now)
    for (const k of m.skipped) skipped.push({ ...k, market })
    for (const [productId, p] of m.products) {
      products++
      await pendingWork(productId, market, p.facts, now, s)
      for (const d of decideHarvests(p.candidates, p.facts, now, m.terms.windowDays)) await actOn(productId, market, d, runId, now, s)
    }
  }
  const pruned = await pruneHarvests(now)
  const summary: HarvestRunSummary = { ran: true, why: due.why, runId, products, markets: [...byMarket.keys()].sort(), ...s, skipped, pruned }
  logger.info('[ads-brain-harvest] run', { runId, products, markets: summary.markets, decided: s.decided, acted: s.acted, pending: s.pending, skipped: skipped.length, pruned })
  return summary
}

/** The run in one line (the cron's record). */
export function harvestSummaryLine(s: HarvestRunSummary): string {
  if (!s.ran) return `not run: ${s.why}`
  return `products=${s.products} markets=${s.markets.join(',') || '-'} pairs=${s.decided.pairs} newCampaigns=${s.decided.newCampaigns} held=${s.decided.held} logged=${s.acted.logged} proposed=${s.acted.proposed} written=${s.acted.written} campaignsProposed=${s.acted.campaignsProposed} synced=${s.pending.synced} completed=${s.pending.completed} retried=${s.pending.retried} judged=${s.pending.judged} undoProposed=${s.pending.undoProposed} skipped=${s.skipped.length} pruned=${s.pruned}`
}
