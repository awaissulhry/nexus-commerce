/**
 * Google Ads changes, PR 6 (2026-10-15) — build and copy whole campaigns, and check a change without asking for it.
 *
 *   build-google-campaigns   new shared budgets, negative keyword lists and campaigns (each PAUSED) with every part, in
 *                            ONE atomic request (temporary ids): what a change plan cannot do, as a later step cannot
 *                            point at a campaign an earlier one has not made when Google checks the plan
 *   copy-google-campaign     a live campaign into a NEW paused campaign: settings, targeting, negatives and lists, ad
 *                            groups, keywords, product groups, ads, campaign assets
 *   check-google-ads-build   read only: Google checks a build (validate_only) and the answer is its preview —
 *                            nothing is asked for, nothing waits in Approvals
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { buildDraft, buildRecordAfterRun, type BuildCampaign, type BuildRecord, type BuildSpec } from '../../marketing/google-ads/change-build.js'
import { campaignAsBuild, listAsBuild } from '../../marketing/google-ads/build-copy.js'
import { DAYS } from '../../marketing/google-ads/change-campaigns.js'
import { liveBudgets, liveCampaigns, liveNegativeLists } from '../../marketing/google-ads/live.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
const BUILD_MONEY = { changes: ADSPEND, warnings: ADSPEND, spendsMoneyBecause: ADSPEND, dailyBudgetCents: ADSPEND, defaultBidCents: ADSPEND, maxCpcCents: ADSPEND, targetCpaCents: ADSPEND, targetRoas: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  reversibility: 'full' as const,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND] as const,
  restrictedFields: BUILD_MONEY,
}

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const refArg = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('a short name of your choice that other parts of the build point at')
const textArg = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const negativeArg = z.object({ text: textArg(80, 'the negative keyword'), matchType: matchTypeArg })
const pinArg = z.enum(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', 'DESCRIPTION_1', 'DESCRIPTION_2']).optional().describe('pin to a position (optional)')
const statusArg = z.enum(['ENABLED', 'PAUSED']).optional().describe('ENABLED (default; the campaign is paused) or PAUSED')
const budgetChoice = z.object({
  ref: refArg.optional(),
  budgetId: googleIdArg('an existing shared budget').optional(),
  dailyBudgetCents: googleCentsArg('a new budget of its own').optional(),
}).describe('its budget: ref (a shared budget of this build), budgetId (an existing shared budget) or dailyBudgetCents (its own) — one')
const listChoice = z.object({ ref: refArg.optional(), listId: googleIdArg('an existing negative keyword list').optional() }).describe('a list of this build (ref) or an existing one (listId)')

const campaignArg = z.object({
  copyOf: googleIdArg('copy this live campaign (every part, made PAUSED); the fields below then override it').optional(),
  type: z.enum(['SHOPPING', 'SEARCH']).optional().describe('SHOPPING (Standard Shopping) or SEARCH; not with copyOf'),
  name: textArg(255, 'the new campaign\'s name (unique in the account)'),
  budget: budgetChoice.optional(),
  bidding: z.object({
    strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'PORTFOLIO']).describe('the bid strategy'),
    maxCpcCents: googleCentsArg('MAXIMIZE_CLICKS: the max CPC ceiling').optional(),
    targetCpaCents: googleCentsArg('MAXIMIZE_CONVERSIONS: target CPA').optional(),
    targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('MAXIMIZE_CONVERSION_VALUE: target ROAS ratio'),
    portfolioId: googleIdArg('PORTFOLIO: the portfolio strategy').optional(),
  }).optional().describe('bidding (default Manual CPC)'),
  startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('first day (YYYY-MM-DD)'),
  endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('last day (YYYY-MM-DD)'),
  searchPartners: z.boolean().optional().describe('search partners (default off)'),
  display: z.boolean().optional().describe('SEARCH: Display Network (default off)'),
  shopping: z.object({
    merchantId: googleIdArg('the Merchant Center account'),
    feedLabel: textArg(20, 'the feed label').optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Shopping priority (default LOW)'),
    localInventory: z.boolean().optional().describe('local products too (default off)'),
  }).optional().describe('SHOPPING: the feed'),
  search: z.object({
    aiMax: z.boolean().optional().describe('AI Max (default off)'),
    textCustomization: z.boolean().optional().describe('text customization (default off)'),
    finalUrlExpansion: z.boolean().optional().describe('final URL expansion (default off)'),
  }).optional().describe('SEARCH: what Google may do on its own (all off by default)'),
  locations: z.array(z.object({
    id: googleIdArg('a location (google-ads-live view lookup)'),
    exclude: z.boolean().optional().describe('excluded'),
    bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('a targeted location\'s bid adjustment as a factor'),
  })).max(100).optional().describe('locations'),
  locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('location option (default PRESENCE)'),
  languages: z.array(googleIdArg('a language')).max(50).optional().describe('SEARCH: languages'),
  schedule: z.array(z.object({
    days: z.array(z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum([...DAYS, 'ALL']))).min(1).max(7).describe('MONDAY … SUNDAY, or ALL'),
    from: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM'),
    to: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM (24:00 = midnight)'),
    bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('the slot\'s bid adjustment as a factor'),
  })).max(42).optional().describe('ad schedule'),
  audiences: z.array(googleIdArg('an audience segment')).max(50).optional().describe('audiences in OBSERVATION'),
  euPoliticalAds: z.boolean().optional().describe('true only for EU political advertising (default false)'),
  negatives: z.array(negativeArg).max(250).optional().describe('campaign-level negative keywords'),
  negativeLists: z.array(listChoice).max(20).optional().describe('shared negative keyword lists to attach'),
  adGroups: z.array(z.object({
    name: textArg(255, 'the ad group name'),
    defaultBidCents: googleCentsArg('the default max CPC').optional(),
    status: statusArg,
    keywords: z.array(z.object({ text: textArg(80, 'the keyword'), matchType: matchTypeArg, bidCents: googleCentsArg('its max CPC').optional(), status: statusArg })).max(250).optional().describe('SEARCH: keywords'),
    negatives: z.array(negativeArg).max(250).optional().describe('ad-group negative keywords'),
    productGroups: z.object({
      itemIds: z.array(textArg(50, 'an item id of the feed')).min(1).max(250).describe('item ids to advertise'),
      bidCents: googleCentsArg('the bid of each item'),
      itemBids: z.array(z.object({ itemId: textArg(50, 'an item id'), bidCents: googleCentsArg('its bid') })).max(250).optional().describe('bids of single items'),
      includeEverythingElse: z.object({ bidCents: googleCentsArg('its bid') }).optional().describe('ALSO advertise every other product of the feed (default: excluded)'),
    }).optional().describe('SHOPPING: product groups split by item id; "everything else" EXCLUDED'),
    ads: z.array(z.object({
      headlines: z.array(z.object({ text: textArg(60, 'a headline (30 wide)'), pin: pinArg })).min(3).max(15).describe('3–15 headlines'),
      descriptions: z.array(z.object({ text: textArg(180, 'a description (90 wide)'), pin: pinArg })).min(2).max(4).describe('2–4 descriptions'),
      path1: z.string().trim().max(30).optional().describe('display path 1 (15 wide)'),
      path2: z.string().trim().max(30).optional().describe('display path 2 (15 wide)'),
      finalUrl: z.string().trim().url().describe('the https landing page'),
      status: statusArg,
    })).max(10).optional().describe('SEARCH: responsive search ads'),
  })).max(50).optional().describe('ad groups'),
  assets: z.object({
    sitelinks: z.array(z.object({
      linkText: textArg(50, 'link text (25 wide)'),
      description1: z.string().trim().max(70).optional().describe('line 1 (35 wide)'),
      description2: z.string().trim().max(70).optional().describe('line 2 (35 wide)'),
      finalUrl: z.string().trim().url().describe('https page'),
    })).max(20).optional().describe('new sitelinks'),
    callouts: z.array(textArg(50, 'a callout (25 wide)')).max(20).optional().describe('new callouts'),
    structuredSnippets: z.array(z.object({
      header: textArg(60, 'a header from Google\'s list for the language'),
      language: z.string().trim().max(10).optional().describe('the header\'s language (default en)'),
      values: z.array(textArg(50, 'a value (25 wide)')).min(3).max(10).describe('3–10 values'),
    })).max(10).optional().describe('new structured snippets'),
    link: z.array(z.object({ assetId: googleIdArg('an existing asset'), fieldType: z.enum(['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET']).describe('as what') })).max(50).optional().describe('existing assets to link'),
  }).optional().describe('campaign assets'),
})

const buildInput = {
  accountId: googleAccountArg,
  sharedBudgets: z.array(z.object({ ref: refArg, name: textArg(255, 'the budget name (unique)'), budgetCents: googleCentsArg('its daily amount') })).max(10).optional().describe('new shared budgets'),
  negativeLists: z.array(z.object({
    ref: refArg,
    name: textArg(255, 'the list name (unique)'),
    keywords: z.array(negativeArg).max(250).optional().describe('its negative keywords'),
    copyOf: googleIdArg('copy the keywords of this live list').optional(),
  })).max(10).optional().describe('new negative keyword lists'),
  campaigns: z.array(campaignArg).max(10).describe('new campaigns (each made PAUSED)'),
  allowBroad: z.boolean().optional().describe('allow BROAD keywords (default no)'),
  why: googleWhyArg,
}

type CampaignArgs = z.infer<typeof campaignArg>

/** The build as asked, with every copyOf read live and expanded. */
async function specOf(account: Parameters<GoogleDraftBuilder>[0], args: Record<string, unknown>): Promise<{ spec: BuildSpec; notCopied: string[] } | { refusal: string }> {
  const notCopied: string[] = []
  const lists: BuildSpec['negativeLists'] = []
  for (const l of (args.negativeLists as Array<{ ref: string; name: string; keywords?: BuildSpec['campaigns'][number]['negatives']; copyOf?: string }>) ?? []) {
    const keywords = l.copyOf ? await listAsBuild(account.target, l.copyOf) : l.keywords ?? []
    lists.push({ ref: l.ref, name: l.name, keywords: keywords ?? [] })
  }
  const campaigns: BuildCampaign[] = []
  for (const raw of (args.campaigns as CampaignArgs[]) ?? []) {
    const budget = raw.budget
      ? (raw.budget.ref ? { ref: raw.budget.ref } : raw.budget.budgetId ? { budgetId: raw.budget.budgetId } : raw.budget.dailyBudgetCents ? { dailyBudgetCents: raw.budget.dailyBudgetCents } : null)
      : null
    if (raw.budget && !budget) return { refusal: `Campaign "${raw.name}": give the budget a ref, a budgetId or dailyBudgetCents.` }
    if (raw.copyOf) {
      const copied = await campaignAsBuild(account.target, raw.copyOf, {
        name: raw.name, ...(budget ? { budget } : {}), ...(raw.startDate ? { startDate: raw.startDate } : {}), ...(raw.endDate ? { endDate: raw.endDate } : {}),
        ...(raw.negativeLists ? { negativeLists: raw.negativeLists.map((l) => (l.ref ? { ref: l.ref } : { listId: l.listId! })) } : {}),
      })
      if ('refusal' in copied) return copied
      notCopied.push(...copied.notCopied.map((n) => `"${raw.name}": ${n}`))
      const { copyOf: _c, name: _n, budget: _b, startDate: _s, endDate: _e, negativeLists: _l, type: _t, ...rest } = raw
      campaigns.push({ ...copied.campaign, ...(rest as Partial<BuildCampaign>) })
      continue
    }
    if (!raw.type) return { refusal: `Campaign "${raw.name}": give type (SHOPPING or SEARCH) or copyOf.` }
    if (!budget) return { refusal: `Campaign "${raw.name}": give its budget.` }
    const { copyOf: _c, budget: _b, negativeLists, ...rest } = raw
    campaigns.push({
      ...(rest as unknown as BuildCampaign),
      type: raw.type,
      budget,
      bidding: raw.bidding ?? { strategy: 'MANUAL_CPC' },
      ...(negativeLists ? { negativeLists: negativeLists.map((l) => (l.ref ? { ref: l.ref } : { listId: l.listId! })) } : {}),
    } as BuildCampaign)
  }
  return {
    spec: { sharedBudgets: (args.sharedBudgets as BuildSpec['sharedBudgets']) ?? [], negativeLists: lists, campaigns, allowBroad: args.allowBroad === true },
    notCopied,
  }
}

const buildBuilder = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const expanded = await specOf(account, args)
  if ('refusal' in expanded) return expanded
  const campaigns = await liveCampaigns(account.target)
  const budgets = await liveBudgets(account.target, campaigns)
  const lists = await liveNegativeLists(account.target)
  const draft = buildDraft(customerResource(account.target), account.currency, expanded.spec, { campaigns, budgets, lists })
  if ('refusal' in draft) return draft
  if (expanded.notCopied.length) draft.warnings.push(`Not copied (${expanded.notCopied.length}): ${expanded.notCopied.slice(0, 10).join('; ')}${expanded.notCopied.length > 10 ? ' …' : ''}.`)
  return draft
}

const buildUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveCampaigns(account.target)
    // Unchanged = every campaign it made is still there under its name.
    const holds = after.campaigns.every((c) => c.campaignId && live.some((x) => x.campaignId === c.campaignId && x.name === c.name))
    return holds ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & { accountId?: string }
    const made = (after.campaigns ?? []).filter((c) => c.campaignId)
    if (!made.length) return { refusal: 'This build does not record the campaigns it made.' }
    return {
      tool: 'remove-google-ads-items',
      args: {
        ...(after.accountId ? { accountId: after.accountId } : {}),
        items: made.map((c) => ({ kind: 'campaign', id: c.campaignId })),
        confirmRemove: true,
        why: `undo of an earlier build (its shared budgets and lists stay, unused: they spend nothing)`,
      },
    }
  },
}

const buildGoogleCampaigns: AgentTool = {
  ...common,
  name: 'build-google-campaigns',
  title: 'Build Google Ads campaigns (paused)',
  input: z.object(buildInput),
  description:
    'Build a whole Google Ads structure in the business\'s chosen account in ONE request, all or nothing: new shared '
    + 'budgets, new negative keyword lists (their keywords, or a copy of a live list), and campaigns — each ALWAYS made '
    + 'PAUSED — with budget, bidding, networks, Google\'s automation (off unless asked), locations, location option, '
    + 'languages, schedule, audiences in observation, campaign negatives and lists, ad groups with bids, keywords with '
    + 'bids (no BROAD unless allowBroad), ad-group negatives, Shopping product groups by item id ("everything else" '
    + 'excluded unless asked), responsive search ads, sitelinks, callouts and structured snippets. A campaign may be a '
    + 'copy of a live one (copyOf). Parts point at each other by ref. Use it, not a change plan, when new parts point at '
    + 'new parts. Undo removes the campaigns it made.' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildBuilder(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildBuilder(args), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

// ── copy-google-campaign ────────────────────────────────────────────────────────────────────────────────────────

const copyArgs = (args: Record<string, unknown>): Record<string, unknown> => ({
  ...(args.accountId ? { accountId: args.accountId } : {}),
  campaigns: [{
    copyOf: args.campaignId,
    name: args.name,
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.startDate ? { startDate: args.startDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
  }],
})

const copyGoogleCampaign: AgentTool = {
  ...common,
  name: 'copy-google-campaign',
  title: 'Copy a Google Ads campaign (paused)',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign to copy'),
    name: textArg(255, 'the copy\'s name (unique in the account)'),
    budget: budgetChoice.optional().describe('the copy\'s budget (default: the same shared budget, or its own budget of the same amount)'),
    startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('first day (YYYY-MM-DD)'),
    endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('last day (YYYY-MM-DD)'),
    why: googleWhyArg,
  }),
  description:
    'Copy a live Google Ads campaign (Search or Standard Shopping) of the business\'s chosen account into a NEW campaign, '
    + 'made PAUSED, in one request: settings, budget (the same shared one, or its own of the same amount), bidding, '
    + 'networks, Google\'s automation switches as they are, targeting, campaign negatives and lists, ad groups with bids '
    + 'and statuses, keywords with bids, ad-group negatives, the product group tree, responsive search ads and the '
    + 'campaign\'s sitelinks, callouts and structured snippets. What it cannot copy is named in the preview. Undo removes '
    + 'the copy.' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildBuilder(copyArgs(args))),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildBuilder(copyArgs(args)), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

// ── check-google-ads-build (read only) ─────────────────────────────────────────────────────────────────────────

/**
 * Google checks a build (validate_only) and the answer is the build's preview — nothing is asked for, nothing waits in
 * Approvals. It runs the build's own builder here (never another tool's handler: call-tool.ts is the only door).
 */
const checkGoogleAdsBuild: AgentTool = {
  name: 'check-google-ads-build',
  title: 'Check a Google Ads build (no request)',
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: BUILD_MONEY,
  input: z.object(buildInput),
  description:
    'Read only: let Google check a build WITHOUT asking for it — the same arguments as build-google-campaigns (a campaign '
    + 'may be a copy, copyOf). Nothing is queued, nothing waits in Approvals, nothing changes. The answer is the build\'s '
    + 'preview (accepted true: Google would accept every operation) or why Google or Nexus would refuse it (accepted '
    + 'false). Use it to test a whole structure before asking for it. It costs the operations of Google\'s check from '
    + 'the account\'s daily allowance.',
  async handler(args, ctx) {
    // A first request, never a re-check: the preview is built on Google's check.
    const { approvalId: _a, approvedPreview: _p, ...asked } = ctx
    const out = await googleChangePreview(args, asked as ToolContext, buildBuilder(args))
    const note = 'A check only: nothing was asked for, nothing waits in Approvals. To make it, call build-google-campaigns with the same arguments.'
    return out.ok
      ? { ok: true, data: { accepted: true, preview: out.preview, note } }
      : { ok: true, data: { accepted: false, why: out.error, note } }
  },
}

export const GOOGLE_ADS_BUILD_TOOLS: AgentTool[] = [buildGoogleCampaigns, copyGoogleCampaign, checkGoogleAdsBuild]
