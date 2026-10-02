/**
 * NAF.C — the fleet's ads tools (plan C-D1), shared with Claude (MCP full control d1 = A). `handler` is a
 * deterministic dry-run built from the same checks the write path enforces (protected terms, authority pins,
 * isNegative-only existing-negative reads); hard denials return ok:false so the approval gate never queues them.
 *
 * MCP full control A5 — `create-negative-keyword` (ad-group negatives only; createNegative now binds the campaign's
 * allowlist) and `graduate-keyword` (into the named or resolved harvest destination) execute too, with the same rules;
 * a negative is undone by undo-ad-change retiring it, a graduation by lowering the keyword to the floor (d3: never
 * paused or archived).
 *
 * MCP full control A4 — `set-target-bid` executes once a person approves it: the A3 guards in its dry run and again in
 * `execute` (ads-change-kit.ts): live reach (a refusal is not queued; a changed answer is not run), the suppression
 * guard, the CPC-ceiling and max-change clamps shown before approval, the campaign's own currency, actor
 * `user:<approverId>`, reason `Claude request <approvalId>: <why>`, and changeSetId = the approval id. Requests made
 * before the switch carry no stored reach: they never run and the approval sweep expires them.
 *
 * The protected-terms check replicates ads-write-gate.ts:304-337 exactly
 * (WHITELIST rows, normaliseTerm both sides); it is not re-invented.
 */
import prisma from '../../../db.js'
import { pinDenial } from '../../advertising/ads-authority-pins.js'
import { normaliseTerm } from '../../advertising/ads-write-gate.js'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { createNegative } from '../../advertising/ads-negative-kw.service.js'
import { createKeywordLocal, mirrorNegativeKeywordLocal } from '../../advertising/ads-create.service.js'
import { adsProfileFor } from '../../advertising/ads-profile-resolver.js'
import { adGroupCampaigns, adGroupExternalIds, adGroupsByExternalId } from '../../advertising/ads-entity-lookup.service.js'
import { loadDestinationGraph, resolveDestination, resolveStoredDestinations } from '../../advertising/harvest-destination.service.js'
import { clampBidsByCeiling } from '../../advertising/ads-cpc-ceiling.js'
import { amountLabel, campaignCurrency, checkLiveReach, suppressionOf } from './ads-tool-guards.js'
import { alsoChangedBy, approvedRun, changeClampedBid, notRun, reachNote, reachRefusal, recheck, spOnlyRefusal, storedReach, type StoredReach } from './ads-change-kit.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'

const BID_FLOOR_CENTS = 5
const METRIC_WINDOW_DAYS = 60

interface CampaignRow {
  id: string
  name: string
  marketplace: string | null
  type: string
  adProduct: string | null
  dailyBudgetCurrency: string
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
      type: true,
      adProduct: true,
      dailyBudgetCurrency: true,
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

/** An ad group of this campaign, by Amazon's id: its Nexus id and name, or null when the campaign has no such group. */
async function adGroupInCampaign(externalAdGroupId: string, campaignId: string): Promise<{ id: string; name: string; externalAdGroupId: string } | null> {
  const group = (await adGroupsByExternalId([externalAdGroupId])).get(externalAdGroupId)
  if (!group) return null
  const campaign = (await adGroupCampaigns([group.id])).get(group.id)
  return campaign?.id === campaignId ? { ...group, externalAdGroupId } : null
}

const CAMPAIGN_SCOPE_REFUSAL =
  'Campaign-level negatives are not offered: none of those asked for through the harvest path landed at Amazon. '
  + 'Ask for an ad-group negative instead (externalAdGroupId; ad-search-terms gives it).'

/** A5 — the negative a create-negative-keyword request would add, and what the approver must see — or why not. */
async function negativePreview(args: Record<string, unknown>): Promise<ToolResult> {
  const externalCampaignId = String(args.externalCampaignId ?? '')
  const keywordText = String(args.keywordText ?? '').trim()
  const matchType = String(args.matchType ?? 'NEGATIVE_EXACT')
  const scope = String(args.scope ?? 'AD_GROUP')
  if (!externalCampaignId || !keywordText) {
    return { ok: false, error: 'externalCampaignId and keywordText are required' }
  }
  const campaign = await campaignByExternalId(externalCampaignId)
  if (!campaign) return { ok: false, error: `campaign ${externalCampaignId} not found` }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  if (scope !== 'AD_GROUP') return { ok: false, error: CAMPAIGN_SCOPE_REFUSAL }
  const externalAdGroupId = typeof args.externalAdGroupId === 'string' ? args.externalAdGroupId.trim() : ''
  if (!externalAdGroupId) return { ok: false, error: 'Name the ad group to add the negative to: externalAdGroupId (ad-search-terms gives it).' }
  const adGroup = await adGroupInCampaign(externalAdGroupId, campaign.id)
  if (!adGroup) return { ok: false, error: `ad group ${externalAdGroupId} not found in ${campaign.name}` }

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

  const reach = await checkLiveReach({
    campaignId: campaign.id,
    marketplace: campaign.marketplace,
    changes: [{ field: 'negativeKeyword', valueCents: null }],
    isNegation: true,
    keywordText,
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const metrics = await termMetrics(keywordText, externalCampaignId)
  const bound = await alsoChangedBy(campaign.id)
  return {
    ok: true,
    preview: {
      action: 'create-negative-keyword',
      term: keywordText,
      matchType,
      scope,
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      adGroup: { id: adGroup.id, name: adGroup.name, externalAdGroupId: adGroup.externalAdGroupId },
      externalAdGroupId: adGroup.externalAdGroupId,
      currency,
      metrics,
      alreadyNegated: false,
      protectedDenial: null,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      effect: `Stops "${keywordText}" from matching in ${campaign.name} › ${adGroup.name}; spend on it (last ${metrics.windowDays}d) was ${amountLabel(metrics.costCents, currency)} with ${metrics.orders} orders.`,
    },
  }
}

/** C2 — undo of a negative: undo-ad-change retires what the request created (its change set is the approval). */
export const CREATE_NEGATIVE_UNDO: ToolUndo = {
  async current(change) {
    const listed = ((change.after as { negatives?: Array<{ targetId?: unknown }> } | null)?.negatives ?? []).map((n) => String(n.targetId ?? ''))
    const standing = listed.length
      ? await prisma.adTarget.findMany({ where: { id: { in: listed }, isNegative: true, retiredAt: null, status: { not: 'ARCHIVED' } }, select: { id: true } })
      : []
    const ids = new Set(standing.map((t) => t.id))
    return { negatives: listed.filter((id) => ids.has(id)).map((targetId) => ({ targetId })) }
  },
  request(change) {
    const changeSetId = (change.before as { changeSetId?: unknown } | null)?.changeSetId
    if (typeof changeSetId !== 'string' || !changeSetId) return { refusal: 'This change does not name the request that made it.' }
    return { tool: 'undo-ad-change', args: { changeSetId, why: 'undo of a negative keyword' } }
  },
}

const createNegativeKeyword: AgentTool = {
  name: 'create-negative-keyword',
  title: 'Add a negative keyword',
  input: z.object({
    externalCampaignId: z.string().min(1).describe('Amazon campaign id (externalCampaignId in ad-search-terms)'),
    keywordText: z.string().trim().min(1).describe('the search term to block'),
    matchType: z.enum(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE']).optional().describe('default NEGATIVE_EXACT'),
    scope: z.enum(['AD_GROUP', 'CAMPAIGN']).optional().describe('AD_GROUP (the default and the only one offered: campaign-level negatives are refused)'),
    externalAdGroupId: z.string().optional().describe('Amazon ad group id to add it to (externalAdGroupId in ad-search-terms); required'),
    marketplace: z.string().optional().describe('ignored: the campaign\'s own market is used'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A5 — an approved negative is created at Amazon at once (no cancel window): the approval is the brake.
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: CREATE_NEGATIVE_UNDO,
  description:
    'Add a negative keyword to one ad group of an Amazon Sponsored Products campaign, so a search term stops '
    + 'triggering its ads. Nothing changes until a person approves it in Nexus. The preview shows the term\'s recent '
    + 'spend and orders, the ad group, and whether it lands live at Amazon or in sandbox. Refused, and not queued, '
    + 'for a protected term, a term already negated in the campaign, a campaign-level negative, or when Amazon\'s '
    + 'write gate would refuse it (the campaign must be on the live-write allowlist). Once approved it is created at '
    + 'once as the approver; undo-change retires it again.',
  async handler(args) {
    return negativePreview(args)
  },
  async execute(args, ctx) {
    const fresh = await negativePreview(args)
    const refusal = recheck(ctx, fresh, NEGATIVE_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { term: string; matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'; campaign: { id: string; marketplace: string | null }; adGroup: { id: string; externalAdGroupId: string }; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const profileId = p.reach.reach === 'live' ? p.reach.profileId : (await adsProfileFor(p.campaign.marketplace))?.profileId ?? 'sandbox'
    const made = await createNegative({
      profileId,
      externalCampaignId: String(args.externalCampaignId),
      externalAdGroupId: p.adGroup.externalAdGroupId,
      keywordText: p.term,
      matchType: p.matchType,
      scope: 'AD_GROUP',
      marketplace: p.campaign.marketplace ?? '',
      nexusCampaignId: p.campaign.id,
    })
    if (made.denied) return notRun(`Not run: Amazon's write gate refused it — ${made.denied.reason}. Nothing changed.`)
    if (!made.ok) return notRun('Not run: Amazon did not accept the negative keyword. Nothing changed.')
    const mirror = await mirrorNegativeKeywordLocal({
      adGroupId: p.adGroup.id,
      keywordText: p.term,
      matchType: p.matchType,
      externalTargetId: made.externalNegativeKeywordId,
      userId: run.actor,
    })
    const reachedAmazon = made.mode === 'live' && made.externalNegativeKeywordId != null
    return {
      ok: true,
      data: {
        targetId: mirror.id,
        created: mirror.created,
        reach: p.reach,
        reachedAmazon,
        changeSetId: run.changeSetId,
        note: made.mode === 'live'
          ? (reachedAmazon ? 'Created at Amazon.' : 'Amazon answered without an id for it: the next sync shows whether it exists there.')
          : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
      },
      change: {
        before: { changeSetId: run.changeSetId, negatives: [] },
        after: { negatives: [{ targetId: mirror.id }] },
      },
    }
  },
}

/** A5 — the starting facts an approved negative must still find. */
const NEGATIVE_MATERIAL = ['matchType', 'scope', 'alreadyNegated', 'adGroup', 'reach'] as const

/** A5 — where a graduated keyword goes: the ad group named, else the harvest destination the account resolves. */
async function destinationAdGroup(args: Record<string, unknown>, query: string, source: CampaignRow, dest: CampaignRow, destNamed: boolean): Promise<{ id: string; name: string; externalAdGroupId: string | null; campaignId: string; why: string } | { refusal: string }> {
  const named = typeof args.destExternalAdGroupId === 'string' ? args.destExternalAdGroupId.trim() : ''
  if (named) {
    const group = await adGroupInCampaign(named, dest.id)
    return group ? { ...group, campaignId: dest.id, why: 'named in the request' } : { refusal: `ad group ${named} not found in ${dest.name}` }
  }
  const sourceGroupExt = typeof args.sourceExternalAdGroupId === 'string' ? args.sourceExternalAdGroupId.trim() : ''
  if (!sourceGroupExt) return { refusal: 'Name the ad group to add the keyword to (destExternalAdGroupId), or the ad group it converted in (sourceExternalAdGroupId) so the harvest destination can be resolved.' }
  const sourceGroup = await adGroupInCampaign(sourceGroupExt, source.id)
  if (!sourceGroup) return { refusal: `ad group ${sourceGroupExt} not found in ${source.name}` }
  const [graph, stored] = await Promise.all([
    loadDestinationGraph(),
    resolveStoredDestinations({ market: source.marketplace ?? 'all', campaign: source.id, adGroup: sourceGroup.id }),
  ])
  const resolved = resolveDestination({ graph, stored, sourceAdGroupId: sourceGroup.id, sourceAdGroupName: sourceGroup.name, term: query, kind: 'keyword', createType: 'EXACT' })
  if (!resolved.chosen) {
    return { refusal: `No destination ad group is decided for this term (${resolved.source === 'resolved-ambiguous' ? `${resolved.shortlist.length} could take it` : 'none fits'}). Name one: destExternalAdGroupId.` }
  }
  if (destNamed && resolved.chosen.campaignId !== dest.id) {
    return { refusal: `The harvest destination for this term is in ${resolved.chosen.campaignName}, not ${dest.name}: name the ad group (destExternalAdGroupId).` }
  }
  const ext = (await adGroupExternalIds([resolved.chosen.adGroupId])).get(resolved.chosen.adGroupId) ?? null
  return { id: resolved.chosen.adGroupId, name: resolved.chosen.adGroupName, externalAdGroupId: ext, campaignId: resolved.chosen.campaignId, why: resolved.source === 'stored' ? 'the harvest destination stored for this scope' : 'the only ad group the harvest resolver offers' }
}

/** A5 — the keyword a graduate-keyword request would create, and what the approver must see — or why not. */
async function graduationPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? '').trim()
  const sourceExternalCampaignId = String(args.sourceExternalCampaignId ?? '')
  if (!query || !sourceExternalCampaignId) {
    return { ok: false, error: 'query and sourceExternalCampaignId are required' }
  }
  const destNamed = typeof args.destExternalCampaignId === 'string' && args.destExternalCampaignId.trim() !== ''
  const source = await campaignByExternalId(sourceExternalCampaignId)
  if (!source) return { ok: false, error: `campaign ${sourceExternalCampaignId} not found` }
  const destExternalCampaignId = String(args.destExternalCampaignId ?? sourceExternalCampaignId)
  let campaign = destNamed ? await campaignByExternalId(destExternalCampaignId) : source
  if (!campaign) return { ok: false, error: `campaign ${destExternalCampaignId} not found` }

  // Creating a keyword sets a bid — the bids pin governs.
  const pinned = (c: CampaignRow) => {
    const denial = pinDenial(c, { dimensions: ['bids'] })
    return denial ? `authority pin: ${denial.reason}${c.pinNote ? ` (${c.pinNote})` : ''}` : null
  }
  const destPin = pinned(campaign)
  if (destPin) return { ok: false, error: destPin }

  const existingIn = async (externalCampaignId: string) => prisma.adTarget.findMany({
    where: {
      isNegative: false,
      kind: 'KEYWORD',
      expressionType: 'EXACT',
      expressionValue: { equals: query, mode: 'insensitive' },
      adGroup: { campaign: { externalCampaignId } },
    },
    select: { expressionValue: true },
    take: 1,
  })
  if ((await existingIn(destExternalCampaignId)).length > 0) {
    return { ok: false, error: `an EXACT keyword for "${query}" already exists in the destination campaign` }
  }

  const group = await destinationAdGroup(args, query, source, campaign, destNamed)
  if ('refusal' in group) return { ok: false, error: group.refusal }
  if (group.campaignId !== campaign.id) {
    // The resolver chose an ad group of another campaign (the request named none): that campaign is the destination.
    const resolvedCampaign = await prisma.campaign.findFirst({ where: { id: group.campaignId }, select: { externalCampaignId: true } })
    campaign = resolvedCampaign?.externalCampaignId ? await campaignByExternalId(resolvedCampaign.externalCampaignId) : null
    if (!campaign) return { ok: false, error: 'the resolved destination campaign was not found' }
    const pin = pinned(campaign)
    if (pin) return { ok: false, error: pin }
    if ((await existingIn(resolvedCampaign!.externalCampaignId!)).length > 0) {
      return { ok: false, error: `an EXACT keyword for "${query}" already exists in the destination campaign` }
    }
  }
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }

  const metrics = await termMetrics(query, sourceExternalCampaignId)
  // The applyHarvest bid formula: observed CPC, floored (cents).
  const suggestedBidCents =
    args.bidCents != null && Number.isFinite(Number(args.bidCents))
      ? Math.max(BID_FLOOR_CENTS, Math.round(Number(args.bidCents)))
      : metrics.clicks > 0
        ? Math.max(BID_FLOOR_CENTS, Math.round(metrics.costCents / metrics.clicks))
        : 50
  const reach = await checkLiveReach({
    campaignId: campaign.id,
    marketplace: campaign.marketplace,
    changes: [{ field: 'bid', valueCents: suggestedBidCents }],
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const currency = campaignCurrency(campaign)
  const bound = await alsoChangedBy(campaign.id)
  return {
    ok: true,
    preview: {
      action: 'graduate-keyword',
      query,
      destination: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      destinationAdGroup: { id: group.id, name: group.name, externalAdGroupId: group.externalAdGroupId, why: group.why },
      currency,
      suggestedBidCents,
      metrics,
      alreadyExact: false,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      effect: `Creates an EXACT keyword "${query}" at ${amountLabel(suggestedBidCents, currency)} in ${campaign.name} › ${group.name}; the term produced ${metrics.orders} orders on ${amountLabel(metrics.costCents, currency)} spend (last ${metrics.windowDays}d). The source ad group is not negated here.`,
    },
  }
}

/** A5 — the starting facts an approved graduation must still find. */
const GRADUATION_MATERIAL = ['suggestedBidCents', 'destination', 'destinationAdGroup', 'alreadyExact', 'reach'] as const

/**
 * C2 — undo of a graduation: the keyword stays at Amazon (Nexus never pauses or archives an ad, d3); its bid goes down
 * to the 5¢ floor through set-target-bid, which stops it winning auctions. Partly reversible: it was live meanwhile.
 */
export const GRADUATE_UNDO: ToolUndo = {
  async current(change) {
    const targetId = String((change.after as { targetId?: unknown } | null)?.targetId ?? '')
    const t = await prisma.adTarget.findFirst({ where: { id: targetId }, select: { bidCents: true } })
    return { targetId, bidCents: t?.bidCents ?? null }
  },
  request(change) {
    const targetId = (change.after as { targetId?: unknown } | null)?.targetId
    if (typeof targetId !== 'string' || !targetId) return { refusal: 'This change does not name the keyword it created.' }
    return { tool: 'set-target-bid', args: { targetId, proposedBidCents: BID_FLOOR_CENTS, why: 'undo of a graduation: the keyword stays (Nexus never pauses or archives), its bid goes to the floor' } }
  },
}

const graduateKeyword: AgentTool = {
  name: 'graduate-keyword',
  title: 'Add an exact keyword',
  input: z.object({
    query: z.string().trim().min(1).describe('the search term to promote'),
    sourceExternalCampaignId: z.string().min(1).describe('Amazon campaign id it converted in'),
    sourceExternalAdGroupId: z.string().optional().describe('Amazon ad group id it converted in (resolves the destination when none is named)'),
    destExternalCampaignId: z.string().min(1).optional().describe('campaign to add it to (default: the source, or the resolved destination\'s)'),
    destExternalAdGroupId: z.string().optional().describe('ad group to add it to (default: the harvest destination the account resolves)'),
    bidCents: z.coerce.number().positive().optional().describe('starting bid in minor units of the campaign\'s currency (default: its cost per click)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  }),
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A5 — an approved keyword is created at Amazon at once (no cancel window).
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: GRADUATE_UNDO,
  description:
    'Promote a converting search term to an EXACT keyword in an Amazon Sponsored Products ad group (the one named, or '
    + 'the harvest destination the account resolves). Nothing changes until a person approves it in Nexus. The preview '
    + 'shows the starting bid in the campaign\'s currency (default: the term\'s cost per click), the term\'s record, '
    + 'and whether it lands live at Amazon or in sandbox. Refused, and not queued, on a bids pin, when the exact '
    + 'keyword exists, or when Amazon\'s write gate would refuse it. The source ad group is not negated. Undo lowers '
    + 'the keyword to the 5-cent floor (it is never paused or archived).',
  async handler(args) {
    return graduationPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await graduationPreview(args)
    const refusal = recheck(ctx, fresh, GRADUATION_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { query: string; suggestedBidCents: number; destinationAdGroup: { id: string }; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const made = await createKeywordLocal({
      adGroupId: p.destinationAdGroup.id,
      keywordText: p.query,
      matchType: 'EXACT',
      bidEur: p.suggestedBidCents / 100,
      userId: run.actor,
      evidence: { metric: 'claudeRequest', note: run.reason },
    })
    if (made.existed) return notRun(`Not run: an EXACT keyword for "${p.query}" appeared in that ad group meanwhile. Nothing changed.`)
    const live = p.reach.reach === 'live'
    const reachedAmazon = live && made.externalTargetId != null && !made.denied && !made.pushError
    return {
      ok: true,
      data: {
        targetId: made.id,
        bidCents: p.suggestedBidCents,
        reach: p.reach,
        reachedAmazon,
        changeSetId: run.changeSetId,
        note: !live
          ? 'Sandbox: recorded in Nexus only; nothing reached Amazon.'
          : reachedAmazon
            ? 'Created at Amazon.'
            : `Created in Nexus only: ${made.denied ? `Amazon's write gate refused it (${made.denied.reason})` : made.pushError ? `Amazon's answer was an error (${made.pushError})` : 'Amazon returned no id for it'}.`,
      },
      change: {
        before: { changeSetId: run.changeSetId, keyword: null },
        after: { targetId: made.id, bidCents: p.suggestedBidCents },
      },
    }
  },
}

/** The bid a set-target-bid request would write, and everything the approver must see — or why it is refused. */
async function targetBidPreview(args: Record<string, unknown>): Promise<ToolResult> {
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
      suppressedFromBidCents: true,
      isNegative: true,
      adGroup: {
        select: {
          campaign: {
            select: {
              id: true,
              name: true,
              type: true,
              adProduct: true,
              marketplace: true,
              dailyBudgetCurrency: true,
              dynamicBidding: true,
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
  const notSp = spOnlyRefusal(campaign)
  if (notSp) return { ok: false, error: notSp }
  const denial = pinDenial(campaign, { dimensions: ['bids'] })
  if (denial) {
    return {
      ok: false,
      error: `authority pin: ${denial.reason}${campaign.pinNote ? ` (${campaign.pinNote})` : ''}`,
    }
  }
  const currentBidCents = target.bidCents ?? 0
  // The bid that lands: the CPC ceiling first (as the bid routes apply it), then the campaign's max-change guardrail.
  const { entries, clamps } = await clampBidsByCeiling([{ adTargetId: target.id, bidCents: proposedBidCents }])
  const effectiveBidCents = changeClampedBid(currentBidCents, entries[0].bidCents, campaign.dynamicBidding)
  // No-pause: a suppressed bid is never raised here; only restore-campaign lifts a suppression.
  const verdict = suppressionOf({ id: target.id, bidCents: currentBidCents, suppressedFromBidCents: target.suppressedFromBidCents }, effectiveBidCents)
  if (verdict === 'suppressed') {
    return { ok: false, error: `"${target.expressionValue}" is suppressed (no-pause floor, its bid before was ${target.suppressedFromBidCents}c): it is not raised here. Restoring the campaign lifts it.` }
  }
  if (verdict === 'low-unflagged') {
    return { ok: false, error: `"${target.expressionValue}" sits at ${currentBidCents}c, the floor another path lowered it to: it is not raised here.` }
  }
  const reach = await checkLiveReach({
    campaignId: campaign.id,
    marketplace: campaign.marketplace,
    changes: [{ field: 'bid', valueCents: effectiveBidCents }],
  })
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const currency = campaignCurrency(campaign)
  const stored = storedReach(reach)
  const bound = await alsoChangedBy(campaign.id)
  return {
    ok: true,
    preview: {
      action: 'set-target-bid',
      target: { id: target.id, expression: target.expressionValue, matchType: target.expressionType },
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      currency,
      currentBidCents,
      proposedBidCents,
      ...(effectiveBidCents !== proposedBidCents ? { effectiveBidCents, clampedBy: clamps.length ? 'the campaign\'s CPC ceiling' : 'the campaign\'s max-change guardrail' } : {}),
      deltaCents: effectiveBidCents - currentBidCents,
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      effect: `Moves "${target.expressionValue}" from ${amountLabel(currentBidCents, currency)} to ${amountLabel(effectiveBidCents, currency)} in ${campaign.name}.`,
    },
  }
}

/** A4 — the starting values an approved bid change must still find (MATERIAL_PREVIEW_FIELDS holds the same list). */
const TARGET_BID_MATERIAL = ['currentBidCents', 'effectiveBidCents', 'reach'] as const

/**
 * C2 — undo of a bid change: set the bid it replaced, through set-target-bid itself (the same guards, preview,
 * approval). Refused while the bid is no longer the one it wrote. The change set it wrote stays in the ads audit.
 */
export const SET_TARGET_BID_UNDO: ToolUndo = {
  async current(change) {
    const targetId = String((change.after as { targetId?: unknown } | null)?.targetId ?? '')
    const t = await prisma.adTarget.findFirst({ where: { id: targetId }, select: { bidCents: true } })
    return { targetId, bidCents: t?.bidCents ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { targetId?: string; bidCents?: number | null }
    if (!before.targetId) return { refusal: 'This change does not name its target.' }
    if (before.bidCents == null || before.bidCents < BID_FLOOR_CENTS) {
      return { refusal: `The bid before this change (${before.bidCents ?? 'none'}c) is below the ${BID_FLOOR_CENTS}c floor a bid change may set.` }
    }
    return { tool: 'set-target-bid', args: { targetId: before.targetId, proposedBidCents: before.bidCents, why: 'undo of an earlier bid change' } }
  },
}

const setTargetBid: AgentTool = {
  name: 'set-target-bid',
  title: 'Change a target\'s bid',
  input: z.object({
    targetId: z.string().min(1).describe('Nexus ad target id (targetId in ad-targets)'),
    proposedBidCents: z.coerce.number().describe('new bid in minor units (cents) of the campaign\'s currency, at least 5'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A4 — an approved bid change is sent to Amazon (live) after the 5-minute cancel window.
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: SET_TARGET_BID_UNDO,
  description:
    'Change one keyword or target bid on an Amazon Sponsored Products campaign. Nothing changes until a person approves '
    + 'it in Nexus. The preview shows the current and new bid in the campaign\'s currency (after the campaign\'s CPC '
    + 'ceiling and max-change guardrail), whether it lands live at Amazon or in sandbox, and the rules that may move it '
    + 'again. Refused, and not queued, when Amazon\'s write gate would refuse it (a campaign must be on the live-write '
    + 'allowlist), when a pin holds the bids, or when it would raise a suppressed (no-pause) bid. Once approved it runs '
    + 'as the approver; undo-change puts the old bid back.',
  async handler(args) {
    return targetBidPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await targetBidPreview(args)
    const refusal = recheck(ctx, fresh, TARGET_BID_MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { target: { id: string; expression: string }; currentBidCents: number; proposedBidCents: number; effectiveBidCents?: number; reach: unknown; effect: string; currency: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const newBidCents = p.effectiveBidCents ?? p.proposedBidCents
    const out = await updateAdTargetWithSync({
      adTargetId: p.target.id,
      patch: { bidCents: newBidCents },
      actor: run.actor,
      reason: run.reason,
      changeSetId: run.changeSetId,
    })
    if (!out.ok) return notRun(`Not run: the bid write was refused (${out.error ?? 'unknown'}). Nothing changed.`)
    const written = await prisma.adTarget.findFirst({ where: { id: p.target.id }, select: { bidCents: true } })
    const after = written?.bidCents ?? newBidCents
    return {
      ok: true,
      data: {
        changed: out.error !== 'no_changes',
        targetId: p.target.id,
        bidCents: after,
        currency: p.currency,
        reach: p.reach,
        changeSetId: run.changeSetId,
        outboundQueueId: out.outboundQueueId,
        actionLogId: out.actionLogId,
        note: out.outboundQueueId ? 'Queued for Amazon: it is sent after the 5-minute cancel window. approval-status follows it.' : 'The bid was already this value: nothing was queued.',
      },
      ...(out.error === 'no_changes'
        ? {}
        : {
            change: {
              before: { targetId: p.target.id, bidCents: p.currentBidCents, changeSetId: run.changeSetId },
              after: { targetId: p.target.id, bidCents: after },
            },
          }),
    }
  },
}

export const ADS_PROPOSE_TOOLS: AgentTool[] = [
  createNegativeKeyword,
  graduateKeyword,
  setTargetBid,
]
