/**
 * AME.15-17 — Campaign launcher + keyword-graduation funnel.
 *
 * Launch (AME.15): one action builds the canonical per-product structure — an
 * Auto (discovery) campaign + a Manual campaign with Exact / Phrase / Broad ad
 * groups, all advertising the product.
 *
 * Funnel (AME.16): winning search terms graduate Auto/Broad → Exact (the
 * existing harvest funnel). Then cross-match NEGATION stops the levels from
 * cannibalising each other — every Exact keyword becomes a negative-exact in the
 * Phrase / Broad / Auto ad groups, and every Phrase keyword a negative-phrase in
 * the Broad / Auto ad groups. Traffic flows to the most specific match that owns
 * the term (exactly the operator's ask).
 *
 * State (AME.17): per-keyword journey across match types for the funnel UI.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { createCampaignLocal, createAdGroupLocal, createProductAdLocal, createKeywordLocal } from './ads-create.service.js'
import { createNegative } from './ads-negative-kw.service.js'
import type { AdsRegion } from './ads-api-client.js'

type MatchRole = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT'

export interface LaunchInput { productId: string; marketplace: string; dailyBudgetEur?: number; defaultBidEur?: number; keywords?: string[]; userId?: string }

export async function launchProductFunnel(input: LaunchInput): Promise<{ autoCampaignId: string; manualCampaignId: string; adGroups: Record<string, string> }> {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true, amazonAsin: true, name: true } })
  if (!product) throw new Error('product not found')
  const budget = input.dailyBudgetEur ?? 10
  const bid = input.defaultBidEur ?? 0.5
  const base = (product.name || product.sku || product.id).slice(0, 56)
  const ad = { sku: product.sku ?? undefined, asin: product.amazonAsin ?? undefined, productId: product.id, userId: input.userId }

  const autoCamp = await createCampaignLocal({ name: `${base} — Auto`, type: 'SP', marketplace: input.marketplace, targetingType: 'AUTO', dailyBudgetEur: budget, userId: input.userId })
  const autoAg = await createAdGroupLocal({ campaignId: autoCamp.id, name: `${base} — Auto`, defaultBidEur: bid, userId: input.userId })
  await createProductAdLocal({ adGroupId: autoAg.id, ...ad })

  const manualCamp = await createCampaignLocal({ name: `${base} — Manual`, type: 'SP', marketplace: input.marketplace, targetingType: 'MANUAL', dailyBudgetEur: budget, userId: input.userId })
  const adGroups: Record<string, string> = { AUTO: autoAg.id }
  for (const role of ['EXACT', 'PHRASE', 'BROAD'] as const) {
    const ag = await createAdGroupLocal({ campaignId: manualCamp.id, name: `${base} — ${role}`, defaultBidEur: bid, userId: input.userId })
    await createProductAdLocal({ adGroupId: ag.id, ...ad })
    adGroups[role] = ag.id
    for (const kw of input.keywords ?? []) {
      await createKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: role, bidEur: bid, userId: input.userId })
    }
  }
  logger.info('[AME.15] launched product funnel', { productId: product.id, autoCampaignId: autoCamp.id, manualCampaignId: manualCamp.id })
  return { autoCampaignId: autoCamp.id, manualCampaignId: manualCamp.id, adGroups }
}

// Classify an ad group's match role by its name suffix, falling back to the
// majority of its positive keyword targets' expression types.
function roleOf(name: string, targets: Array<{ expressionType: string; isNegative: boolean }>): MatchRole | null {
  const n = (name || '').toUpperCase()
  if (n.includes('AUTO')) return 'AUTO'
  if (n.includes('EXACT')) return 'EXACT'
  if (n.includes('PHRASE')) return 'PHRASE'
  if (n.includes('BROAD')) return 'BROAD'
  const counts: Record<string, number> = {}
  for (const t of targets) { if (t.isNegative) continue; const e = t.expressionType.toUpperCase(); counts[e] = (counts[e] ?? 0) + 1 }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  return top === 'EXACT' || top === 'PHRASE' || top === 'BROAD' ? top : null
}

async function gatherProductAdGroups(productId: string) {
  const childRows = await prisma.product.findMany({ where: { parentId: productId }, select: { id: true } })
  const productIds = [...new Set([productId, ...childRows.map((c) => c.id)])]
  const ads = await prisma.adProductAd.findMany({ where: { productId: { in: productIds } }, select: { adGroupId: true } })
  const adGroupIds = [...new Set(ads.map((a) => a.adGroupId))]
  if (adGroupIds.length === 0) return []
  return prisma.adGroup.findMany({
    where: { id: { in: adGroupIds } },
    select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } }, targets: { select: { expressionType: true, expressionValue: true, isNegative: true } } },
  })
}

export interface NegationProposal { keywordText: string; matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'; adGroupId: string; adGroupName: string; role: MatchRole; reason: string }

/** Cross-match negation plan (AME.16). Returns proposals; apply=true writes them. */
export async function crossMatchNegations(productId: string, apply = false, userId?: string): Promise<{ proposals: NegationProposal[]; applied: number; errors: string[] }> {
  const adGroups = await gatherProductAdGroups(productId)
  const classified = adGroups.map((ag) => ({ ag, role: roleOf(ag.name, ag.targets) }))

  const exactKws = new Set<string>()
  const phraseKws = new Set<string>()
  for (const { ag, role } of classified) {
    for (const t of ag.targets) {
      if (t.isNegative) continue
      const v = t.expressionValue.toLowerCase()
      const et = t.expressionType.toUpperCase()
      if (et === 'EXACT' || role === 'EXACT') exactKws.add(v)
      if (et === 'PHRASE' || role === 'PHRASE') phraseKws.add(v)
    }
  }
  const existingNeg = new Map<string, Set<string>>()
  for (const ag of adGroups) {
    const s = new Set<string>()
    for (const t of ag.targets) if (t.isNegative) s.add(`${t.expressionType.toUpperCase()}:${t.expressionValue.toLowerCase()}`)
    existingNeg.set(ag.id, s)
  }

  const proposals: NegationProposal[] = []
  for (const { ag, role } of classified) {
    if (!role) continue
    const neg = existingNeg.get(ag.id)!
    if (role !== 'EXACT') for (const kw of exactKws) {
      if (!neg.has(`NEGATIVE_EXACT:${kw}`)) proposals.push({ keywordText: kw, matchType: 'NEGATIVE_EXACT', adGroupId: ag.id, adGroupName: ag.name, role, reason: `Exact keyword owned by the Exact ad group — negate in ${role}` })
    }
    if (role === 'AUTO' || role === 'BROAD') for (const kw of phraseKws) {
      if (!neg.has(`NEGATIVE_PHRASE:${kw}`)) proposals.push({ keywordText: kw, matchType: 'NEGATIVE_PHRASE', adGroupId: ag.id, adGroupName: ag.name, role, reason: `Phrase keyword owned by the Phrase ad group — negate in ${role}` })
    }
  }

  let applied = 0
  const errors: string[] = []
  if (apply && proposals.length) {
    const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true, profileId: true, region: true } })
    const connByMkt = new Map(conns.map((c) => [c.marketplace, c]))
    const agById = new Map(adGroups.map((a) => [a.id, a]))
    for (const p of proposals) {
      const ag = agById.get(p.adGroupId)
      const mkt = ag?.campaign?.marketplace
      const conn = mkt ? connByMkt.get(mkt) : undefined
      if (!ag?.externalAdGroupId || !ag.campaign?.externalCampaignId || !conn || !mkt) {
        errors.push(`${p.keywordText}@${p.adGroupName}: not yet synced to Amazon (no external id)`) ; continue
      }
      try {
        await createNegative({
          profileId: conn.profileId,
          region: (conn.region === 'NA' || conn.region === 'FE' ? conn.region : 'EU') as AdsRegion,
          externalCampaignId: ag.campaign.externalCampaignId,
          externalAdGroupId: ag.externalAdGroupId,
          keywordText: p.keywordText, matchType: p.matchType, scope: 'AD_GROUP', marketplace: mkt,
        })
        applied += 1
      } catch (e) { errors.push(`${p.keywordText}@${p.adGroupName}: ${(e as Error).message}`) }
    }
    logger.info('[AME.16] cross-match negations applied', { productId, applied, errors: errors.length })
  }
  return { proposals, applied, errors }
}

/** Per-keyword funnel journey across match types + ad-group breakdown (AME.17). */
export async function getFunnelState(productId: string): Promise<{
  adGroups: Array<{ id: string; name: string; role: MatchRole | null; positives: Array<{ kw: string; match: string }>; negatives: Array<{ kw: string; match: string }> }>
  journey: Array<{ keyword: string; matchTypes: string[]; negatedIn: number }>
}> {
  const adGroups = await gatherProductAdGroups(productId)
  const classified = adGroups.map((ag) => ({
    id: ag.id, name: ag.name, role: roleOf(ag.name, ag.targets),
    positives: ag.targets.filter((t) => !t.isNegative).map((t) => ({ kw: t.expressionValue, match: t.expressionType })),
    negatives: ag.targets.filter((t) => t.isNegative).map((t) => ({ kw: t.expressionValue, match: t.expressionType })),
  }))
  const present = new Map<string, Set<string>>()
  const negated = new Map<string, number>()
  for (const c of classified) {
    for (const p of c.positives) { const k = p.kw.toLowerCase(); const s = present.get(k) ?? new Set(); s.add(p.match.toUpperCase()); present.set(k, s) }
    for (const nkw of c.negatives) { const k = nkw.kw.toLowerCase(); negated.set(k, (negated.get(k) ?? 0) + 1) }
  }
  const journey = [...present.entries()].map(([keyword, roles]) => ({ keyword, matchTypes: [...roles], negatedIn: negated.get(keyword) ?? 0 }))
  return { adGroups: classified, journey }
}
