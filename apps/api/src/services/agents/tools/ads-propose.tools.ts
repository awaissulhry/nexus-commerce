/**
 * NAF.C — the fleet's PROPOSE-tier ads tools (plan C-D1). All three are
 * PREVIEW-ONLY: `handler` is a deterministic dry-run built from the same
 * checks the write path enforces (protected terms, authority pins,
 * isNegative-only existing-negative reads), and there is deliberately NO
 * `execute` — an approved item records the operator's decision (and mints
 * the Phase E exemplar) but cannot reach Amazon until Phase F adds
 * executors behind its own gate. Hard denials return ok:false so the
 * approval gate never even queues them.
 *
 * The protected-terms check replicates ads-write-gate.ts:304-337 exactly
 * (WHITELIST rows, normaliseTerm both sides); it is not re-invented.
 */
import prisma from '../../../db.js'
import { pinDenial } from '../../advertising/ads-authority-pins.js'
import { normaliseTerm } from '../../advertising/ads-write-gate.js'
import type { AgentTool } from '../tool-types.js'

const BID_FLOOR_CENTS = 5
const METRIC_WINDOW_DAYS = 60

interface CampaignRow {
  id: string
  name: string
  marketplace: string | null
  pinPlacement: boolean
  pinBids: boolean
  pinBudget: boolean
  pinNote: string | null
}

async function campaignByExternalId(externalCampaignId: string): Promise<CampaignRow | null> {
  return prisma.campaign.findFirst({
    where: { externalCampaignId },
    select: {
      id: true,
      name: true,
      marketplace: true,
      pinPlacement: true,
      pinBids: true,
      pinBudget: true,
      pinNote: true,
    },
  }) as Promise<CampaignRow | null>
}

async function termMetrics(query: string, externalCampaignId: string) {
  const since = new Date(Date.now() - METRIC_WINDOW_DAYS * 24 * 3600_000)
  const agg = await prisma.amazonAdsSearchTerm.aggregate({
    where: { query, campaignId: externalCampaignId, date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true },
  })
  const costCents = Number(agg._sum.costMicros ?? 0n) / 10000
  return {
    windowDays: METRIC_WINDOW_DAYS,
    impressions: agg._sum.impressions ?? 0,
    clicks: agg._sum.clicks ?? 0,
    costCents: Math.round(costCents),
    orders: agg._sum.orders7d ?? 0,
  }
}

/** ads-write-gate.ts:304-337 verbatim semantics. Returns the denial
 *  string or null. Only meaningful for negations. */
async function protectedTermDenial(
  keywordText: string,
  marketplace: string | null,
  campaignId: string | null,
): Promise<string | null> {
  const rows = await prisma.adKeywordProtection.findMany({
    where: {
      mode: 'WHITELIST',
      AND: [
        { OR: [{ marketplace: null }, { marketplace: marketplace ?? undefined }] },
        { OR: [{ campaignId: null }, { campaignId: campaignId ?? undefined }] },
      ],
    },
    select: { term: true, isPrefix: true, matchType: true, reason: true },
  })
  const term = normaliseTerm(keywordText)
  for (const p of rows) {
    const t = normaliseTerm(p.term)
    const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
    const hit =
      mode === 'CONTAINS' ? term.includes(t) : mode === 'PREFIX' ? term.startsWith(t) : term === t
    if (hit) return `"${term}" is whitelisted against negation (${p.reason ?? 'protected'})`
  }
  return null
}

const createNegativeKeyword: AgentTool = {
  name: 'create-negative-keyword',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  description:
    'Propose a negative keyword (campaign or ad-group scope). Preview-only in Phase C: approval records the decision; no Amazon write exists until Phase F.',
  async handler(args) {
    const externalCampaignId = String(args.externalCampaignId ?? '')
    const keywordText = String(args.keywordText ?? '').trim()
    const matchType = String(args.matchType ?? 'NEGATIVE_EXACT')
    const scope = String(args.scope ?? 'AD_GROUP')
    if (!externalCampaignId || !keywordText) {
      return { ok: false, error: 'externalCampaignId and keywordText are required' }
    }
    const campaign = await campaignByExternalId(externalCampaignId)
    if (!campaign) return { ok: false, error: `campaign ${externalCampaignId} not found` }

    // Existing negatives via the isNegative boolean ONLY — 1,068 prod
    // negatives carry expressionType='EXACT' (the known trap).
    const existing = await prisma.adTarget.findMany({
      where: {
        isNegative: true,
        expressionValue: { equals: keywordText, mode: 'insensitive' },
        adGroup: { campaign: { externalCampaignId } },
      },
      select: { expressionValue: true, negativeLevel: true },
      take: 5,
    })
    if (existing.length > 0) {
      return {
        ok: false,
        error: `"${keywordText}" is already negated in this campaign (${existing[0]!.negativeLevel ?? 'unknown level'})`,
      }
    }

    const denial = await protectedTermDenial(keywordText, campaign.marketplace, campaign.id)
    if (denial) return { ok: false, error: denial }

    const metrics = await termMetrics(keywordText, externalCampaignId)
    return {
      ok: true,
      preview: {
        action: 'create-negative-keyword',
        term: keywordText,
        matchType,
        scope,
        campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
        externalAdGroupId: args.externalAdGroupId ?? null,
        metrics,
        alreadyNegated: false,
        protectedDenial: null,
        effect: `Stops "${keywordText}" from matching in ${campaign.name}; spend on it (last ${metrics.windowDays}d) was €${(metrics.costCents / 100).toFixed(2)} with ${metrics.orders} orders.`,
      },
    }
  },
}

const graduateKeyword: AgentTool = {
  name: 'graduate-keyword',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  description:
    'Propose promoting a proven search term to an exact-match keyword. Preview-only in Phase C.',
  async handler(args) {
    const query = String(args.query ?? '').trim()
    const sourceExternalCampaignId = String(args.sourceExternalCampaignId ?? '')
    if (!query || !sourceExternalCampaignId) {
      return { ok: false, error: 'query and sourceExternalCampaignId are required' }
    }
    const destExternalCampaignId = String(
      args.destExternalCampaignId ?? sourceExternalCampaignId,
    )
    const campaign = await campaignByExternalId(destExternalCampaignId)
    if (!campaign) return { ok: false, error: `campaign ${destExternalCampaignId} not found` }

    // Creating a keyword sets a bid — the bids pin governs.
    const denial = pinDenial(campaign, { dimensions: ['bids'] })
    if (denial) {
      return {
        ok: false,
        error: `authority pin: ${denial.reason}${campaign.pinNote ? ` (${campaign.pinNote})` : ''}`,
      }
    }

    const existing = await prisma.adTarget.findMany({
      where: {
        isNegative: false,
        kind: 'KEYWORD',
        expressionType: 'EXACT',
        expressionValue: { equals: query, mode: 'insensitive' },
        adGroup: { campaign: { externalCampaignId: destExternalCampaignId } },
      },
      select: { expressionValue: true },
      take: 1,
    })
    if (existing.length > 0) {
      return { ok: false, error: `an EXACT keyword for "${query}" already exists in the destination campaign` }
    }

    const metrics = await termMetrics(query, sourceExternalCampaignId)
    // The applyHarvest bid formula: observed CPC, floored (cents).
    const suggestedBidCents =
      args.bidCents != null && Number.isFinite(Number(args.bidCents))
        ? Math.max(BID_FLOOR_CENTS, Math.round(Number(args.bidCents)))
        : metrics.clicks > 0
          ? Math.max(BID_FLOOR_CENTS, Math.round(metrics.costCents / metrics.clicks))
          : 50
    return {
      ok: true,
      preview: {
        action: 'graduate-keyword',
        query,
        destination: { id: campaign.id, name: campaign.name },
        suggestedBidCents,
        metrics,
        alreadyExact: false,
        effect: `Creates an EXACT keyword "${query}" at €${(suggestedBidCents / 100).toFixed(2)} in ${campaign.name}; the term produced ${metrics.orders} orders on €${(metrics.costCents / 100).toFixed(2)} spend (last ${metrics.windowDays}d).`,
      },
    }
  },
}

const setTargetBid: AgentTool = {
  name: 'set-target-bid',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  description:
    'Propose a bid change on a keyword/target. Preview-only in Phase C.',
  async handler(args) {
    const targetId = String(args.targetId ?? '')
    const proposedBidCents = Math.round(Number(args.proposedBidCents))
    if (!targetId || !Number.isFinite(proposedBidCents)) {
      return { ok: false, error: 'targetId and numeric proposedBidCents are required' }
    }
    if (proposedBidCents < BID_FLOOR_CENTS) {
      return { ok: false, error: `proposed bid ${proposedBidCents}c is below the ${BID_FLOOR_CENTS}c floor` }
    }
    const target = await prisma.adTarget.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        expressionValue: true,
        expressionType: true,
        bidCents: true,
        isNegative: true,
        adGroup: {
          select: {
            campaign: {
              select: {
                id: true,
                name: true,
                pinPlacement: true,
                pinBids: true,
                pinBudget: true,
                pinNote: true,
              },
            },
          },
        },
      },
    })
    if (!target || target.isNegative) {
      return { ok: false, error: `target ${targetId} not found (or is a negative)` }
    }
    const campaign = target.adGroup.campaign
    const denial = pinDenial(campaign, { dimensions: ['bids'] })
    if (denial) {
      return {
        ok: false,
        error: `authority pin: ${denial.reason}${campaign.pinNote ? ` (${campaign.pinNote})` : ''}`,
      }
    }
    const currentBidCents = target.bidCents ?? 0
    return {
      ok: true,
      preview: {
        action: 'set-target-bid',
        target: { id: target.id, expression: target.expressionValue, matchType: target.expressionType },
        campaign: { id: campaign.id, name: campaign.name },
        currentBidCents,
        proposedBidCents,
        deltaCents: proposedBidCents - currentBidCents,
        effect: `Moves "${target.expressionValue}" from €${(currentBidCents / 100).toFixed(2)} to €${(proposedBidCents / 100).toFixed(2)} in ${campaign.name}.`,
      },
    }
  },
}

export const ADS_PROPOSE_TOOLS: AgentTool[] = [
  createNegativeKeyword,
  graduateKeyword,
  setTargetBid,
]
