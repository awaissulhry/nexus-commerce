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
}

/** Resolve a selector to the live campaigns, in name order. */
export async function loadSourceCampaigns(sel: CampaignSelector): Promise<{ campaigns: SourceCampaign[]; ids: string[]; marketplace: string | null }> {
  const where: Record<string, unknown> = {}
  if (sel.campaignIds?.length) where.id = { in: sel.campaignIds }
  else if (sel.namePrefix) where.name = { startsWith: sel.namePrefix }
  else throw new Error('select campaigns by campaignIds or namePrefix')
  if (sel.marketplace) where.marketplace = sel.marketplace

  const rows = await prisma.campaign.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, marketplace: true, dailyBudget: true, biddingStrategy: true, dynamicBidding: true,
      adGroups: {
        select: {
          name: true, defaultBidCents: true,
          targets: { select: { kind: true, expressionType: true, expressionValue: true, bidCents: true, isNegative: true, negativeLevel: true } },
          productAds: { select: { asin: true } },
        },
      },
    },
  })

  const campaigns: SourceCampaign[] = rows.map((c) => ({
    name: c.name,
    dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null,
    biddingStrategy: c.biddingStrategy ?? null,
    placementBidding: (((c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding) ?? [],
    adGroups: c.adGroups.map((g) => ({
      name: g.name,
      defaultBidCents: g.defaultBidCents ?? null,
      targets: g.targets.map((t) => ({
        kind: t.kind, expressionType: t.expressionType, expressionValue: t.expressionValue,
        bidCents: t.bidCents ?? null, isNegative: t.isNegative, negativeLevel: t.negativeLevel ?? null,
      })),
      asins: g.productAds.map((a) => a.asin).filter((a): a is string => !!a),
    })),
  }))

  return { campaigns, ids: rows.map((r) => r.id), marketplace: rows[0]?.marketplace ?? null }
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
