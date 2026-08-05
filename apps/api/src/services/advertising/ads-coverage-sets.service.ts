/**
 * ACR.3 (Stage 2.1) — coverage sets: the curated keyword intent a family deliberately owns.
 *
 * The scoreboard reports whatever SQP happens to return; the pilot engine needs INTENT — which
 * terms this family is trying to own, which ASIN leads each, and the guardrails the family will
 * not cross. This service is the only writer of KeywordCoverageSet, and the engine will be its
 * only automated reader, so "what is automation trying to do" is answerable from one table.
 *
 * Seeding is evidence-first, never invented: candidate terms come from the family's OWN
 * measured SQP rows (the corrected semantics — market per term counted once, our side summed
 * over family ASINs), and the proposed lead ASIN is the family ASIN that ALREADY takes the
 * most impressions on that term. The operator edits from there; a seed is a draft, so sets are
 * created DISABLED and nothing reads a disabled set.
 */
import prisma from '../../db.js'
import { getCoverageScoreboard, type CoverageRow } from './ads-coverage.service.js'

export interface CoverageSetSummary {
  id: string
  portfolioId: string
  marketplace: string
  name: string
  enabled: boolean
  dailySpendCapCents: number | null
  acosCapPct: number | null
  terms: Array<{
    id: string
    term: string
    leadAsin: string | null
    status: string
    maxCpcCents: number | null
    targetSharePct: number | null
    /** Live evidence, joined at read time so the set never stores stale measurements. */
    marketImpressions: number | null
    ourImpressions: number | null
    share: number | null
    familyKeywords: number | null
  }>
}

/** The family's ASINs + campaign ids — one resolver, matching the cockpit's membership rule. */
async function familyIdentity(portfolioId: string): Promise<{ marketplace: string | null; campaignIds: string[]; asins: string[] }> {
  const campaigns = await prisma.campaign.findMany({
    where: { portfolioId },
    select: { id: true, marketplace: true },
  })
  const campaignIds = campaigns.map((c) => c.id)
  const marketplace = campaigns.find((c) => c.marketplace)?.marketplace ?? null
  const ads = campaignIds.length
    ? await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: { in: campaignIds } }, asin: { not: null } },
      select: { asin: true },
      distinct: ['asin'],
    })
    : []
  return { marketplace, campaignIds, asins: ads.map((a) => a.asin).filter((x): x is string => !!x) }
}

/**
 * Seed (or top up) a family's coverage set from its measured SQP evidence.
 *
 * Idempotent by (set, term): existing terms keep their operator edits — lead reassignments,
 * caps, RETIRED status — and only genuinely new terms are added. Re-seeding after a better
 * SQP week therefore grows the draft without undoing decisions.
 */
export async function seedCoverageSet(args: {
  portfolioId: string
  minMarketImpressions?: number
  createdBy?: string
}): Promise<{ setId: string; created: boolean; termsAdded: number; termsKept: number; unmeasured: boolean }> {
  const minMarket = args.minMarketImpressions ?? 2_000
  const { marketplace, campaignIds, asins } = await familyIdentity(args.portfolioId)
  if (!marketplace) throw new Error('portfolio has no campaigns with a marketplace')

  const portfolio = await prisma.amazonAdsPortfolio.findFirst({
    where: { externalPortfolioId: args.portfolioId },
    select: { name: true },
  })

  let set = await prisma.keywordCoverageSet.findFirst({
    where: { portfolioId: args.portfolioId, marketplace },
  })
  const created = !set
  if (!set) {
    set = await prisma.keywordCoverageSet.create({
      data: {
        portfolioId: args.portfolioId,
        marketplace,
        name: `${portfolio?.name ?? args.portfolioId} — coverage`,
        enabled: false, // a seed is a draft; the engine reads only enabled sets
        createdBy: args.createdBy ?? null,
      },
    })
  }

  // Evidence through the family lens. An unmeasured week seeds nothing — a draft built on
  // zeroed data would put "we are invisible" terms in front of the operator as fact.
  const board = asins.length
    ? await getCoverageScoreboard({ marketplace, asins, campaignIds, limit: 200 })
    : null
  if (!board || !board.measured) {
    return { setId: set.id, created, termsAdded: 0, termsKept: 0, unmeasured: true }
  }

  const existing = await prisma.keywordCoverageTerm.findMany({
    where: { setId: set.id },
    select: { term: true },
  })
  const have = new Set(existing.map((t) => t.term))

  // Proposed lead per term = the family ASIN already taking the most impressions on it.
  const week = board.week
  const leadRows = week ? await prisma.$queryRawUnsafe<{ term: string; asin: string }[]>(`
    SELECT DISTINCT ON (LOWER("searchQuery")) LOWER("searchQuery") AS term, asin
    FROM "SearchQueryPerformance"
    WHERE marketplace = $1 AND "startDate" = $2::date
      AND asin IN (${asins.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})
      AND "impressionsBrand" > 0
    ORDER BY LOWER("searchQuery"), "impressionsBrand" DESC
  `, marketplace, week) : []
  const leadByTerm = new Map(leadRows.map((r) => [r.term, r.asin]))

  let added = 0
  for (const row of board.rows) {
    if (row.marketImpressions < minMarket) continue
    if (have.has(row.term)) continue
    await prisma.keywordCoverageTerm.create({
      data: {
        setId: set.id,
        term: row.term,
        leadAsin: leadByTerm.get(row.term) ?? null,
        status: 'ACTIVE',
      },
    })
    added += 1
  }
  return { setId: set.id, created, termsAdded: added, termsKept: have.size, unmeasured: false }
}

/** The set with live evidence joined per term — the read the cockpit section renders. */
export async function getCoverageSet(portfolioId: string): Promise<CoverageSetSummary | null> {
  const set = await prisma.keywordCoverageSet.findFirst({
    where: { portfolioId },
    include: { terms: { orderBy: { term: 'asc' } } },
  })
  if (!set) return null
  const { marketplace, campaignIds, asins } = await familyIdentity(portfolioId)
  const board = marketplace && asins.length
    ? await getCoverageScoreboard({ marketplace, asins, campaignIds, limit: 500 }).catch(() => null)
    : null
  const byTerm = new Map<string, CoverageRow>((board?.rows ?? []).map((r) => [r.term, r]))
  return {
    id: set.id,
    portfolioId: set.portfolioId,
    marketplace: set.marketplace,
    name: set.name,
    enabled: set.enabled,
    dailySpendCapCents: set.dailySpendCapCents,
    acosCapPct: set.acosCapPct != null ? Number(set.acosCapPct) : null,
    terms: set.terms.map((t) => {
      const ev = byTerm.get(t.term)
      return {
        id: t.id,
        term: t.term,
        leadAsin: t.leadAsin,
        status: t.status,
        maxCpcCents: t.maxCpcCents,
        targetSharePct: t.targetSharePct != null ? Number(t.targetSharePct) : null,
        marketImpressions: ev?.marketImpressions ?? null,
        ourImpressions: ev?.ourImpressions ?? null,
        share: ev?.share ?? null,
        familyKeywords: ev?.targets ?? null,
      }
    }),
  }
}

export async function updateCoverageSet(args: {
  setId: string
  patch: { enabled?: boolean; dailySpendCapCents?: number | null; acosCapPct?: number | null; name?: string }
}): Promise<void> {
  await prisma.keywordCoverageSet.update({
    where: { id: args.setId },
    data: {
      ...(args.patch.enabled != null ? { enabled: args.patch.enabled } : {}),
      ...(args.patch.dailySpendCapCents !== undefined ? { dailySpendCapCents: args.patch.dailySpendCapCents } : {}),
      ...(args.patch.acosCapPct !== undefined ? { acosCapPct: args.patch.acosCapPct } : {}),
      ...(args.patch.name ? { name: args.patch.name } : {}),
    },
  })
}

export async function updateCoverageTerm(args: {
  termId: string
  patch: { leadAsin?: string | null; status?: 'ACTIVE' | 'PAUSED' | 'RETIRED'; maxCpcCents?: number | null; targetSharePct?: number | null }
}): Promise<void> {
  await prisma.keywordCoverageTerm.update({
    where: { id: args.termId },
    data: {
      ...(args.patch.leadAsin !== undefined ? { leadAsin: args.patch.leadAsin } : {}),
      ...(args.patch.status ? { status: args.patch.status } : {}),
      ...(args.patch.maxCpcCents !== undefined ? { maxCpcCents: args.patch.maxCpcCents } : {}),
      ...(args.patch.targetSharePct !== undefined ? { targetSharePct: args.patch.targetSharePct } : {}),
    },
  })
}
