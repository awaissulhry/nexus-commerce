/**
 * AX2.4 — Structure Blueprints, DB adapter.
 *
 * Loads live campaigns into the pure `ads-core/ads-blueprint` shape, extracts a
 * parameterised structure, and stores/diffs it. READ SIDE ONLY — nothing in
 * this file writes to Amazon or creates any ad entity. The write side (applying
 * a blueprint to a new product) is AX2.5 and is deliberately not built yet,
 * because it must first pass a self-competition gate over `doc.sharedTargets`.
 */

import prisma from '../../db.js'
import {
  extractBlueprint, diffBlueprint,
  type BlueprintDoc, type BlueprintDiff, type SourceCampaign,
} from '../ads-core/ads-blueprint.js'

export interface CampaignSelector {
  campaignIds?: string[]
  namePrefix?: string
  marketplace?: string
  /**
   * AX3.1 — every campaign in an Amazon Ads portfolio. Membership is Amazon's,
   * synced onto Campaign.portfolioId by ads-portfolio.service.
   */
  portfolioId?: string
  /**
   * AX3.1 — narrow to specific ad groups. The parent campaigns are still
   * replicated (Amazon has no ad group without a campaign) but carry only these
   * ad groups. Combines with any of the selectors above; on its own it resolves
   * the parents itself.
   */
  adGroupIds?: string[]
}

/** Resolve a selector to the live campaigns, in name order. */
export async function loadSourceCampaigns(sel: CampaignSelector): Promise<{ campaigns: SourceCampaign[]; ids: string[]; marketplace: string | null }> {
  const where: Record<string, unknown> = {}
  // An explicit ad-group selection resolves its own parents, so a caller can
  // hand-pick ad groups without also naming their campaigns.
  let campaignIds = sel.campaignIds
  if (!campaignIds?.length && sel.adGroupIds?.length) {
    const parents = await prisma.adGroup.findMany({ where: { id: { in: sel.adGroupIds } }, select: { campaignId: true } })
    campaignIds = [...new Set(parents.map((p) => p.campaignId))]
    if (!campaignIds.length) throw new Error('no campaigns own the selected ad groups')
  }
  if (campaignIds?.length) where.id = { in: campaignIds }
  else if (sel.portfolioId) where.portfolioId = sel.portfolioId
  else if (sel.namePrefix) where.name = { startsWith: sel.namePrefix }
  else throw new Error('select campaigns by campaignIds, adGroupIds, portfolioId or namePrefix')
  if (sel.marketplace) where.marketplace = sel.marketplace

  const rows = await prisma.campaign.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, marketplace: true, dailyBudget: true, biddingStrategy: true, dynamicBidding: true,
      // AX3.0 — Amazon's real targeting type. Without it every replica was created
      // MANUAL, so an Auto campaign came back as a manual campaign with no targets.
      targetingType: true,
      adGroups: {
        // AX3.1 — an ad-group selection narrows what each campaign carries.
        ...(sel.adGroupIds?.length ? { where: { id: { in: sel.adGroupIds } } } : {}),
        select: {
          id: true, name: true, defaultBidCents: true,
          // AX3.1 — orphaned targets are deliberately INCLUDED.
          //
          // `orphanedAt` means Amazon answered entityNotFoundError when we tried
          // to update THAT row's external id (AX2.0): the entity was deleted on
          // Amazon's side. That is a fact about the source row, not about whether
          // the same target can be created for a different product — replication
          // calls create, not update, so there is no dead id to re-push.
          //
          // Filtering them looks tidy and is wrong. All four auto clauses on
          // IT-AIREON-SP-Auto — the template this whole feature was built from —
          // are orphaned, so excluding them would replicate an Auto campaign with
          // no targeting at all, which is precisely the defect AX3.0 fixed.
          targets: { select: { kind: true, expressionType: true, expressionValue: true, bidCents: true, isNegative: true, negativeLevel: true, orphanedAt: true } },
          productAds: { select: { asin: true } },
        },
      },
    },
  })

  // A campaign whose every ad group was filtered out is not part of the source.
  const kept = sel.adGroupIds?.length ? rows.filter((c) => c.adGroups.length > 0) : rows

  const campaigns: SourceCampaign[] = kept.map((c) => ({
    name: c.name,
    dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null,
    biddingStrategy: c.biddingStrategy ?? null,
    targetingType: c.targetingType ?? null,
    placementBidding: (((c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding) ?? [],
    adGroups: c.adGroups.map((g) => ({
      name: g.name,
      defaultBidCents: g.defaultBidCents ?? null,
      targets: g.targets.map((t) => ({
        kind: t.kind, expressionType: t.expressionType, expressionValue: t.expressionValue,
        bidCents: t.bidCents ?? null, isNegative: t.isNegative, negativeLevel: t.negativeLevel ?? null,
        orphaned: t.orphanedAt != null,
      })),
      asins: g.productAds.map((a) => a.asin).filter((a): a is string => !!a),
    })),
  }))

  return { campaigns, ids: kept.map((r) => r.id), marketplace: kept[0]?.marketplace ?? null }
}

/**
 * AX3.1 — the source tree the picker renders: portfolios, their campaigns, and
 * each campaign's ad groups, with the counts that let an operator judge a source
 * before selecting it.
 *
 * Unportfolio'd campaigns are returned under a synthetic `null` portfolio rather
 * than omitted. They are not an edge case: 128 of 190 live campaigns have no
 * portfolio, including every one of the product-targeting structures.
 */
export interface SourceTreeAdGroup { id: string; name: string; positives: number; negatives: number; productAds: number }
export interface SourceTreeCampaign {
  id: string; name: string; marketplace: string | null; targetingType: string | null
  dailyBudget: number | null; adProduct: string | null
  positives: number; negatives: number; productAds: number
  adGroups: SourceTreeAdGroup[]
}
export interface SourceTreePortfolio {
  portfolioId: string | null; name: string
  campaigns: SourceTreeCampaign[]
  dailyBudgetTotal: number
}

export async function loadSourceTree(opts: { marketplace?: string | null } = {}): Promise<{ portfolios: SourceTreePortfolio[] }> {
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null
  const [campaigns, portfolios] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: { not: 'ARCHIVED' }, ...(mk ? { marketplace: mk } : {}) },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, marketplace: true, portfolioId: true, targetingType: true, dailyBudget: true, adProduct: true,
        adGroups: {
          select: {
            id: true, name: true,
            // Counts must match what a replication would CREATE, and replication
            // includes orphaned targets on purpose (see loadSourceCampaigns).
            // Filtering here made IT-AIREON-SP-Auto read "0 targets" in the
            // picker while the plan created its four auto clauses.
            targets: { select: { isNegative: true } },
            _count: { select: { productAds: true } },
          },
        },
      },
    }),
    prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } }),
  ])
  const pfName = new Map(portfolios.map((p) => [p.externalPortfolioId, p.name]))

  const byPf = new Map<string | null, SourceTreeCampaign[]>()
  for (const c of campaigns) {
    const adGroups: SourceTreeAdGroup[] = c.adGroups.map((g) => ({
      id: g.id, name: g.name,
      positives: g.targets.filter((t) => !t.isNegative).length,
      negatives: g.targets.filter((t) => t.isNegative).length,
      productAds: g._count.productAds,
    }))
    const row: SourceTreeCampaign = {
      id: c.id, name: c.name, marketplace: c.marketplace, targetingType: c.targetingType,
      dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null, adProduct: c.adProduct,
      positives: adGroups.reduce((n, g) => n + g.positives, 0),
      negatives: adGroups.reduce((n, g) => n + g.negatives, 0),
      productAds: adGroups.reduce((n, g) => n + g.productAds, 0),
      adGroups,
    }
    const key = c.portfolioId ?? null
    const list = byPf.get(key) ?? []
    list.push(row)
    byPf.set(key, list)
  }

  const out: SourceTreePortfolio[] = [...byPf.entries()].map(([portfolioId, camps]) => ({
    portfolioId,
    name: portfolioId ? (pfName.get(portfolioId) ?? `Portfolio ${portfolioId}`) : 'No portfolio',
    campaigns: camps,
    dailyBudgetTotal: camps.reduce((n, c) => n + (c.dailyBudget ?? 0), 0),
  }))
  // Real portfolios first, biggest first; the unportfolio'd bucket last.
  out.sort((a, b) => {
    if ((a.portfolioId === null) !== (b.portfolioId === null)) return a.portfolioId === null ? 1 : -1
    return b.campaigns.length - a.campaigns.length || a.name.localeCompare(b.name)
  })
  return { portfolios: out }
}

export interface ExtractRequest extends CampaignSelector {
  productToken: string
  competitorTokens?: string[]
}

export async function previewBlueprint(req: ExtractRequest): Promise<{ doc: BlueprintDoc; sourceCampaignIds: string[]; marketplace: string | null }> {
  const { campaigns, ids, marketplace } = await loadSourceCampaigns(req)
  if (!campaigns.length) throw new Error('no campaigns matched the selector')
  const doc = extractBlueprint(campaigns, { productToken: req.productToken, competitorTokens: req.competitorTokens })
  return { doc, sourceCampaignIds: ids, marketplace }
}

export async function saveBlueprint(req: ExtractRequest & { name: string; description?: string; createdBy?: string }) {
  const { doc, sourceCampaignIds, marketplace } = await previewBlueprint(req)
  return prisma.adBlueprint.create({
    data: {
      name: req.name,
      description: req.description ?? null,
      marketplace: req.marketplace ?? marketplace ?? 'IT',
      productToken: req.productToken,
      competitorTokens: req.competitorTokens ?? [],
      sourceCampaignIds,
      doc: doc as unknown as object,
      createdBy: req.createdBy ?? null,
    },
  })
}

export async function listBlueprints() {
  const rows = await prisma.adBlueprint.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map((r) => {
    const doc = r.doc as unknown as BlueprintDoc
    return {
      id: r.id, name: r.name, description: r.description, marketplace: r.marketplace,
      productToken: r.productToken, createdAt: r.createdAt,
      stats: doc?.stats ?? null,
      sharedTargetCount: doc?.sharedTargets?.length ?? 0,
      roles: (doc?.campaigns ?? []).map((c) => c.role),
    }
  })
}

/** Diff a stored blueprint against another product's live structure. */
export async function diffAgainst(blueprintId: string, sel: CampaignSelector, productToken: string): Promise<BlueprintDiff & { blueprint: string }> {
  const bp = await prisma.adBlueprint.findUnique({ where: { id: blueprintId } })
  if (!bp) throw new Error('blueprint not found')
  const { campaigns } = await loadSourceCampaigns(sel)
  if (!campaigns.length) throw new Error('no campaigns matched the selector')
  const diff = diffBlueprint(bp.doc as unknown as BlueprintDoc, campaigns, productToken)
  return { ...diff, blueprint: bp.name }
}
