/**
 * Google Ads changes, programme 2 G2 (2026-10-15) — who sees a campaign's ads: audience segments and demographics, at
 * the campaign or its ad groups. Every tool here is a Nexus change: a preview Google has checked (validate_only), an
 * approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-audiences     user lists (your data, customer lists), interests (affinity, in-market), custom and
 *                            combined segments, life events: targeted / observed, excluded, bid adjustments, and the
 *                            OBSERVATION / TARGETING setting (change-audiences.ts)
 *   set-google-demographics  age, gender, parental status, household income: excluded or shown, bid adjustments per ad
 *                            group (change-demographics.ts)
 *
 * Ids come from google-ads-live view lookup, lookup user-lists / custom-audiences / combined-audiences / audiences
 * (interests) / life-events; the preview names each new segment, read live, and refuses an id Google does not know.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder } from './google-ads-kit.js'
import { audienceDraft, audienceRecordHolds, type AudienceLive, type AudienceRecord, type AudienceRequest } from '../../marketing/google-ads/change-audiences.js'
import { demographicRecordHolds, demographicsDraft, type DemographicRecord, type DemographicRequest } from '../../marketing/google-ads/change-demographics.js'
import { liveCampaignSettings } from '../../marketing/google-ads/live.js'
import { AUDIENCE_KINDS, DEMOGRAPHIC_DIMENSIONS, DEMOGRAPHIC_VALUES, liveAdGroupTargetingState, liveSegmentNames, liveTargetingCriteria, type AudienceKind } from '../../marketing/google-ads/live-targeting.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleChangeAccount } from '../../marketing/google-ads/change-account.js'

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  reversibility: 'full' as const,
}

/**
 * The campaign, its targeting criteria, its ad groups and their audience and demographic criteria (four reads), and the
 * names of the segments a request adds (one read per kind).
 */
async function audienceLive(account: GoogleChangeAccount, campaignId: string, adds: Array<{ kind: AudienceKind; id: string }> = []): Promise<AudienceLive> {
  const campaign = await liveCampaignSettings(account.target, campaignId)
  if (!campaign) return { campaign: null, criteria: [], adGroups: [], adGroupCriteria: [] }
  const criteria = await liveTargetingCriteria(account.target, campaignId)
  return {
    campaign, criteria, ...(await liveAdGroupTargetingState(account.target, campaignId)),
    ...(adds.length ? { segmentNames: await liveSegmentNames(account.target, adds) } : {}),
  }
}

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
/** A bid factor, rounded to 4 decimals as Google's adjustments are read back (live-targeting factorOf): undo compares them. */
const factorArg = z.coerce.number().min(0.1).max(10).transform((v) => Math.round(v * 10_000) / 10_000)
const adGroupArg = googleIdArg('an ad group of this campaign (none = the campaign itself)').optional()

// ── set-google-audiences ────────────────────────────────────────────────────────────────────────────────────────

const kindArg = z.preprocess(upper, z.enum(AUDIENCE_KINDS))
  .describe('USER_LIST (your data: website visitors, customer lists), USER_INTEREST (affinity or in-market), CUSTOM_AUDIENCE, COMBINED_AUDIENCE or LIFE_EVENT')
const audienceIdArg = googleIdArg('the segment\'s id: google-ads-live view lookup, lookup user-lists / custom-audiences / combined-audiences / audiences / life-events')

const audienceRequest = (a: Record<string, unknown>): AudienceRequest => ({
  ...(a.add !== undefined ? { add: a.add as AudienceRequest['add'] } : {}),
  ...(a.remove !== undefined ? { remove: a.remove as AudienceRequest['remove'] } : {}),
  ...(a.bids !== undefined ? { bids: a.bids as AudienceRequest['bids'] } : {}),
  ...(a.modes !== undefined ? { modes: a.modes as AudienceRequest['modes'] } : {}),
})

const buildAudiences = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = audienceRequest(args)
  const live = await audienceLive(account, String(args.campaignId), (request.add ?? []).map((a) => ({ kind: a.kind, id: a.id })))
  return audienceDraft(customerResource(account.target), String(args.campaignId), request, live)
}

const audiencesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const live = await audienceLive(account, after.campaignId)
    if (!live.campaign) return null
    return audienceRecordHolds(after, live) ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as AudienceRecord & { accountId?: string }
    if (!after.campaignId || !after.undo || !Object.keys(after.undo).length) return { refusal: 'This change does not record what it replaced.' }
    return { tool: 'set-google-audiences', args: { ...(after.accountId ? { accountId: after.accountId } : {}), campaignId: after.campaignId, ...after.undo, why: 'undo of an earlier audience change' } }
  },
}

const setGoogleAudiences: AgentTool = {
  ...common,
  name: 'set-google-audiences',
  title: 'Change Google Ads audiences',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign (Search or Standard Shopping)'),
    add: z.array(z.object({
      kind: kindArg,
      id: audienceIdArg,
      adGroupId: adGroupArg,
      exclude: z.boolean().optional().describe('true = exclude it (people in it never see the ads); custom and combined segments cannot be excluded'),
      bidModifier: factorArg.optional().describe('a targeted or observed segment\'s bid adjustment as a factor (1.2 = +20 %, 0.8 = −20 %)'),
    })).max(100).optional().describe('segments to add at the campaign or one of its ad groups (new ones go in OBSERVATION where nothing narrows yet, unless modes says otherwise)'),
    remove: z.array(z.object({
      kind: kindArg,
      id: audienceIdArg,
      adGroupId: adGroupArg,
      exclude: z.boolean().optional().describe('true = remove an exclusion'),
    })).max(100).optional().describe('segments (or exclusions) to take off'),
    bids: z.array(z.object({
      kind: kindArg,
      id: audienceIdArg,
      adGroupId: adGroupArg,
      bidModifier: z.union([z.null(), factorArg]).describe('its bid adjustment as a factor; null = none'),
    })).max(100).optional().describe('change the bid adjustment of segments already targeted or observed'),
    modes: z.array(z.object({
      adGroupId: adGroupArg,
      mode: z.preprocess(upper, z.enum(['OBSERVATION', 'TARGETING', 'NONE']))
        .describe('OBSERVATION (segments only adjust bids; reach unchanged), TARGETING (the ads show only to people in the segments), NONE (no setting at this level; Google then treats segments as TARGETING)'),
    })).max(50).optional().describe('the audience setting of the campaign or of an ad group (Google keeps it on the campaign or on its ad groups, not both)'),
    why: googleWhyArg,
  }),
  description:
    'Change the audience segments of one Google Ads campaign (Search or Standard Shopping), at the campaign or at its ad '
    + 'groups: user lists (your data: website visitors, customer lists), interests (affinity, in-market), custom and '
    + 'combined segments and life events (ids: google-ads-live view lookup, lookup user-lists / custom-audiences / '
    + 'combined-audiences / audiences / life-events; the preview names each new one) — add, exclude, remove, change '
    + 'their bid adjustments, and set whether they only '
    + 'adjust bids (OBSERVATION) or narrow who sees the ads (TARGETING). New segments go in OBSERVATION where nothing '
    + 'narrows yet; where segments narrow, the mode must be named. Google keeps segments of a kind at the campaign or at '
    + 'its ad groups, not both (its check says so). Removing an exclusion, TARGETING → OBSERVATION, more segments in '
    + 'TARGETING and a raised bid adjustment are marked SPENDS MONEY; narrowing is said in the warnings. Smart Bidding '
    + 'ignores the bid adjustments. Undo puts the segments, adjustments and settings back.' + GOOGLE_CHANGE_RULES,
  undo: audiencesUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAudiences(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAudiences(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

// ── set-google-demographics ─────────────────────────────────────────────────────────────────────────────────────

const ALL_DEMOGRAPHIC_VALUES = [...new Set(Object.values(DEMOGRAPHIC_VALUES).flat())] as [string, ...string[]]
const dimensionArg = z.preprocess(upper, z.enum(DEMOGRAPHIC_DIMENSIONS as [typeof DEMOGRAPHIC_DIMENSIONS[number], ...typeof DEMOGRAPHIC_DIMENSIONS]))
  .describe('AGE_RANGE, GENDER, PARENTAL_STATUS or INCOME_RANGE')
const valueArg = z.preprocess(upper, z.enum(ALL_DEMOGRAPHIC_VALUES))
  .describe(`the group, Google's name: ${Object.entries(DEMOGRAPHIC_VALUES).map(([d, v]) => `${d}: ${v.join(', ')}`).join('; ')}`)

const demographicRequest = (a: Record<string, unknown>): DemographicRequest => ({
  ...(a.changes !== undefined ? { changes: a.changes as DemographicRequest['changes'] } : {}),
  ...(a.restore !== undefined ? { restore: a.restore as DemographicRequest['restore'] } : {}),
})

const buildDemographics = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  demographicsDraft(customerResource(account.target), String(args.campaignId), demographicRequest(args), await audienceLive(account, String(args.campaignId)))

const demographicsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as DemographicRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const live = await audienceLive(account, after.campaignId)
    if (!live.campaign) return null
    return demographicRecordHolds(after, live) ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as DemographicRecord & { accountId?: string }
    if (!after.campaignId || !after.restore?.length) return { refusal: 'This change does not record what it replaced.' }
    return { tool: 'set-google-demographics', args: { ...(after.accountId ? { accountId: after.accountId } : {}), campaignId: after.campaignId, restore: after.restore, why: 'undo of an earlier demographics change' } }
  },
}

const setGoogleDemographics: AgentTool = {
  ...common,
  name: 'set-google-demographics',
  title: 'Change Google Ads demographics',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign (Search or Standard Shopping)'),
    changes: z.array(z.object({
      dimension: dimensionArg,
      value: valueArg,
      adGroupId: googleIdArg('the ad group (none = the campaign: exclusions only)').optional(),
      exclude: z.boolean().optional().describe('true = people in this group never see the ads; false or absent = shown'),
      bidModifier: z.union([z.null(), factorArg]).optional().describe('ad groups only: shown with this bid adjustment (1.2 = +20 %); null = none'),
    })).max(100).optional().describe('groups to exclude, show again, or bid up or down'),
    restore: z.array(z.object({
      dimension: dimensionArg,
      value: valueArg,
      adGroupId: googleIdArg('the ad group (none = the campaign)').optional(),
      criterion: z.enum(['NONE', 'EXCLUDED', 'TARGETED']).describe('exactly this criterion: none, an exclusion, or a targeted group'),
      bidModifier: z.union([z.null(), factorArg]).optional().describe('a targeted group\'s bid adjustment; null = none'),
    })).max(200).optional().describe('put exactly these criteria back (what undo uses)'),
    why: googleWhyArg,
  }),
  description:
    'Change the demographics of one Google Ads campaign (Search or Standard Shopping): age, gender, parental status and '
    + 'household income — exclude a group, show it again, or set its bid adjustment. Bid adjustments are per ad group; '
    + 'the campaign itself only excludes. A bid adjustment on one group keeps every other group of that dimension shown '
    + '(Nexus sends a criterion for each). Google refuses excluding every group, or leaving only "unknown"; which '
    + 'dimensions a campaign type takes, Google\'s check says (Google lists age, gender and household income for Search). '
    + 'A group shown again and a raised bid adjustment are marked SPENDS MONEY. Smart Bidding ignores the bid '
    + 'adjustments. Undo puts the exact criteria back.' + GOOGLE_CHANGE_RULES,
  undo: demographicsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildDemographics(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildDemographics(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_AUDIENCES_TOOLS: AgentTool[] = [setGoogleAudiences, setGoogleDemographics]
