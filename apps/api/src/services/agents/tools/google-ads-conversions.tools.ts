/**
 * Google Ads changes, programme 2 G8a (2026-10-15, Owner's brief "full control of Google Ads through Nexus") —
 * conversions. Every tool here is a Nexus change a person approves in Nexus; it runs as that person, never by a rule
 * (google-ads-kit.ts). Google checks each one first (validate_only: GoogleAdsService.Mutate, the Data Manager API's
 * events:ingest and UploadConversionAdjustments all have it).
 *
 *   set-google-conversion-actions     make conversion actions (website tag or imported sales) and change their category,
 *                                     primary / secondary, "include in conversions", value, counting, windows,
 *                                     attribution, name and status; undo puts the old settings back (actions it made stay)
 *   remove-google-conversion-actions  remove conversion actions for good — only when the person asked; never undone
 *   set-google-conversion-goals       which goals bid (the account's, a campaign's own), and a campaign back to the
 *                                     account's goals; undo puts them back
 *   set-google-value-rules            conversion value rules (add or multiply a value by device, location, audience) and
 *                                     their rule sets; new rules are made paused; undo puts the old actions back and
 *                                     pauses the rules it made (they stay, as does a rule set it made)
 *   upload-google-sales               send the business's Shopify sales that carry a Google click id to an "import from
 *                                     clicks" action (Data Manager API); undo retracts them
 *   adjust-google-sales               retract sales sent before or restate their value (ConversionAdjustmentUploadService,
 *                                     partial failure: Google takes or refuses each one, and the answer says which)
 *
 * Smart Bidding chases the conversions of the goals it bids for: making an action count (or count more), a goal
 * biddable, a value higher, or sales count for bidding is SPENDS MONEY, naming the enabled campaigns that bid on it.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import { googleChangeAccount, type GoogleChangeAccount } from '../../marketing/google-ads/change-account.js'
import {
  ACTION_CATEGORIES, ACTION_SETTING_KEYS, ATTRIBUTION_MODELS, actionChangeDraft, actionRecordAfterRun, actionRemoveDraft, chasersOf, COUNTING_TYPES,
  CREATABLE_TYPES, GOAL_ORIGINS, goalChangeDraft, liveSetting, MAX_CLICK_WINDOW_DAYS, MAX_VIEW_WINDOW_DAYS, SETTABLE_STATUSES,
  type ActionFields, type ActionRecord, type ActionRequest, type BiddingContext, type GoalAsk, type GoalRecord, type GoalRequest,
} from '../../marketing/google-ads/change-conversions.js'
import {
  MULTIPLY_MAX, MULTIPLY_MIN, RULE_DEVICES, valueRuleChangeDraft, valueRuleRecordAfterRun,
  type RuleFields, type ValueRuleRecord, type ValueRuleRequest,
} from '../../marketing/google-ads/change-value-rules.js'
import { liveAccountSettings, liveConversions, type LiveConversionAction, type LiveConversions } from '../../marketing/google-ads/live-account.js'
import { liveBiddingCampaigns, liveConversionActions, liveTagSnippets, liveValueRules } from '../../marketing/google-ads/live-conversions.js'
import {
  adjustDraft, adjustRecordsAfterRun, MAX_UPLOAD_ORDERS, uploadDraft, uploadWindowProblem,
  type AdjustRecord, type AdjustRequest, type UploadRecord, type UploadRequest,
} from '../../marketing/google-ads/conversion-upload.js'
import { ingestSales, salesPermissionProblem, uploadAdjustments } from '../../marketing/google-ads/conversion-upload-client.js'
import { googleSignInScopes, MAX_ORDERS_READ, nexusSales, shopifyOrdersById, shopifyOrdersForUpload, uploadInFlight } from '../../marketing/google-ads/conversion-orders.js'
import { localFailure } from '../../marketing/google-ads/errors.js'
import { notRun } from './ads-change-kit.js'
import { customerResource, GoogleAdsWriteError } from '../../marketing/google-ads/write-client.js'

const REVENUE = FIELDS.financialsRevenueView
/** Money keys of set-google-conversion-actions: its table, the settings already so and the records quote default values (what a conversion is worth). */
const ACTION_MONEY = { changes: REVENUE, skipped: REVENUE, defaultValueCents: REVENUE } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** The live conversions a change stands on, or why they cannot be read (a change never stands on a part it did not read). */
async function conversionsOf(account: GoogleChangeAccount): Promise<{ conv: LiveConversions; bidding: BiddingContext } | { refusal: string }> {
  const conv = await liveConversions(account.target)
  if (conv.notRead.length) return { refusal: `Nexus could not read the account's conversions (${conv.notRead.map((n) => n.part).join(', ')}): ${conv.notRead[0].why}` }
  const campaigns = await liveBiddingCampaigns(account.target)
  return { conv, bidding: { campaigns, goals: { accountGoals: conv.accountGoals, campaigns: conv.campaigns } } }
}

/** Whether an action's conversions count for automatic bidding now, and which enabled campaigns bid on them. */
function biddingFor(action: LiveConversionAction | undefined, bidding: BiddingContext, valueOnly = false) {
  if (!action || !action.primary || !action.includeInConversions || action.status !== 'ENABLED') return { countsForBidding: false, chasers: [] }
  const goal = `${action.category ?? '?'}/${action.origin ?? '?'}`
  const biddable = bidding.goals.accountGoals.some((g) => g.goal === goal && g.biddable) || bidding.goals.campaigns.some((c) => c.biddableGoals.includes(goal))
  return { countsForBidding: biddable, chasers: biddable ? chasersOf(bidding, goal, valueOnly) : [] }
}

// ── set-google-conversion-actions ───────────────────────────────────────────────────────────────────────────────

const settingArgs = {
  category: z.enum(ACTION_CATEGORIES).optional().describe('the goal it counts for: PURCHASE (a sale), ADD_TO_CART, BEGIN_CHECKOUT, SIGNUP, SUBMIT_LEAD_FORM, PAGE_VIEW …'),
  status: z.enum(SETTABLE_STATUSES).optional().describe('ENABLED records conversions; HIDDEN records none and is hidden in Google Ads (removing is remove-google-conversion-actions)'),
  primary: z.boolean().optional().describe('true: a primary action (counts in "Conversions" and for automatic bidding); false: secondary (observation only)'),
  includeInConversions: z.boolean().optional().describe('whether it counts in the "Conversions" column (and so for bidding)'),
  counting: z.enum(COUNTING_TYPES).optional().describe('MANY_PER_CLICK (every sale; usual for purchases) or ONE_PER_CLICK (one per click; usual for leads)'),
  clickWindowDays: z.coerce.number().int().min(1).max(MAX_CLICK_WINDOW_DAYS).optional().describe(`click-through conversion window, 1 to ${MAX_CLICK_WINDOW_DAYS} days`),
  viewWindowDays: z.coerce.number().int().min(1).max(MAX_VIEW_WINDOW_DAYS).optional().describe(`view-through conversion window, 1 to ${MAX_VIEW_WINDOW_DAYS} days`),
  attribution: z.enum(ATTRIBUTION_MODELS).optional().describe('GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN or GOOGLE_ADS_LAST_CLICK (Google retired the other rule-based models)'),
  defaultValueCents: z.coerce.number().int().min(0).max(100_000_000).optional()
    .describe('the value a conversion gets when none is sent, in minor units (cents) of defaultValueCurrency or the account\'s currency'),
  defaultValueCurrency: z.string().trim().regex(/^[A-Z]{3}$/).optional().describe('ISO 4217 code of the default value (EUR); default the account\'s currency'),
  alwaysUseDefaultValue: z.boolean().optional().describe('true: always the default value; false: the sale\'s own value when one is sent'),
}

const actionRequest = (args: Record<string, unknown>): ActionRequest => ({
  create: args.create as ActionRequest['create'],
  change: args.change as ActionRequest['change'],
})

const buildActions = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const live = await conversionsOf(account)
  if ('refusal' in live) return live
  return actionChangeDraft(customerResource(account.target), account.currency, actionRequest(args), { actions: live.conv.actions, bidding: live.bidding, customerId: account.customerId })
}

const actionsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ActionRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const actions = await liveConversionActions(account.target)
    const byId = new Map(actions.map((a) => [a.conversionActionId, a]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      actions: (after.actions ?? []).map((a) => {
        const now = byId.get(a.conversionActionId)
        const out: ActionFields = { conversionActionId: a.conversionActionId }
        for (const key of ACTION_SETTING_KEYS) if (key in a) (out as Record<string, unknown>)[key] = now ? liveSetting(now, key) ?? null : null
        return out
      }),
      created: (after.created ?? []).filter((c) => byId.has(c.conversionActionId)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<ActionRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<ActionRecord> & { accountId?: string }
    const back = (before.actions ?? []).map((a) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(a)) if (value !== null && value !== undefined) out[key] = value
      return out
    }).filter((a) => Object.keys(a).length > 1)
    if (!back.length) {
      return { refusal: (after.created ?? []).length
        ? 'This change only made conversion actions: there is nothing to put back (remove-google-conversion-actions removes them, or set status HIDDEN).'
        : 'This change records no setting it replaced that can be set again.' }
    }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-conversion-actions',
      args: { ...(accountId ? { accountId } : {}), change: back, why: `undo of an earlier conversion action change${(after.created ?? []).length ? ' (the actions it made stay)' : ''}` },
    }
  },
}

/** After a run that made website-tag actions: the tags Google gives for them (what is pasted in the shop). Never fails the change. */
async function withTags(out: ToolResult, args: Record<string, unknown>): Promise<ToolResult> {
  const data = out.data as { created?: Array<{ conversionActionId: string; type: string }> } | undefined
  const ids = (data?.created ?? []).filter((c) => c.type === 'WEBPAGE' && /^\d+$/.test(c.conversionActionId)).map((c) => c.conversionActionId)
  if (!out.ok || !ids.length) return out
  try {
    const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
    if ('refusal' in account) throw new Error(account.refusal)
    const tags = await liveTagSnippets(account.target, ids)
    return { ...out, data: { ...data, tags: ids.map((id) => ({ conversionActionId: id, snippets: tags.get(id) ?? [] })) } }
  } catch {
    return { ...out, data: { ...data, tags: `Google did not give the tags now: google-ads-query "SELECT conversion_action.id, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.id IN (${ids.join(', ')})" reads them.` } }
  }
}

const setGoogleConversionActions: AgentTool = {
  ...common,
  name: 'set-google-conversion-actions',
  title: 'Change Google Ads conversion actions',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  restrictedFields: ACTION_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      name: z.string().trim().min(1).max(100).describe('its name (unique in the account)'),
      type: z.enum(CREATABLE_TYPES).describe('WEBPAGE: the website tag records it (the answer gives the tag to paste in the shop); UPLOAD_CLICKS: sales Nexus sends (upload-google-sales)'),
      ...settingArgs,
    })).max(10).optional().describe('new conversion actions; made SECONDARY (observation only) unless primary is true'),
    change: z.array(z.object({ conversionActionId: googleIdArg('the conversion action'), name: z.string().trim().min(1).max(100).optional().describe('a new name'), ...settingArgs }))
      .max(50).optional().describe('settings of existing conversion actions (google-ads-live view conversions lists them); only what is given changes'),
    why: googleWhyArg,
  }),
  description:
    'Conversion actions of the business\'s chosen Google Ads account: make new ones (create: a website tag action, or an '
    + '"import from clicks" action that Nexus sends Shopify sales to) and change existing ones (change: name, category, '
    + 'status ENABLED / HIDDEN, primary or secondary, "include in conversions", counting, click-through and view-through '
    + 'windows, attribution model, default value and whether it is always used). A new action is made secondary unless '
    + 'the request says primary. Making an action primary or counted again, counting more (many per click, longer '
    + 'windows, another attribution or category) or a higher default value changes what automatic bidding chases and is '
    + 'marked SPENDS MONEY, naming the enabled campaigns that bid with Smart Bidding on it. Google\'s own (system) '
    + 'actions and actions of another account are refused. After it runs, a new website-tag action\'s tag snippets are in '
    + 'the answer. Undo puts the old settings back (actions it made stay; remove-google-conversion-actions removes one).'
    + GOOGLE_CHANGE_RULES,
  undo: actionsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildActions(args)),
  execute: async (args, ctx) => withTags(await runGoogleChange(args, ctx, buildActions(args), (draft, responses) => {
    const after = actionRecordAfterRun(draft.after as ActionRecord, responses)
    return { data: { created: after.created, changed: after.actions.length }, before: draft.before, after }
  }), args),
}

// ── remove-google-conversion-actions ────────────────────────────────────────────────────────────────────────────

const buildRemoveActions = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  actionRemoveDraft(customerResource(account.target), (args.conversionActionIds as string[] | undefined) ?? [], {
    actions: await liveConversionActions(account.target), customerId: account.customerId,
  })

const removeGoogleConversionActions: AgentTool = {
  ...common,
  name: 'remove-google-conversion-actions',
  title: 'Remove Google Ads conversion actions',
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    conversionActionIds: z.array(googleIdArg('a conversion action')).min(1).max(20).describe('the conversion actions to remove'),
    confirmRemove: z.literal(true).describe('true: the person asked for exactly this removal'),
    why: googleWhyArg,
  }),
  description:
    'REMOVE (delete) conversion actions of the business\'s chosen Google Ads account. Use it ONLY when the person asked '
    + 'for that removal (confirmRemove true); to stop one recording, set-google-conversion-actions status HIDDEN keeps it. '
    + 'A removed action never records again and cannot be restored (its past numbers stay in the reports); a primary one '
    + 'takes its signal away from automatic bidding (said in the preview). Google\'s own actions are refused.'
    + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRemoveActions(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRemoveActions(args), (draft) => ({ data: { removed: (draft.after as { removed: unknown[] }).removed }, before: draft.before, after: draft.after })),
}

// ── set-google-conversion-goals ─────────────────────────────────────────────────────────────────────────────────

const goalPart = {
  category: z.string().trim().regex(/^[A-Z_]{2,40}$/).describe('the goal\'s category (PURCHASE, ADD_TO_CART, … as google-ads-live view conversions lists it)'),
  origin: z.enum(GOAL_ORIGINS).describe('where it happens: WEBSITE, APP, CALL_FROM_ADS, STORE, YOUTUBE_HOSTED, GOOGLE_HOSTED or LOCAL_SERVICES_ADS'),
  biddable: z.boolean().describe('true: automatic bidding bids for this goal; false: it does not'),
}

const goalRequest = (args: Record<string, unknown>): GoalRequest => ({
  accountGoals: args.accountGoals as GoalRequest['accountGoals'],
  campaignGoals: args.campaignGoals as GoalRequest['campaignGoals'],
  useAccountGoals: args.useAccountGoals as GoalRequest['useAccountGoals'],
})

const buildGoals = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const live = await conversionsOf(account)
  if ('refusal' in live) return live
  return goalChangeDraft(customerResource(account.target), goalRequest(args), { bidding: live.bidding })
}

const goalsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as GoalRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const conv = await liveConversions(account.target)
    const goal = (g: { category: string; origin: string }) => `${g.category}/${g.origin}`
    const accountBiddable = (g: GoalAsk) => conv.accountGoals.find((a) => a.goal === goal(g))?.biddable ?? false
    const own = (id: string) => conv.campaigns.find((c) => c.campaignId === id)
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      account: (after.account ?? []).map((g) => ({ ...g, biddable: accountBiddable(g) })),
      campaigns: (after.campaigns ?? []).map((g) => ({ ...g, biddable: own(g.campaignId) ? own(g.campaignId)!.biddableGoals.includes(goal(g)) : accountBiddable(g) })),
      levels: (after.levels ?? []).map((l) => ({ campaignId: l.campaignId, goalsFrom: own(l.campaignId)?.goalsFrom ?? 'CUSTOMER' })),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<GoalRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<GoalRecord> & { accountId?: string }
    const levels = before.levels ?? []
    const following = levels.filter((l) => l.goalsFrom !== 'CAMPAIGN').map((l) => l.campaignId)
    const campaignGoals = (before.campaigns ?? []).filter((g) => !following.includes(g.campaignId))
    const accountGoals = before.account ?? []
    if (!accountGoals.length && !campaignGoals.length && !following.length) return { refusal: 'This change records no goal setting it replaced.' }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-conversion-goals',
      args: {
        ...(accountId ? { accountId } : {}),
        ...(accountGoals.length ? { accountGoals } : {}),
        ...(campaignGoals.length ? { campaignGoals } : {}),
        ...(following.length ? { useAccountGoals: following } : {}),
        why: 'undo of an earlier conversion goal change',
      },
    }
  },
}

const setGoogleConversionGoals: AgentTool = {
  ...common,
  name: 'set-google-conversion-goals',
  title: 'Change Google Ads conversion goals',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.adsBidsEdit],
  input: z.object({
    accountId: googleAccountArg,
    accountGoals: z.array(z.object(goalPart)).max(50).optional().describe('the account\'s goals: which ones every campaign that follows the account\'s goals bids for'),
    campaignGoals: z.array(z.object({ campaignId: googleIdArg('the campaign'), ...goalPart })).max(250).optional()
      .describe('a campaign\'s own goals (the campaign then stops following the account\'s goals)'),
    useAccountGoals: z.array(googleIdArg('a campaign')).max(100).optional().describe('campaigns that go back to following the account\'s goals'),
    why: googleWhyArg,
  }),
  description:
    'Conversion goals of the business\'s chosen Google Ads account (a goal = a category from an origin, e.g. PURCHASE from '
    + 'WEBSITE): make an account goal biddable or not (accountGoals: every campaign that follows the account\'s goals), '
    + 'give a campaign goals of its own (campaignGoals), or put campaigns back on the account\'s goals (useAccountGoals). '
    + 'A goal made biddable for campaigns that bid with Smart Bidding is marked SPENDS MONEY, naming them; one made not '
    + 'biddable is a warning (bidding stops counting it). Google makes goals from conversion actions: '
    + 'google-ads-live view conversions lists them. Undo puts the old goals back (a custom goal a campaign used is not '
    + 'given back).' + GOOGLE_CHANGE_RULES,
  undo: goalsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildGoals(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildGoals(args), (draft) => ({ data: { totals: draft.totals }, before: draft.before, after: draft.after })),
}

// ── set-google-value-rules ──────────────────────────────────────────────────────────────────────────────────────

const ruleAction = {
  add: googleCentsArg('ADD: the amount added to each matching conversion\'s value').optional(),
  multiply: z.coerce.number().min(MULTIPLY_MIN).max(MULTIPLY_MAX).optional().describe(`MULTIPLY: the factor, ${MULTIPLY_MIN} to ${MULTIPLY_MAX} (1.2 = 20 % more)`),
}
const geoIds = (what: string) => z.array(z.string().trim().regex(/^\d{1,20}$/)).max(50).describe(`${what}: Google's geo target ids (2380 = Italy)`)

const valueRuleRequest = (args: Record<string, unknown>): ValueRuleRequest => ({
  create: args.create as ValueRuleRequest['create'],
  change: args.change as ValueRuleRequest['change'],
})

const buildValueRules = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const { rules, sets } = await liveValueRules(account.target)
  const campaigns = await liveBiddingCampaigns(account.target)
  return valueRuleChangeDraft(customerResource(account.target), account.currency, valueRuleRequest(args), { rules, sets, campaigns })
}

const ruleFieldsNow = (r: RuleFields, now: { operation: string | null; value: number | null; status: string | null } | undefined): RuleFields => {
  const out: RuleFields = { valueRuleId: r.valueRuleId }
  if ('operation' in r) out.operation = now?.operation ?? null
  if ('addCents' in r) out.addCents = now?.operation === 'ADD' && now.value !== null ? Math.round(now.value * 100) : null
  if ('multiply' in r) out.multiply = now?.operation === 'MULTIPLY' ? now.value : null
  if ('status' in r) out.status = now?.status ?? null
  return out
}

const valueRulesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ValueRuleRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const { rules } = await liveValueRules(account.target)
    const byId = new Map(rules.map((r) => [r.valueRuleId, r]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      rules: (after.rules ?? []).map((r) => ruleFieldsNow(r, byId.get(r.valueRuleId))),
      created: (after.created ?? []).filter((c) => byId.has(c.valueRuleId)).map((c) => ({ valueRuleId: c.valueRuleId, status: byId.get(c.valueRuleId)!.status ?? c.status })),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<ValueRuleRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<ValueRuleRecord> & { accountId?: string }
    if ((after.created ?? []).some((c) => !/^\d+$/.test(c.valueRuleId))) return { refusal: 'This change does not record the id of a rule it made.' }
    const back = (before.rules ?? []).map((r) => ({
      valueRuleId: r.valueRuleId,
      ...(r.operation === 'ADD' && typeof r.addCents === 'number' ? { add: r.addCents } : {}),
      ...(r.operation === 'MULTIPLY' && typeof r.multiply === 'number' ? { multiply: r.multiply } : {}),
      ...(r.status === 'ENABLED' || r.status === 'PAUSED' ? { status: r.status } : {}),
    })).filter((r) => Object.keys(r).length > 1)
    // A rule it made and enabled is paused again (Google keeps it; paused, it changes no value).
    const pause = (after.created ?? []).filter((c) => c.status === 'ENABLED').map((c) => ({ valueRuleId: c.valueRuleId, status: 'PAUSED' as const }))
    const changes = [...back, ...pause]
    if (!changes.length) return { refusal: 'This change only made paused rules: there is nothing to put back (a paused rule changes no value).' }
    const accountId = after.accountId ?? before.accountId
    return { tool: 'set-google-value-rules', args: { ...(accountId ? { accountId } : {}), change: changes, why: 'undo of an earlier conversion value rule change' } }
  },
}

const setGoogleValueRules: AgentTool = {
  ...common,
  name: 'set-google-value-rules',
  title: 'Change Google Ads conversion value rules',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.adsBidsEdit, REVENUE],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      ...ruleAction,
      devices: z.array(z.enum(RULE_DEVICES)).max(3).optional().describe('condition: the device of the click (MOBILE, DESKTOP, TABLET)'),
      locations: z.object({
        include: geoIds('the locations it applies to'),
        exclude: geoIds('the locations it does not apply to').optional(),
        presenceOnly: z.boolean().optional().describe('true: people IN the location only; false: in it or interested in it'),
      }).optional().describe('condition: where the person is'),
      audiences: z.object({
        userLists: z.array(z.string().trim().regex(/^\d{1,20}$/)).max(50).optional().describe('user list ids (google-ads-live view lookup)'),
        userInterests: z.array(z.string().trim().regex(/^\d{1,20}$/)).max(50).optional().describe('user interest ids'),
      }).optional().describe('condition: the audiences the person is in'),
      campaignId: googleIdArg('the campaign whose rule set holds it (default: the account\'s rule set)').optional(),
      enable: z.boolean().optional().describe('true: it applies at once (SPENDS MONEY when it raises values); otherwise it is made PAUSED'),
    })).max(20).optional().describe('new value rules (one action, one or two conditions of devices, locations, audiences)'),
    change: z.array(z.object({
      valueRuleId: googleIdArg('the value rule'),
      ...ruleAction,
      status: z.enum(['ENABLED', 'PAUSED']).optional().describe('ENABLED applies it; PAUSED stops it'),
    })).max(50).optional().describe('existing rules: a new action, or enable / pause'),
    why: googleWhyArg,
  }),
  description:
    'Conversion value rules of the business\'s chosen Google Ads account: make rules that add an amount to, or multiply, '
    + 'the value of conversions by device, location or audience (in the account\'s rule set, or a campaign\'s), change a '
    + 'rule\'s action, enable or pause rules. New rules are made PAUSED unless the request says enable. A rule that '
    + 'raises values and is enabled or raised — and pausing a rule that multiplied below 1 — makes value bidding (target '
    + 'ROAS, maximize conversion value) bid for higher values: SPENDS MONEY, naming those campaigns; only a real fall is '
    + 'said to lower values. Google\'s "set a value" rules and travel conditions are not offered (allowlisted accounts '
    + 'only). Undo puts the old actions and statuses back and pauses the rules it made enabled; what it made stays: those '
    + 'rules (paused) and any rule set it made, with them in it.' + GOOGLE_CHANGE_RULES,
  undo: valueRulesUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildValueRules(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildValueRules(args), (draft, responses) => {
    const after = valueRuleRecordAfterRun(draft.after as ValueRuleRecord, responses)
    return { data: { created: after.created, changed: after.rules.length, ruleSets: after.ruleSets ?? [] }, before: draft.before, after }
  }),
}

// ── upload-google-sales ─────────────────────────────────────────────────────────────────────────────────────────

const uploadRequest = (args: Record<string, unknown>): UploadRequest => ({
  conversionActionId: String(args.conversionActionId ?? ''),
  from: args.from as string | undefined,
  to: args.to as string | undefined,
  orderIds: args.orderIds as string[] | undefined,
  value: (args.value as UploadRequest['value'] | undefined) ?? 'total',
  enhanced: args.enhanced === true,
  withoutClickId: args.withoutClickId === true,
  adUserDataConsent: args.adUserDataConsent as UploadRequest['adUserDataConsent'],
})

const buildUpload = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = uploadRequest(args)
  const now = new Date()
  const problem = uploadWindowProblem(request, now)
  if (problem) return { refusal: problem }
  // A sign-in made before Nexus asked for the Data Manager permission: said before anything is read from Google.
  const permission = salesPermissionProblem(await googleSignInScopes(account.target.connectionId))
  if (permission) return { refusal: permission }
  const settings = await liveAccountSettings(account.target)
  if (!settings) return { refusal: 'Google did not answer with the account\'s conversion settings.' }
  const live = await conversionsOf(account)
  if ('refusal' in live) return live
  const { orders, tooMany } = await shopifyOrdersForUpload(request)
  if (tooMany) return { refusal: `Nexus has more than ${MAX_ORDERS_READ} Shopify orders in these days: send fewer days at a time.` }
  const sales = await nexusSales(account.customerId)
  const action = live.conv.actions.find((a) => a.conversionActionId === request.conversionActionId)
  const { countsForBidding, chasers } = biddingFor(action, live.bidding)
  return uploadDraft(request, {
    customerId: account.customerId,
    currency: account.currency,
    actions: live.conv.actions,
    conversionCustomerId: settings.conversionTracking.conversionCustomerId,
    acceptedCustomerDataTerms: settings.conversionTracking.acceptedCustomerDataTerms,
    orders,
    alreadySent: sales.sent,
    chasers,
    countsForBidding,
    now,
  })
}

/** The Data Manager API checks (validateOnly) and sends; what it answered is kept for the run's answer. */
function uploadSender(args: Record<string, unknown>, answer: { requestId: string | null; warnings: string[] } = { requestId: null, warnings: [] }): GoogleSender {
  const id = String(args.conversionActionId ?? '')
  return {
    notChecked: '',
    destination: `conversionActions/${id}`,
    check: (target, events) => ingestSales(target, id, events, { validateOnly: true }),
    send: async (target, events) => {
      const out = await ingestSales(target, id, events, { validateOnly: false })
      answer.requestId = out.requestId
      answer.warnings = out.warnings
      return { responses: [] }
    },
  }
}

/** Undo of an upload: ask Google to retract the sales it sent (a retraction counts the sale 0, for good). */
const uploadUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as UploadRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    // Google gives no per-sale read-back: what Nexus sent is what its record says (a later retraction is skipped by
    // adjust-google-sales itself).
    return { ...after, accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Partial<UploadRecord> & { accountId?: string }
    const sent = (after.sent ?? []).map((s) => s.orderId)
    if (!after.conversionActionId || !sent.length) return { refusal: 'This change records no sale it sent.' }
    return {
      tool: 'adjust-google-sales',
      args: { ...(after.accountId ? { accountId: after.accountId } : {}), conversionActionId: after.conversionActionId, retract: sent, why: 'undo of an earlier upload of Shopify sales (retracted: they count 0)' },
    }
  },
}

const uploadGoogleSales: AgentTool = {
  ...common,
  name: 'upload-google-sales',
  title: 'Send Shopify sales to Google Ads',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.ordersView, REVENUE],
  input: z.object({
    accountId: googleAccountArg,
    conversionActionId: googleIdArg('the "import from clicks" (UPLOAD_CLICKS) conversion action the sales go to'),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the first day whose sales are sent (YYYY-MM-DD, UTC; at most 89 days ago)'),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the last day (YYYY-MM-DD, UTC; before today)'),
    orderIds: z.array(z.string().trim().min(1).max(64)).max(MAX_UPLOAD_ORDERS).optional().describe('or: the Shopify (or Nexus) order ids to send, instead of days'),
    value: z.enum(['total', 'subtotal']).optional().describe('the sale\'s value: total (Shopify\'s current total, after refunds) or subtotal (after discounts, without shipping and tax); default total'),
    enhanced: z.boolean().optional().describe('true: also send the buyer\'s email and phone, HASHED (SHA-256) as Google asks, to match more sales (enhanced conversions); needs adUserDataConsent GRANTED'),
    withoutClickId: z.boolean().optional().describe('with enhanced: also send sales whose visit carried no Google click id (matched from the hashed contact only)'),
    adUserDataConsent: z.enum(['GRANTED', 'DENIED']).optional().describe('the buyers\' consent to share their data with Google for ads, as the shop collected it (EU user consent policy)'),
    why: googleWhyArg,
  }),
  description:
    'Send the business\'s own Shopify sales (Nexus orders) to an "import from clicks" conversion action of its chosen '
    + 'Google Ads account, so Google counts them for the ads that brought them. Only orders whose landing page carried a '
    + 'Google click id (gclid, gbraid or wbraid) are sent, unless enhanced and withoutClickId say otherwise; test, '
    + 'cancelled and refunded orders and orders Nexus sent before are left out (the preview names them). Nothing personal '
    + 'is sent unless enhanced is true: then only the buyer\'s email and phone, normalised and hashed (SHA-256) as Google '
    + 'asks, never in plain text, and only with the buyers\' consent. Sales go through Google\'s Data Manager API (Google '
    + 'closed the Google Ads API\'s click-conversion upload to new users); Google checks them first (validateOnly) and '
    + 'refuses the whole request if one is wrong, then matches them to clicks in the background: Google gives no answer per '
    + 'sale, only counts per reason (Google Ads › Goals › Diagnostics; the answer gives Google\'s request id). Google takes '
    + 'nothing until Nexus\'s Google sign-in carries the Data Manager permission (a sign-in made before Nexus asked for it '
    + 'lacks it: a person signs in to Google again in Nexus once) and the Data Manager API is on in Nexus\'s Google Cloud '
    + 'project: the preview says so when either is missing. Sales that count for automatic bidding are marked '
    + 'SPENDS MONEY. Sending cannot be taken back; undo retracts the sales (adjust-google-sales).'
    + GOOGLE_CHANGE_RULES,
  undo: uploadUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildUpload(args), uploadSender(args)),
  execute: async (args, ctx) => {
    // Never two uploads at once: the sales already sent are read again below, after this run's claim (uploadInFlight).
    const busy = ctx.approvalId ? await uploadInFlight(ctx.approvalId) : null
    if (busy) return notRun(`Not run: another upload of sales to Google is running in this business (${busy}). Nothing was sent. Approve this again once it has finished: Nexus then leaves out the sales it sent.`)
    const answer = { requestId: null as string | null, warnings: [] as string[] }
    return runGoogleChange(args, ctx, buildUpload(args), (draft) => {
      const after: UploadRecord = { ...(draft.after as UploadRecord), requestId: answer.requestId }
      return {
        data: { sent: after.sent.length, requestId: answer.requestId, ...(answer.warnings.length ? { googleWarnings: answer.warnings } : {}), next: 'Google matches them to clicks within hours: Google Ads › Goals › Diagnostics shows what it took.' },
        before: draft.before,
        after,
      }
    }, uploadSender(args, answer))
  },
}

// ── adjust-google-sales ─────────────────────────────────────────────────────────────────────────────────────────

const adjustRequest = (args: Record<string, unknown>): AdjustRequest => ({
  conversionActionId: String(args.conversionActionId ?? ''),
  retract: args.retract as string[] | undefined,
  restate: args.restate as AdjustRequest['restate'],
})

const buildAdjust = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = adjustRequest(args)
  const live = await conversionsOf(account)
  if ('refusal' in live) return live
  const ids = [...(request.retract ?? []), ...(request.restate ?? []).map((r) => r.orderId)]
  const orders = await shopifyOrdersById(ids)
  const sales = await nexusSales(account.customerId)
  const actionId = request.conversionActionId
  const known = new Map<string, { valueCents: number; currency: string }>()
  for (const id of ids) {
    const v = sales.value.get(`${actionId}:${id}`)
    if (v) known.set(id, v)
  }
  const action = live.conv.actions.find((a) => a.conversionActionId === actionId)
  const { countsForBidding, chasers } = biddingFor(action, live.bidding, true)
  return adjustDraft(customerResource(account.target), request, {
    actions: live.conv.actions,
    currency: account.currency,
    orders,
    sentHere: new Set(ids.filter((id) => sales.sent.get(id) === actionId)),
    retracted: new Set(ids.filter((id) => sales.retracted.has(`${actionId}:${id}`))),
    known,
    chasers,
    countsForBidding,
  })
}

/** Google's check of adjustments (validate_only with partial failure): any one it would refuse refuses the preview, named. */
async function checkAdjustments(target: Parameters<typeof uploadAdjustments>[0], adjustments: Array<Record<string, unknown>>): Promise<void> {
  const { results } = await uploadAdjustments(target, adjustments, { validateOnly: true })
  const refused = results.flatMap((r, i) => ('why' in r ? [`order ${String(adjustments[i]?.orderId ?? i)}: ${r.why}`] : []))
  if (refused.length) {
    const sentence = `Google would refuse ${refused.length} of the ${adjustments.length} adjustments: ${refused.slice(0, 10).join('; ')}${refused.length > 10 ? ' …' : ''}. Leave them out and ask again. Nothing was sent.`
    throw new GoogleAdsWriteError(localFailure(sentence, 'ADJUSTMENT_REFUSED'), 'ads.conversionAdjustments.check', 'refused')
  }
}

function adjustSender(results: { list: Array<{ ok: true } | { ok: false; why: string }> } = { list: [] }): GoogleSender {
  return {
    notChecked: '',
    check: (target, adjustments) => checkAdjustments(target, adjustments),
    send: async (target, adjustments) => {
      results.list = (await uploadAdjustments(target, adjustments, { validateOnly: false })).results
      return { responses: [] }
    },
  }
}

/** Undo of an adjustment: restatements go back to the value Nexus gave Google before; a retraction is for good. */
const adjustUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AdjustRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    return { ...after, accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<AdjustRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<AdjustRecord> & { accountId?: string }
    const restated = before.restated ?? []
    if (!restated.length) return { refusal: 'A retracted sale counts 0 for good: Google cannot restate it, and its order id cannot be sent again.' }
    const unknown = restated.filter((r) => typeof r.valueCents !== 'number' || r.valueCents <= 0)
    if (unknown.length) return { refusal: `Nexus does not know the value Google had for ${unknown.map((r) => r.orderId).slice(0, 10).join(', ')} before (Nexus did not send it): restate it by hand.` }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'adjust-google-sales',
      args: {
        ...(accountId ? { accountId } : {}),
        conversionActionId: after.conversionActionId ?? before.conversionActionId,
        restate: restated.map((r) => ({ orderId: r.orderId, valueCents: r.valueCents as number })),
        why: `undo of an earlier restatement of sales${(after.retracted ?? []).length ? ' (the retracted ones stay retracted: Google cannot take a retraction back)' : ''}`,
      },
    }
  },
}

const adjustGoogleSales: AgentTool = {
  ...common,
  name: 'adjust-google-sales',
  title: 'Retract or restate sales in Google Ads',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, F.ordersView, REVENUE],
  input: z.object({
    accountId: googleAccountArg,
    conversionActionId: googleIdArg('the conversion action that recorded the sales'),
    retract: z.array(z.string().trim().regex(/^[A-Za-z0-9_\-]{1,64}$/)).max(MAX_UPLOAD_ORDERS).optional()
      .describe('Shopify order ids whose sale Google should count as 0 (refunded, cancelled, sent by mistake)'),
    restate: z.array(z.object({
      orderId: z.string().trim().regex(/^[A-Za-z0-9_\-]{1,64}$/).describe('the Shopify order id'),
      valueCents: googleCentsArg('the sale\'s new value'),
    })).max(MAX_UPLOAD_ORDERS).optional().describe('sales whose value Google should change (e.g. after a partial refund)'),
    why: googleWhyArg,
  }),
  description:
    'Correct sales a Google Ads conversion action of the business\'s chosen account recorded, named by their Shopify order '
    + 'id (the business\'s own Nexus orders only): retract them (they count 0, for good) or restate their value. Google '
    + 'checks them first (validate_only): one it would refuse refuses the preview, named. When it runs, Google takes or '
    + 'refuses each adjustment on its own (partial failure, as Google requires) and the answer says which, with Google\'s '
    + 'reason. A restated value on an action that counts for automatic bidding is marked SPENDS MONEY. Undo restates '
    + 'sales to the value Nexus gave Google before; a retraction cannot be undone.' + GOOGLE_CHANGE_RULES,
  undo: adjustUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAdjust(args), adjustSender()),
  execute: (args, ctx: ToolContext) => {
    const results = { list: [] as Array<{ ok: true } | { ok: false; why: string }> }
    return runGoogleChange(args, ctx, buildAdjust(args), (draft) => {
      const out = adjustRecordsAfterRun({ before: draft.before as AdjustRecord, after: draft.after as AdjustRecord }, results.list)
      return {
        data: { taken: out.after.retracted.length + out.after.restated.length, retracted: out.after.retracted, restated: out.after.restated.map((r) => r.orderId), refused: out.refused },
        before: out.before,
        after: out.after,
      }
    }, adjustSender(results))
  },
}

export const GOOGLE_ADS_CONVERSIONS_TOOLS: AgentTool[] = [
  setGoogleConversionActions, removeGoogleConversionActions, setGoogleConversionGoals, setGoogleValueRules, uploadGoogleSales, adjustGoogleSales,
]
