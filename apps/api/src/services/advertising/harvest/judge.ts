/**
 * HARVEST ENGINE — the judgement of EVERY harvest (a person's, Claude's, a rule's; the brain judges its own in its run,
 * brain/harvest-run.ts), after the attribution window + 72 hours (brain/harvest.ts judgeHarvest, the same maths):
 * Better (KEPT) · Worse · Too early (WAITING). Writes only the verdict on the record — nothing at Amazon, and no undo is
 * asked for: a person's worse harvest is shown on the page with its one-click Undo. The brain's daily harvest run calls
 * it (jobs/ads-brain-harvest.job.ts → runHarvestOnce), whatever the brain has enrolled.
 */
import { Prisma } from '@nexus/database'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { settledEnd } from '../ads-settled-window.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { judgeHarvest, type HarvestEvidence } from '../brain/harvest.js'
import { termKey } from '../brain/terms.js'

const DAY = 86_400_000
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
const words = (s: string) => ` ${termKey(s)} `

/** The keyword's own record in its destination since it landed (settled days only); a PHRASE keyword: the searches that hold it. */
export async function postEvidenceOf(r: { term: string; match: string; destAdGroupId: string | null; landedAt: Date }, now: Date) {
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
      const q = termKey(row.query)
      const hit = r.match === 'PHRASE' ? words(q).includes(words(r.term)) : q === r.term
      if (!hit) continue
      post.impressions += row._sum.impressions ?? 0
      post.clicks += row._sum.clicks ?? 0
      post.orders += row._sum.orders7d ?? 0
      post.salesCents += row._sum.sales7dCents ?? 0
      post.spendCents += Math.round(Number(row._sum.costMicros ?? 0n) / 10_000)
    }
  }
  return { post, settledDays }
}

export interface SinceHarvest { days: number; clicks: number; orders: number; spendCents: number; salesCents: number; acosPct: number | null }

/**
 * S7 — the keyword's OWN numbers in its destination since it landed, for many harvests at once (settled days; the same
 * maths as postEvidenceOf, which the judge uses for Better / Worse): one read per destination ad group. Null for a
 * harvest that never landed.
 */
export async function sinceHarvestMany(records: ReadonlyArray<{ id: string; term: string; match: string; destAdGroupId: string | null; landedAt: Date | null }>, now: Date): Promise<Map<string, SinceHarvest | null>> {
  const out = new Map<string, SinceHarvest | null>()
  const landed = records.filter((r) => r.landedAt && r.destAdGroupId)
  for (const r of records) if (!r.landedAt || !r.destAdGroupId) out.set(r.id, null)
  if (!landed.length) return out
  const until = settledEnd('SPONSORED_PRODUCTS', { now }).until
  const groupIds = [...new Set(landed.map((r) => r.destAdGroupId!))]
  const groups = new Map((await prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, externalAdGroupId: true, campaign: { select: { externalCampaignId: true } } } })).map((g) => [g.id, g]))
  for (const gid of groupIds) {
    const mine = landed.filter((r) => r.destAdGroupId === gid)
    const sinceOf = (r: (typeof mine)[number]) => new Date(startOfUtcDay(r.landedAt!).getTime() + DAY)
    const from = new Date(Math.min(...mine.map((r) => sinceOf(r).getTime())))
    const g = groups.get(gid)
    const rows = g?.externalAdGroupId && g.campaign?.externalCampaignId && from <= until
      ? await prisma.amazonAdsSearchTerm.groupBy({
        by: ['query', 'date'],
        where: { campaignId: g.campaign.externalCampaignId, adGroupId: g.externalAdGroupId, date: { gte: from, lte: until } },
        _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
      })
      : []
    for (const r of mine) {
      const since = sinceOf(r)
      const days = Math.max(0, Math.floor((startOfUtcDay(until).getTime() - since.getTime()) / DAY) + 1)
      const n = { clicks: 0, orders: 0, spendCents: 0, salesCents: 0 }
      for (const row of rows) {
        if (row.date < since) continue
        const q = termKey(row.query)
        if (!(r.match === 'PHRASE' ? words(q).includes(words(r.term)) : q === r.term)) continue
        n.clicks += row._sum.clicks ?? 0
        n.orders += row._sum.orders7d ?? 0
        n.salesCents += row._sum.sales7dCents ?? 0
        n.spendCents += Math.round(Number(row._sum.costMicros ?? 0n) / 10_000)
      }
      out.set(r.id, { days, ...n, acosPct: n.salesCents > 0 ? Math.round((n.spendCents / n.salesCents) * 1000) / 10 : null })
    }
  }
  return out
}

/** The band top for a product in a market (the strategy's ACoS band high, else its target), a fraction; null when none. */
async function bandTopOf(market: string, productId: string, views: Map<string, Awaited<ReturnType<typeof openStrategy>>>): Promise<number | null> {
  let view = views.get(market)
  if (!view) { view = await openStrategy(market); views.set(market, view) }
  const e = await view.forProducts([productId])
  const t = e.resolved.fields.get('target')?.value as { targetKind?: unknown; targetHiPct?: unknown } | undefined
  if (t?.targetKind === 'ACOS' && typeof t.targetHiPct === 'number' && t.targetHiPct > 0) return t.targetHiPct / 100
  const pct = e.values.targetAcosPct
  return pct != null && pct > 0 ? pct / 100 : null
}

/** Judge every non-brain harvest whose time has come (window + 72 h). Returns how many were judged. */
export async function judgeDueHarvests(now: Date = new Date(), opts: { limit?: number } = {}): Promise<{ judged: number; better: number; worse: number; waiting: number }> {
  const due = await prisma.adsBrainHarvest.findMany({
    where: { actorKind: { not: 'BRAIN' }, status: { in: ['DONE', 'HALF_DONE'] }, landedAt: { not: null }, judgeAfter: { lte: now }, OR: [{ verdict: null }, { verdict: 'WAITING' }] },
    select: { id: true, productId: true, marketplace: true, term: true, match: true, destAdGroupId: true, landedAt: true, evidence: true, judgement: true },
    orderBy: { judgeAfter: 'asc' }, take: opts.limit ?? 500,
  })
  const out = { judged: 0, better: 0, worse: 0, waiting: 0 }
  const views = new Map<string, Awaited<ReturnType<typeof openStrategy>>>()
  for (const r of due) {
    try {
      const { post, settledDays } = await postEvidenceOf({ term: r.term, match: r.match, destAdGroupId: r.destAdGroupId, landedAt: r.landedAt! }, now)
      const ev = (r.evidence ?? {}) as Partial<HarvestEvidence> & { harvestedOn?: Partial<HarvestEvidence> }
      const pre = ev.harvestedOn ?? ev
      const j = judgeHarvest({
        landedAt: r.landedAt!, now, settledDays, post, bandTop: await bandTopOf(r.marketplace, r.productId, views),
        pre: { clicks: pre.clicks ?? 0, orders: pre.orders ?? 0, spendCents: pre.money?.spendCents ?? 0, salesCents: pre.money?.salesCents ?? 0, cr: pre.cr ?? 0 },
      })
      await prisma.adsBrainHarvest.update({ where: { id: r.id }, data: { verdict: j.verdict, judgedAt: now, judgement: { why: j.why, final: j.final, numbers: j.numbers } as unknown as Prisma.InputJsonValue } })
      out.judged++
      if (j.verdict === 'KEPT') out.better++
      else if (j.verdict === 'WORSE') out.worse++
      else out.waiting++
    } catch (e) {
      logger.warn('[harvest-engine] judge failed', { harvestId: r.id, error: String(e).slice(0, 200) })
    }
  }
  return out
}
