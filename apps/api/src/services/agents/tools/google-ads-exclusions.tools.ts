/**
 * Google Ads changes, G7 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — exclusions and
 * account-level negatives. Every tool here is a Nexus change: a preview Google has checked (validate_only), an
 * approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-account-exclusions    exclude websites, YouTube channels and videos, apps, app categories, content labels
 *                                    (sensitive content) and IP addresses for the WHOLE account, or take them out
 *   set-google-campaign-exclusions   the same for one campaign
 *   set-google-exclusion-list        the account's negative keyword list, placement exclusion lists and brand lists: make
 *                                    one, rename it, add / remove what it holds, put it on the account or on campaigns
 *                                    (a brand list as an exclusion or an inclusion), take it off
 *
 * The campaign negative keyword lists stay set-google-negative-list's; a campaign's and an ad group's own negative
 * keywords stay set-google-negatives'. Google's rules and what each reads: marketing/google-ads/live-exclusions.ts.
 * Money: an exclusion added narrows (a warning); one taken out, a list taken off, a brand added to a list used as an
 * inclusion widen: SPENDS MONEY, the person's decision. Undo puts every exclusion, keyword, brand and link back.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { accountExclusionDraft, campaignExclusionDraft, type ExclusionChangeRecord, type ExclusionChangeRequest } from '../../marketing/google-ads/change-exclusions.js'
import {
  createdExclusionListId, exclusionListDraft, type ExclusionListChangeRequest, type ExclusionListRecord, type ListBrand,
} from '../../marketing/google-ads/change-exclusion-lists.js'
import { keywordKey, liveCampaigns, liveCampaignSettings } from '../../marketing/google-ads/live.js'
import {
  CONTENT_LABELS, EXCLUSION_KINDS, EXCLUSION_LIST_TYPES, exclusionKey, liveAccountExclusions, liveCampaignExclusions, liveExclusionLists,
  suggestBrands, type ExclusionItem, type LiveExclusion,
} from '../../marketing/google-ads/live-exclusions.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  reversibility: 'full' as const,
  requires: [F.adsCampaignsManage] as [typeof F.adsCampaignsManage],
}

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)

const exclusionArg = z.object({
  kind: z.preprocess(lower, z.enum(EXCLUSION_KINDS))
    .describe('placement (a website), youtube-channel, youtube-video, mobile-app, app-category, content-label or ip-block'),
  value: z.string().trim().min(1).max(260)
    .describe('placement: the website (e.g. example.com, at most 250 characters); youtube-channel: the channel id (UC…) or its '
      + 'youtube.com/channel/… link; youtube-video: the video id or its link; mobile-app: Google\'s app id, "1-<App Store id>" '
      + `(iOS) or "2-<package name>" (Android); app-category: its id; content-label: one of ${CONTENT_LABELS.join(', ')}; `
      + 'ip-block: an IPv4 / IPv6 address or a CIDR block (e.g. 192.0.2.0/24)'),
})
const exclusionsArg = (what: string) => z.array(exclusionArg).max(250).optional().describe(what)

// ── one by one: the account, a campaign ─────────────────────────────────────────────────────────────────────────

const itemsRequest = (args: Record<string, unknown>): ExclusionChangeRequest => ({
  add: args.add as ExclusionItem[] | undefined,
  remove: args.remove as ExclusionItem[] | undefined,
})

const buildAccount = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = itemsRequest(args)
  const exclusions = await liveAccountExclusions(account.target)
  // The campaigns are read only for the SPENDS MONEY note of a removal (is any of them enabled?).
  const campaigns = (request.remove ?? []).length ? await liveCampaigns(account.target) : []
  return accountExclusionDraft(customerResource(account.target), request, { account: exclusions, campaigns })
}

const buildCampaign = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaignId = String(args.campaignId ?? '')
  const campaign = await liveCampaignSettings(account.target, campaignId)
  const exclusions = campaign ? await liveCampaignExclusions(account.target, campaignId) : { items: [], brandLists: [], targeted: 0 }
  return campaignExclusionDraft(customerResource(account.target), campaignId, itemsRequest(args), { campaign, exclusions })
}

/** Undo's "now" of a one-by-one change: the record as it still stands (an exclusion moved since is left out). */
const stillStands = (after: ExclusionChangeRecord, live: LiveExclusion[]) => {
  const has = new Set(live.map(exclusionKey))
  return { added: after.added.filter((i) => has.has(exclusionKey(i))), removed: after.removed.filter((i) => !has.has(exclusionKey(i))) }
}

const itemsUndoRequest = (tool: string, what: string) => (change: ToolChange) => {
  const after = (change.after ?? {}) as Partial<ExclusionChangeRecord> & { accountId?: string }
  const added = after.added ?? []
  const removed = after.removed ?? []
  if (!added.length && !removed.length) return { refusal: 'This change records no exclusion it added or removed.' }
  return {
    tool,
    args: {
      ...(after.accountId ? { accountId: after.accountId } : {}),
      ...(after.campaignId ? { campaignId: after.campaignId } : {}),
      ...(removed.length ? { add: removed } : {}),
      ...(added.length ? { remove: added } : {}),
      why: `undo of an earlier ${what} change`,
    },
  }
}

const accountUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ExclusionChangeRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveAccountExclusions(account.target)
    return { ...after, accountId: account.accountId, customerId: account.customerId, ...stillStands(after, live.items) }
  },
  request: itemsUndoRequest('set-google-account-exclusions', 'account exclusion'),
}

const campaignUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ExclusionChangeRecord & { accountId?: string; customerId?: string }
    if (!after.campaignId || !/^\d+$/.test(after.campaignId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveCampaignExclusions(account.target, after.campaignId)
    return { ...after, accountId: account.accountId, customerId: account.customerId, ...stillStands(after, live.items) }
  },
  request: itemsUndoRequest('set-google-campaign-exclusions', 'campaign exclusion'),
}

const KINDS_SENTENCE = 'websites (placements), YouTube channels and videos, mobile apps, app categories, content labels '
  + '(sensitive content such as TRAGEDY, SEXUALLY_SUGGESTIVE, PARKED_DOMAIN, LIVE_STREAMING_VIDEO) and IP addresses '
  + '(at most 500)'

const setGoogleAccountExclusions: AgentTool = {
  ...common,
  name: 'set-google-account-exclusions',
  title: 'Change Google Ads account exclusions',
  input: z.object({
    accountId: googleAccountArg,
    add: exclusionsArg('what to exclude for the whole account (already excluded: skipped)'),
    remove: exclusionsArg('account exclusions to take out (as they are excluded now)'),
    why: googleWhyArg,
  }),
  description:
    `Exclusions of the WHOLE Google Ads account (every campaign): exclude ${KINDS_SENTENCE}, or take them out — all in one `
    + 'request. Adding one narrows where the ads show (a warning); taking one out lets every campaign show ads there '
    + 'again (SPENDS MONEY). Which campaign types an exclusion acts on is Google\'s to say. The account\'s negative '
    + 'keyword list and placement lists on the account are set-google-exclusion-list\'s. Undo puts every exclusion back '
    + 'as it was.' + GOOGLE_CHANGE_RULES,
  undo: accountUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAccount(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAccount(args), (draft) => {
    const after = draft.after as ExclusionChangeRecord
    return { data: { excluded: after.added.length, removed: after.removed.length }, before: draft.before, after }
  }),
}

const setGoogleCampaignExclusions: AgentTool = {
  ...common,
  name: 'set-google-campaign-exclusions',
  title: 'Change a Google campaign\'s exclusions',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign'),
    add: exclusionsArg('what the campaign excludes from now (already excluded: skipped)'),
    remove: exclusionsArg('the campaign\'s exclusions to take out (as they are excluded now)'),
    why: googleWhyArg,
  }),
  description:
    `Exclusions of ONE Google Ads campaign: exclude ${KINDS_SENTENCE}, or take them out — all in one request. Google's `
    + 'check refuses a kind the campaign\'s type does not take, before anything is queued. Adding one narrows where the '
    + 'campaign shows (a warning); taking one out lets it show there again '
    + '(SPENDS MONEY). Its negative keywords are set-google-negatives\'; a placement exclusion list or a brand list on the '
    + 'campaign is set-google-exclusion-list\'s. Undo puts every exclusion back as it was.' + GOOGLE_CHANGE_RULES,
  undo: campaignUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildCampaign(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildCampaign(args), (draft) => {
    const after = draft.after as ExclusionChangeRecord
    return { data: { campaignId: after.campaignId, excluded: after.added.length, removed: after.removed.length }, before: draft.before, after }
  }),
}

// ── exclusion lists ─────────────────────────────────────────────────────────────────────────────────────────────

/** Each brand found by name costs one Google operation (BrandSuggestionService). */
const MAX_BRAND_NAMES = 20

type BrandAsk = { entityId?: string; name?: string }

/** Brands asked by name become Google's ids (SuggestBrands: the one suggestion with exactly that name), or a refusal listing what Google suggests. */
async function resolveBrands(target: GoogleAdsTarget, asked: BrandAsk[]): Promise<ListBrand[] | { refusal: string }> {
  const named = asked.filter((b) => !b.entityId)
  if (named.length > MAX_BRAND_NAMES) return { refusal: `${named.length} brands are given by name: Nexus finds at most ${MAX_BRAND_NAMES} by name in one request (each is a Google lookup). Give the others by entityId.` }
  const out: ListBrand[] = []
  for (const b of asked) {
    // By id: no lookup, so a name given with it is not Google's — it is shown labelled as given, never as fact.
    if (b.entityId) { const name = b.name?.trim() || null; out.push({ entityId: b.entityId.trim(), name, ...(name ? { nameAsGiven: true as const } : {}) }); continue }
    const name = (b.name ?? '').trim()
    const found = await suggestBrands(target, name)
    const exact = found.filter((s) => (s.name ?? '').trim().toLowerCase() === name.toLowerCase())
    const list = (xs: typeof found) => xs.slice(0, 10).map((s) => `${s.name ?? '?'} = ${s.entityId}${s.urls[0] ? ` (${s.urls[0]})` : ''}`).join('; ')
    if (exact.length === 1) { out.push({ entityId: exact[0].entityId, name: exact[0].name }); continue }
    if (exact.length > 1) return { refusal: `Google knows ${exact.length} brands named "${name}": give the one you mean by its entityId — ${list(exact)}.` }
    return { refusal: found.length ? `Google has no brand named exactly "${name}"; it suggests: ${list(found)}. Give the one you mean by its entityId (or its exact name).` : `Google suggests no brand for "${name}".` }
  }
  return out
}

const listRequest = (args: Record<string, unknown>): Omit<ExclusionListChangeRequest, 'addBrands'> => ({
  listId: args.listId as string | undefined,
  create: args.create as ExclusionListChangeRequest['create'],
  name: args.name as string | undefined,
  addKeywords: args.addKeywords as ExclusionListChangeRequest['addKeywords'],
  removeKeywords: args.removeKeywords as ExclusionListChangeRequest['removeKeywords'],
  addItems: args.addItems as ExclusionItem[] | undefined,
  removeItems: args.removeItems as ExclusionItem[] | undefined,
  removeBrands: args.removeBrands as string[] | undefined,
  attachCampaigns: args.attachCampaigns as ExclusionListChangeRequest['attachCampaigns'],
  detachCampaignIds: args.detachCampaignIds as string[] | undefined,
  attachToAccount: args.attachToAccount === true,
  detachFromAccount: args.detachFromAccount === true,
})

const buildList = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const base = listRequest(args)
  const asked = (args.addBrands as BrandAsk[] | undefined) ?? []
  const brands = asked.length ? await resolveBrands(account.target, asked) : []
  if ('refusal' in brands) return brands
  const read = base.create
    ? await liveExclusionLists(account.target, { types: [base.create.type], withAccount: !!base.attachToAccount })
    : await liveExclusionLists(account.target, { listId: base.listId })
  const campaigns = await liveCampaigns(account.target)
  return exclusionListDraft(customerResource(account.target), { ...base, addBrands: brands }, { lists: read.lists, account: read.account, campaigns })
}

const listUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ExclusionListRecord & { accountId?: string; customerId?: string }
    // A list it made whose id Google did not return: nothing to read; request() says why it cannot be put back.
    if (after.created && !/^\d+$/.test(String(after.listId ?? ''))) return after
    if (!after.listId || !/^\d+$/.test(after.listId)) return null
    const account = await recordAccount(after)
    if (!account) return null
    const list = (await liveExclusionLists(account.target, { listId: after.listId })).lists.find((l) => l.listId === after.listId)
    if (!list) return null
    const keywords = new Set((list.keywords ?? []).map((k) => keywordKey(k.text, k.matchType)))
    const items = new Set((list.items ?? []).map(exclusionKey))
    const brands = new Set((list.brands ?? []).map((b) => b.entityId))
    const on = new Map(list.campaigns.map((c) => [c.campaignId, c.mode]))
    // The account link and the name are read again, not carried over from the record (a link moved since must show).
    const { accountAttached: _attached, accountDetached: _detached, renamed: _renamed, ...rest } = after
    return {
      ...rest,
      accountId: account.accountId,
      customerId: account.customerId,
      addedKeywords: after.addedKeywords.filter((k) => keywords.has(keywordKey(k.text, k.matchType))),
      removedKeywords: after.removedKeywords.filter((k) => !keywords.has(keywordKey(k.text, k.matchType))),
      addedItems: after.addedItems.filter((i) => items.has(exclusionKey(i))),
      removedItems: after.removedItems.filter((i) => !items.has(exclusionKey(i))),
      addedBrands: after.addedBrands.filter((b) => brands.has(b.entityId)),
      removedBrands: after.removedBrands.filter((b) => !brands.has(b.entityId)),
      attached: after.attached.filter((a) => on.get(a.campaignId) === a.mode),
      detached: after.detached.filter((d) => !on.has(d.campaignId)),
      ...(after.accountAttached && list.account ? { accountAttached: true } : {}),
      ...(after.accountDetached && !list.account ? { accountDetached: true } : {}),
      ...(after.renamed ? { renamed: { from: after.renamed.from, to: list.name } } : {}),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Partial<ExclusionListRecord> & { accountId?: string }
    if (after.created && !/^\d+$/.test(String(after.listId ?? ''))) {
      return { refusal: 'Google did not return the list\'s id when it made it, so Nexus cannot find the list to put it back (google-ads-live view exclusions lists it by name; set-google-exclusion-list with its listId changes it).' }
    }
    if (!after.listId || !/^\d+$/.test(after.listId)) return { refusal: 'This change does not record the list it changed.' }
    if (after.renamed && !after.renamed.from) return { refusal: 'The list had no name before this change: there is no name to put back.' }
    const n = (xs?: unknown[]) => xs?.length ?? 0
    if (!after.renamed && !after.accountAttached && !after.accountDetached
      && n(after.addedKeywords) + n(after.removedKeywords) + n(after.addedItems) + n(after.removedItems) + n(after.addedBrands) + n(after.removedBrands) + n(after.attached) + n(after.detached) === 0) {
      return { refusal: 'This change only made the list: there is nothing to put back (a list that is on nothing changes nothing).' }
    }
    return {
      tool: 'set-google-exclusion-list',
      args: {
        ...(after.accountId ? { accountId: after.accountId } : {}),
        listId: after.listId,
        ...(after.renamed ? { name: after.renamed.from! } : {}),
        ...(n(after.removedKeywords) ? { addKeywords: after.removedKeywords } : {}),
        ...(n(after.addedKeywords) ? { removeKeywords: after.addedKeywords } : {}),
        ...(n(after.removedItems) ? { addItems: after.removedItems } : {}),
        ...(n(after.addedItems) ? { removeItems: after.addedItems } : {}),
        ...(n(after.removedBrands) ? { addBrands: after.removedBrands!.map((b) => ({ entityId: b.entityId, ...(b.name ? { name: b.name } : {}) })) } : {}),
        ...(n(after.addedBrands) ? { removeBrands: after.addedBrands!.map((b) => b.entityId) } : {}),
        ...(n(after.detached) ? { attachCampaigns: after.detached } : {}),
        ...(n(after.attached) ? { detachCampaignIds: after.attached!.map((a) => a.campaignId) } : {}),
        ...(after.accountAttached ? { detachFromAccount: true } : {}),
        ...(after.accountDetached ? { attachToAccount: true } : {}),
        why: `undo of an earlier exclusion list change${after.created ? ' (the list it made stays)' : ''}`,
      },
    }
  },
}

const listKeywordArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the negative keyword (at most 80 characters, 10 words)'),
  matchType: matchTypeArg,
})

const setGoogleExclusionList: AgentTool = {
  ...common,
  name: 'set-google-exclusion-list',
  title: 'Change a Google exclusion or brand list',
  input: z.object({
    accountId: googleAccountArg,
    listId: googleIdArg('the list (google-ads-live view exclusions lists them)').optional(),
    create: z.object({
      name: z.string().trim().min(1).max(255).describe('the new list\'s name (unique among the account\'s lists of its type)'),
      type: z.preprocess(upper, z.enum(EXCLUSION_LIST_TYPES))
        .describe('ACCOUNT_LEVEL_NEGATIVE_KEYWORDS (the account\'s negative keyword list: one per account), NEGATIVE_PLACEMENTS (websites, YouTube, apps) or BRANDS'),
    }).optional().describe('make a new list (give listId or create, not both)'),
    name: z.string().trim().min(1).max(255).optional().describe('a new name for the list listId names (1 to 255 bytes, unique among lists of its type)'),
    addKeywords: z.array(listKeywordArg).max(250).optional().describe('ACCOUNT_LEVEL_NEGATIVE_KEYWORDS: negative keywords to add (already there: skipped)'),
    removeKeywords: z.array(listKeywordArg).max(250).optional().describe('ACCOUNT_LEVEL_NEGATIVE_KEYWORDS: negative keywords to remove (text and match type as in the list)'),
    addItems: exclusionsArg('NEGATIVE_PLACEMENTS: websites, YouTube channels / videos, apps or app categories to add (no content label, no IP block: those are one by one)'),
    removeItems: exclusionsArg('NEGATIVE_PLACEMENTS: what to take out of the list'),
    addBrands: z.array(z.object({
      entityId: z.string().trim().min(1).max(100).optional().describe('the brand\'s Google id (a list\'s brands show it)'),
      name: z.string().trim().min(1).max(100).optional().describe('or its exact name: Nexus asks Google for it (one lookup each, at most 20 by name); several or none named so: refused, with Google\'s suggestions and their ids. Given WITH entityId it is not looked up: shown as "name as given, not checked by Google"'),
    }).refine((b) => !!b.entityId || !!b.name, 'give entityId or name')).max(100).optional().describe('BRANDS: brands to add'),
    removeBrands: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe('BRANDS: the ids (entityId) of brands to remove'),
    attachCampaigns: z.array(z.object({
      campaignId: googleIdArg('a campaign'),
      mode: z.preprocess(lower, z.enum(['exclude', 'include'])).optional()
        .describe('a brand list only: exclude (default: no ads on searches about these brands) or include (a brand restriction: the campaign\'s broad matching keeps to these brands)'),
    })).max(50).optional().describe('NEGATIVE_PLACEMENTS or BRANDS: campaigns that use the list from now (not Shopping for a placement list)'),
    detachCampaignIds: z.array(googleIdArg('a campaign')).max(50).optional().describe('campaigns that stop using the list'),
    attachToAccount: z.boolean().optional().describe('ACCOUNT_LEVEL_NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS: put the list on the whole account (every campaign)'),
    detachFromAccount: z.boolean().optional().describe('take the list off the account'),
    why: googleWhyArg,
  }),
  description:
    'Shared exclusion lists of the business\'s chosen Google Ads account, one list per request: the account\'s negative '
    + 'keyword list (type ACCOUNT_LEVEL_NEGATIVE_KEYWORDS: keywords no campaign shows ads for; Google applies it to every '
    + 'campaign\'s eligible search and shopping traffic; one per account, put on with attachToAccount), placement '
    + 'exclusion lists (NEGATIVE_PLACEMENTS: websites, YouTube channels and videos, apps, app categories; on campaigns — '
    + 'not Shopping — or the whole account) and brand lists (BRANDS: on campaigns as an exclusion, or as an inclusion that '
    + 'keeps broad matching to those brands; on a Search campaign an inclusion needs broad match / AI Max). Make one (create), rename '
    + 'it, add and remove what it holds (a brand by its id, or by its exact name: Nexus asks Google), put it on or take it '
    + 'off. All in one request. What narrows is a warning; what widens is SPENDS MONEY (something taken out of a list in '
    + 'use, a list taken off, a brand added to a list used as an inclusion). Campaign negative keyword lists are '
    + 'set-google-negative-list\'s. Undo puts names, content and links back (a list it made stays).' + GOOGLE_CHANGE_RULES,
  undo: listUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildList(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildList(args), (draft, responses) => {
    const after = structuredClone(draft.after) as ExclusionListRecord
    const before = structuredClone(draft.before) as { listId: string }
    // A list it made: before and after both name Google's id ('new' stays only when Google did not return one).
    if (args.create) before.listId = after.listId = createdExclusionListId(responses, { create: args.create as ExclusionListChangeRequest['create'] }) ?? 'new'
    return { data: { listId: after.listId, type: after.type }, before, after }
  }),
}

export const GOOGLE_ADS_EXCLUSIONS_TOOLS: AgentTool[] = [setGoogleAccountExclusions, setGoogleCampaignExclusions, setGoogleExclusionList]
