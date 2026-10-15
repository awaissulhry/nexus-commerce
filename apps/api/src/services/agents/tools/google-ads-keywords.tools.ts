/**
 * Google Ads changes (2026-10-15, Owner's brief "full write control of Google Ads through Nexus") — PR 3: ad groups,
 * keywords and negative keywords of Search and Standard Shopping campaigns. Every tool here is a Nexus change: a preview
 * Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that person
 * (google-ads-kit.ts). Never by rule.
 *
 *   set-google-ad-groups   make ad groups (a Shopping one with its product ad), rename them, change their default max CPC
 *   set-google-keywords    add keywords to Search ad groups, change max CPCs by keyword or by a filter
 *   set-google-negatives   add and remove negative keywords of a campaign and of its ad groups
 *
 * The live state each preview stands on is read from Google at preview time (live-keywords.ts), one query per part.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { adGroupChangeDraft, adGroupRecordAfterRun, type AdGroupChangeRecord, type AdGroupChangeRequest } from '../../marketing/google-ads/change-ad-groups.js'
import {
  keywordChangeDraft, keywordRecordAfterRun, MAX_KEYWORD_OPERATIONS, negativeChangeDraft, negativeRecordAfterRun,
  type KeywordChangeRecord, type KeywordChangeRequest, type NegativeChangeRecord, type NegativeChangeRequest, type NegativeRecordEntry,
} from '../../marketing/google-ads/change-keywords.js'
import { keywordKey, liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveAdGroups, liveCampaignNegatives, liveKeywords } from '../../marketing/google-ads/live-keywords.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/**
 * Money keys of the bid tools' previews and answers beyond the shared registry (which names bidCents and defaultBidCents):
 * the from → to table, the SPENDS MONEY sentences (they quote bids, and the preview repeats them in its warnings), and
 * the bid range of a bulk change.
 */
const GOOGLE_BID_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, minBidCents: ADSPEND, maxBidCents: ADSPEND, cpcBidCents: ADSPEND } as const

/** A recorded change names the Google account it was made on (google-ads-kit stamps it). */
type OnAccount = { accountId?: string; customerId?: string }
const onAccount = (record: OnAccount) => (record.accountId ? { accountId: record.accountId } : {})

const keywordIdArg = z.string().trim().regex(/^\d{1,20}~\d{1,20}$/, 'a keyword id is adGroupId~criterionId')
  .describe('the keyword: adGroupId~criterionId (google-ads-live view campaign shows both)')

/** The campaign is read first: a campaign that is not there costs one read, not three. */
async function campaignParts(account: Parameters<GoogleDraftBuilder>[0], campaignId: string) {
  const campaigns = await liveCampaigns(account.target)
  const there = campaigns.some((c) => c.campaignId === campaignId)
  return { campaigns, there }
}

// ── set-google-ad-groups ─────────────────────────────────────────────────────────────────────────────────────────

const adGroupRequest = (args: Record<string, unknown>): AdGroupChangeRequest => ({
  campaignId: String(args.campaignId ?? ''),
  create: args.create as AdGroupChangeRequest['create'],
  change: args.change as AdGroupChangeRequest['change'],
  enable: args.enable === true,
})

const buildAdGroups = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = adGroupRequest(args)
  const { campaigns, there } = await campaignParts(account, request.campaignId)
  const adGroups = there ? await liveAdGroups(account.target, request.campaignId) : []
  return adGroupChangeDraft(customerResource(account.target), account.currency, request, { campaigns, adGroups })
}

const adGroupUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AdGroupChangeRecord & OnAccount
    const account = await recordAccount(after)
    if (!account) return null
    const groups = new Map((await liveAdGroups(account.target, after.campaignId)).map((g) => [g.adGroupId, g]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      adGroups: (after.adGroups ?? []).map((a) => {
        const g = groups.get(a.adGroupId)
        return {
          adGroupId: a.adGroupId,
          ...('name' in a ? { name: g ? g.name : '(removed)' } : {}),
          ...('defaultBidCents' in a ? { defaultBidCents: g ? g.cpcBidCents : '(removed)' } : {}),
        }
      }),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AdGroupChangeRecord & OnAccount
    const created = ((change.after ?? {}) as AdGroupChangeRecord).created ?? []
    const back = (before.adGroups ?? [])
      .map((g) => ({ adGroupId: g.adGroupId, ...(g.name !== undefined ? { name: g.name } : {}), ...(typeof g.defaultBidCents === 'number' ? { defaultBidCents: g.defaultBidCents } : {}) }))
      .filter((g) => 'name' in g || 'defaultBidCents' in g)
    const noBid = (before.adGroups ?? []).filter((g) => g.defaultBidCents === null).length
    const made = `${created.length === 1 ? 'ad group' : `${created.length} ad groups`} (${created.slice(0, 3).map((c) => `"${c.name}"`).join(', ')}${created.length > 3 ? ' …' : ''})`
    if (!back.length) {
      return {
        refusal: created.length
          ? `This change made the ${made}: Nexus does not remove ad groups as an undo. Pause or remove ${created.length === 1 ? 'it' : 'them'} (a status change, or in Google Ads).`
          : 'This change replaced nothing that can be put back.',
      }
    }
    return {
      tool: 'set-google-ad-groups',
      args: {
        ...onAccount(before),
        campaignId: before.campaignId,
        change: back,
        why: `undo of an earlier ad group change: names and default max CPCs back${created.length ? `; the ${made} it made stay${created.length === 1 ? 's' : ''} (pause or remove ${created.length === 1 ? 'it' : 'them'})` : ''}${noBid ? `; ${noBid} had no default max CPC before and keep the one it set` : ''}`.slice(0, 300),
      },
    }
  },
}

const setGoogleAdGroups: AgentTool = {
  name: 'set-google-ad-groups',
  title: 'Change Google Ads ad groups',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Names and default max CPCs go back; an ad group it made stays (undo says to pause or remove it).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: GOOGLE_BID_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign (Search or Standard Shopping)'),
    create: z.array(z.object({
      name: z.string().trim().min(1).max(254).describe('the new ad group\'s name (unique in the campaign; fewer than 255 characters, no line breaks)'),
      defaultBidCents: googleCentsArg('its default max CPC'),
    })).max(50).optional().describe('new ad groups of the campaign: a Search campaign\'s are standard Search ad groups; a Shopping campaign\'s are product ad groups, each made with its product ad'),
    change: z.array(z.object({
      adGroupId: googleIdArg('the ad group'),
      name: z.string().trim().min(1).max(254).optional().describe('its new name (unique in the campaign)'),
      defaultBidCents: googleCentsArg('its new default max CPC').optional(),
    })).max(100).optional().describe('existing ad groups of the campaign: a new name, a new default max CPC, or both'),
    enable: z.boolean().optional().describe('only in an ENABLED campaign: make the new ad groups ENABLED, so they can spend at once (SPENDS MONEY); without it they are made PAUSED. In a campaign that is not enabled they are made ENABLED (nothing serves until the campaign is)'),
    why: googleWhyArg,
  }),
  description:
    'Ad groups of one Search or Standard Shopping campaign of the business\'s chosen Google Ads account: make ad groups '
    + '(create: a name and a default max CPC; a Shopping ad group gets its product ad in the same request, its product '
    + 'groups are a separate change), rename them and change their default max CPC (change). All in one request. Amounts '
    + 'are minor units (cents) of the account\'s currency. A new ad group in an enabled campaign is made PAUSED unless '
    + 'enable is true (SPENDS MONEY); a default max CPC raise is marked SPENDS MONEY. Two ad groups with one name in a '
    + 'campaign are refused before anything is sent. Undo puts names and default max CPCs back; an ad group it made stays '
    + '(pause or remove it).' + GOOGLE_CHANGE_RULES,
  undo: adGroupUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAdGroups(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAdGroups(args), (draft, responses) => {
    const after = adGroupRecordAfterRun(draft.after as AdGroupChangeRecord, responses)
    return {
      data: { created: (after.created ?? []).map((c) => ({ adGroupId: c.adGroupId, name: c.name, status: c.status, ...(c.adId !== undefined ? { adId: c.adId } : {}) })), changed: after.adGroups.length },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-keywords ──────────────────────────────────────────────────────────────────────────────────────────

const keywordRequest = (args: Record<string, unknown>): KeywordChangeRequest => ({
  campaignId: String(args.campaignId ?? ''),
  add: args.add as KeywordChangeRequest['add'],
  bids: args.bids as KeywordChangeRequest['bids'],
  bulk: args.bulk as KeywordChangeRequest['bulk'],
  allowBroad: args.allowBroad === true,
  enable: args.enable === true,
  removeAdded: args.removeAdded as string[] | undefined,
})

/**
 * removeAdded is the undo of an earlier keyword change only: the keyword ids that change's record says it added (in
 * this business — the record is read under the caller's business), while it is not undone yet.
 */
async function keywordsAddedBy(changeId: unknown, campaignId: string, customerId: string): Promise<string[] | { refusal: string }> {
  if (typeof changeId !== 'string' || !changeId.trim()) {
    return { refusal: 'removeAdded is only the undo of an earlier set-google-keywords change (undo-change asks for it with undoOf): this tool removes no other keyword.' }
  }
  const row = await prisma.agentChange.findFirst({ where: { id: changeId.trim(), toolName: 'set-google-keywords' }, select: { after: true, undoneAt: true } })
  if (!row) return { refusal: `Change ${changeId} is not a set-google-keywords change of this business.` }
  if (row.undoneAt) return { refusal: `Change ${changeId} was undone already.` }
  const after = (row.after ?? {}) as Partial<KeywordChangeRecord> & OnAccount
  if (after.campaignId !== campaignId || (after.customerId && after.customerId !== customerId)) return { refusal: `Change ${changeId} added keywords to another campaign or account.` }
  return (after.added ?? []).map((a) => a.keywordId)
}

const buildKeywords = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = keywordRequest(args)
  let addedByChange: string[] | undefined
  if (request.removeAdded?.length) {
    const added = await keywordsAddedBy(args.undoOf, request.campaignId, account.customerId)
    if ('refusal' in added) return added
    addedByChange = added
  }
  const { campaigns, there } = await campaignParts(account, request.campaignId)
  const adGroups = there ? await liveAdGroups(account.target, request.campaignId) : []
  const keywords = there ? await liveKeywords(account.target, request.campaignId) : []
  return keywordChangeDraft(customerResource(account.target), account.currency, request, { campaigns, adGroups, keywords, addedByChange })
}

const keywordUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as KeywordChangeRecord & OnAccount
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveKeywords(account.target, after.campaignId)).filter((k) => !k.negative).map((k) => [k.keywordId, k]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      bids: (after.bids ?? []).map((b) => ({ keywordId: b.keywordId, bidCents: byId.has(b.keywordId) ? byId.get(b.keywordId)!.cpcBidCents : '(removed)' })),
      ...(after.added ? { added: after.added.filter((a) => byId.has(a.keywordId)).map((a) => ({ ...a, bidCents: byId.get(a.keywordId)!.cpcBidCents, status: byId.get(a.keywordId)!.status })) } : {}),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as KeywordChangeRecord & OnAccount
    const after = (change.after ?? {}) as KeywordChangeRecord
    const added = after.added ?? []
    if (added.some((a) => !/^\d+~\d+$/.test(a.keywordId))) return { refusal: 'This change does not record the id Google gave every keyword it added.' }
    const bids = (before.bids ?? []).map((b) => ({ keywordId: b.keywordId, bidCents: b.bidCents }))
    const readd = before.removed ?? []
    if (!bids.length && !added.length && !readd.length) return { refusal: 'This change replaced nothing that can be put back.' }
    return {
      tool: 'set-google-keywords',
      args: {
        ...onAccount(before),
        campaignId: before.campaignId ?? after.campaignId,
        ...(bids.length ? { bids } : {}),
        // Removing what THIS change added — the one removal the keyword tool makes, checked against this change's record.
        ...(added.length ? { removeAdded: added.map((a) => a.keywordId), ...(change.id ? { undoOf: change.id } : {}) } : {}),
        ...(readd.length ? {
          add: readd.map((k) => ({ adGroupId: k.adGroupId, text: k.text, matchType: k.matchType, ...(k.bidCents !== null ? { bidCents: k.bidCents } : {}) })),
          ...(readd.some((k) => k.matchType === 'BROAD') ? { allowBroad: true } : {}),
          ...(readd.some((k) => k.status === 'ENABLED') ? { enable: true } : {}),
        } : {}),
        why: `undo of an earlier keyword change${bids.length ? ': max CPCs back' : ''}${added.length ? `${bids.length ? ';' : ':'} the ${added.length === 1 ? 'keyword' : `${added.length} keywords`} it added removed` : ''}${readd.length ? `; the ${readd.length === 1 ? 'keyword' : `${readd.length} keywords`} it removed added again` : ''}`,
      },
    }
  },
}

const setGoogleKeywords: AgentTool = {
  name: 'set-google-keywords',
  title: 'Change Google Ads keywords',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsBidsEdit, ADSPEND],
  restrictedFields: GOOGLE_BID_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Search campaign'),
    add: z.array(z.object({
      adGroupId: googleIdArg('the ad group (a standard Search ad group of the campaign)'),
      text: z.string().trim().min(1).max(80).describe('the keyword (at most 80 characters, 10 words)'),
      matchType: matchTypeArg,
      bidCents: googleCentsArg('its own max CPC (left out: it uses its ad group\'s default)').optional(),
    })).max(MAX_KEYWORD_OPERATIONS).optional().describe('keywords to add, EXACT or PHRASE (BROAD only with allowBroad); one already in its ad group (same text and match type) is skipped'),
    bids: z.array(z.object({
      keywordId: keywordIdArg,
      bidCents: googleCentsArg('its new max CPC').nullable().describe('its new max CPC in minor units (cents) of the account\'s currency; null = no bid of its own (it uses its ad group\'s default)'),
    })).max(MAX_KEYWORD_OPERATIONS).optional().describe('new max CPCs of keywords by id'),
    bulk: z.object({
      adGroupId: googleIdArg('only keywords of this ad group').optional(),
      matchType: matchTypeArg.optional(),
      minBidCents: googleCentsArg('only keywords whose max CPC now is at least this').optional(),
      maxBidCents: googleCentsArg('only keywords whose max CPC now is at most this').optional(),
      bidCents: googleCentsArg('the new max CPC of every keyword it matches').optional(),
      percent: z.coerce.number().min(-99).max(500).refine((p) => p !== 0, 'a change of 0 % changes nothing').optional()
        .describe('or: change the max CPC each keyword uses now by this percent (-20 lowers by 20 %), rounded to whole cents, at least 1 cent'),
    }).optional().describe('new max CPCs of every keyword of the campaign a filter matches (adGroupId, matchType, the max CPC now between minBidCents and maxBidCents): bidCents or percent; a keyword named in bids is left out of it'),
    allowBroad: z.boolean().optional().describe('true allows BROAD match keywords in add (they match many more searches; said in the warnings)'),
    enable: z.boolean().optional().describe('only in an ENABLED campaign: make the new keywords ENABLED, so they can spend at once (SPENDS MONEY); without it they are made PAUSED. In a campaign that is not enabled they are made ENABLED (nothing serves until the campaign is)'),
    removeAdded: z.array(keywordIdArg).max(MAX_KEYWORD_OPERATIONS).optional()
      .describe('ONLY the undo of an earlier set-google-keywords change (undo-change asks for it): the keywords that change added, removed again; any other keyword is refused'),
    undoOf: z.string().trim().min(1).max(64).optional().describe('with removeAdded: the id of the change that is undone (its record names the keywords it added)'),
    why: googleWhyArg,
  }),
  description:
    'Keywords of one Search campaign of the business\'s chosen Google Ads account: add keywords to its ad groups (add: '
    + 'EXACT or PHRASE; BROAD refused unless allowBroad; each with its own max CPC or its ad group\'s default; one already '
    + 'there is skipped), change max CPCs of keywords by id (bids), and change the max CPCs of every keyword a filter '
    + `matches (bulk: a new bid or a percent, rounded to whole cents, at least 1 cent). At most ${MAX_KEYWORD_OPERATIONS} `
    + 'keywords in one request. Amounts are minor units (cents) of the account\'s currency. A raise is marked SPENDS MONEY '
    + '(how many, from → to); a new keyword in an enabled campaign is made PAUSED unless enable is true (SPENDS MONEY). Undo '
    + 'puts the max CPCs back and removes the keywords it added (the only removal this tool makes).' + GOOGLE_CHANGE_RULES,
  undo: keywordUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildKeywords(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildKeywords(args), (draft, responses) => {
    const after = keywordRecordAfterRun(draft.after as KeywordChangeRecord, responses)
    return {
      data: { added: (after.added ?? []).map((a) => ({ keywordId: a.keywordId, text: a.text, matchType: a.matchType, status: a.status })), bidsChanged: after.bids.length },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-negatives ─────────────────────────────────────────────────────────────────────────────────────────

const negativeRequest = (args: Record<string, unknown>): NegativeChangeRequest => ({
  campaignId: String(args.campaignId ?? ''),
  add: args.add as NegativeChangeRequest['add'],
  remove: args.remove as NegativeChangeRequest['remove'],
})

const buildNegatives = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = negativeRequest(args)
  const { campaigns, there } = await campaignParts(account, request.campaignId)
  const adGroups = there ? await liveAdGroups(account.target, request.campaignId) : []
  const keywords = there ? await liveKeywords(account.target, request.campaignId) : []
  const campaignNegatives = there ? await liveCampaignNegatives(account.target, request.campaignId) : []
  return negativeChangeDraft(customerResource(account.target), request, { campaigns, adGroups, keywords, campaignNegatives })
}

const negativeArg = (n: NegativeRecordEntry) => ({ text: n.text, matchType: n.matchType, ...(n.adGroupId ? { adGroupId: n.adGroupId } : {}) })

const negativeUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as NegativeChangeRecord & OnAccount
    const account = await recordAccount(after)
    if (!account) return null
    const keywords = await liveKeywords(account.target, after.campaignId)
    const own = await liveCampaignNegatives(account.target, after.campaignId)
    const idOf = (n: NegativeRecordEntry): string | null => {
      const key = keywordKey(n.text, n.matchType)
      const found = n.adGroupId
        ? keywords.find((k) => k.negative && k.adGroupId === n.adGroupId && keywordKey(k.text, k.matchType) === key)
        : own.find((k) => keywordKey(k.text, k.matchType) === key)
      return found?.criterionId ?? null
    }
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      added: (after.added ?? []).flatMap((n) => { const id = idOf(n); return id ? [{ ...n, criterionId: id }] : [] }),
      removed: (after.removed ?? []).filter((n) => !idOf(n)),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as NegativeChangeRecord & OnAccount
    if (!after.campaignId || (!after.added?.length && !after.removed?.length)) return { refusal: 'This change replaced nothing that can be put back.' }
    return {
      tool: 'set-google-negatives',
      args: {
        ...onAccount(after),
        campaignId: after.campaignId,
        ...(after.removed.length ? { add: after.removed.map(negativeArg) } : {}),
        ...(after.added.length ? { remove: after.added.map(negativeArg) } : {}),
        why: 'undo of an earlier negative keyword change',
      },
    }
  },
}

const negativeKeywordArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the negative keyword (at most 80 characters, 10 words)'),
  matchType: matchTypeArg,
  adGroupId: googleIdArg('an ad group of the campaign; left out = the campaign\'s own negative keyword').optional(),
})

const setGoogleNegatives: AgentTool = {
  name: 'set-google-negatives',
  title: 'Change Google Ads negative keywords',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign (Search or Standard Shopping)'),
    add: z.array(negativeKeywordArg).max(250).optional().describe('negative keywords to add (already there: skipped)'),
    remove: z.array(negativeKeywordArg).max(250).optional().describe('negative keywords to remove (text and match type as they are, at the same place)'),
    why: googleWhyArg,
  }),
  description:
    'Negative keywords of one Search or Standard Shopping campaign of the business\'s chosen Google Ads account, at the '
    + 'campaign (no adGroupId) or in one of its ad groups (adGroupId): add and remove them, EXACT, PHRASE or BROAD, in one '
    + 'request. (Shared negative keyword lists: set-google-negative-list.) Removing one lets more searches show the ads '
    + '(said in the warnings); a negative that matches a keyword of the campaign is named. Undo removes what it added and '
    + 'adds back what it removed.' + GOOGLE_CHANGE_RULES,
  undo: negativeUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildNegatives(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildNegatives(args), (draft, responses) => {
    const after = negativeRecordAfterRun(draft.after as NegativeChangeRecord, responses)
    return { data: { added: after.added, removed: after.removed.length }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_KEYWORDS_TOOLS: AgentTool[] = [setGoogleAdGroups, setGoogleKeywords, setGoogleNegatives]
