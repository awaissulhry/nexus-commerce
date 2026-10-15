/**
 * Google Ads changes (2026-10-15) — google-ads-live: what the business's Google Ads account holds NOW, read from Google
 * (marketing/google-ads/live.ts, live-account.ts), so a change can be planned on it and checked after it ran. Read only.
 * Each view costs one or a few operations of the account's daily Google Ads allowance.
 *
 * Programme 2, G1 (2026-10-15) adds, all read only:
 *   - google-ads-live views account, conversions, labels, experiments, users, billing, links, and lookups of the
 *     account's own user lists, custom audiences and combined audiences (live-account.ts);
 *   - google-ads-numbers: numbers LIVE from Google for a window that may include today, at any level, split by day,
 *     hour, day of week, device or network (live-numbers.ts);
 *   - google-ads-query: one GAQL SELECT a caller writes, on this business's account only, LIMIT ≤ 1,000
 *     (live-query.ts) — the catch-all, so no read is ever missing.
 * Review (2026-10-15): views bid-strategies and auto-apply; product-groups reads every Shopping dimension
 * (live-views.ts); every Google call of these tools draws on their own allowance (asLiveRead: ops-budget.ts
 * LIVE_ACCOUNT_DAILY_OPS), never the changes'. People's e-mail addresses (change history, users, a query on them) need
 * users.manage; the spend ranking, billing and Google's cost / profit / revenue metrics need their money permissions.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'
import { googleAccountArg, googleIdArg } from './google-ads-kit.js'
import { googleChangeAccount, type GoogleChangeAccount } from '../../marketing/google-ads/change-account.js'
import { GoogleAdsReadError } from '../../marketing/google-ads/errors.js'
import { customerIdDigits } from '../../marketing/google-ads/mappers.js'
import { asLiveRead, liveRows } from '../../marketing/google-ads/write-client.js'
import {
  liveAds, liveAssets, liveBudgets, liveCampaignDetail, liveCampaigns, liveChangeHistory, liveDrafts, liveNegativeLists,
} from '../../marketing/google-ads/live.js'
import { liveAutoApply, liveBidStrategies, liveCampaignProductGroups } from '../../marketing/google-ads/live-views.js'
import { liveLookup, type LookupKind } from '../../marketing/google-ads/live-campaigns.js'
import {
  liveAccountLookup, liveAccountSettings, liveBilling, liveConversions, liveExperiments, liveLabels, liveLinks, liveUsers, type AccountLookupKind,
} from '../../marketing/google-ads/live-account.js'
import {
  liveNumbers, MAX_NUMBER_ROWS, NUMBER_LEVEL_SPECS, NUMBER_LEVELS, NUMBER_ORDERS, NUMBER_SEGMENTS, numbersTotals, numbersWindow,
  type NumberLevel, type NumberOrder, type NumberSegment,
} from '../../marketing/google-ads/live-numbers.js'
import { checkedQuery, DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS, type QueryNeed } from '../../marketing/google-ads/live-query.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' answers (some are in the shared registry too; named here so each tool states its own). */
const LIVE_MONEY = {
  amountCents: ADSPEND, cpcBidCents: ADSPEND, effectiveCpcBidCents: ADSPEND, bidCents: ADSPEND, maxCpcCeilingCents: ADSPEND,
  // G1 — numbers: cost, value and the ratios built on them.
  spendCents: ADSPEND, avgCpcCents: ADSPEND, conversionValueCents: ADSPEND, costPerConversionCents: ADSPEND, roas: ADSPEND,
  // G1 — a conversion action's default value; the account budget's limits and what it served.
  defaultValueCents: ADSPEND, spendingLimitCents: ADSPEND, adjustedSpendingLimitCents: ADSPEND, amountServedCents: ADSPEND, adjustmentsCents: ADSPEND,
  // Review — bid strategy targets and floors (a campaign's own targets in view campaign too).
  targetCpaCents: ADSPEND, targetRoas: ADSPEND, cpcFloorCents: ADSPEND,
} as const

/** The caller may see ad spend: the ad-spend permission, or every money permission. */
const seesSpend = (ctx: ToolContext) => ctx.can(ADSPEND) || ctx.can(FIELDS.financialsView)

export const GOOGLE_LIVE_VIEWS = [
  'campaigns', 'campaign', 'budgets', 'negative-lists', 'product-groups', 'ads', 'assets', 'change-history', 'drafts', 'lookup',
  'account', 'conversions', 'labels', 'experiments', 'users', 'billing', 'links', 'bid-strategies', 'auto-apply',
] as const
type LiveView = typeof GOOGLE_LIVE_VIEWS[number]
const NEEDS_CAMPAIGN: readonly LiveView[] = ['campaign', 'product-groups', 'ads']
const MAX_CHANGES = 200
const GOOGLE_LOOKUPS = ['locations', 'languages', 'audiences'] as const
const ACCOUNT_LOOKUPS = ['user-lists', 'custom-audiences', 'combined-audiences', 'life-events'] as const
const LOOKUPS = [...GOOGLE_LOOKUPS, ...ACCOUNT_LOOKUPS] as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const SOURCE = 'Read live from Google now (not the daily read). Amounts are minor units (cents) of the account currency.'

function accountOf(account: GoogleChangeAccount) {
  return { accountId: account.accountId, customerId: account.customerId, name: account.name, currency: account.currency, timeZone: account.timeZone }
}

/** A refusal Google or the allowance gave, or a request that names no Google id: an answer, not a crash. */
function readFailure(err: unknown): ToolResult | null {
  if (err instanceof GoogleAdsReadError) return { ok: false, error: err.message }
  if (err instanceof Error && /Nothing was sent/.test(err.message)) return { ok: false, error: err.message }
  return null
}

const notReadOf = (notRead: Array<{ part: string; why: string }>) => (notRead.length ? { notRead } : {})

// ── google-ads-live ──────────────────────────────────────────────────────────────────────────────────────────────

async function liveView(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const view = args.view as LiveView
  const campaignId = text(args.campaignId)
  if (NEEDS_CAMPAIGN.includes(view) && !campaignId) return { ok: false, error: `view ${view} needs campaignId (view campaigns lists them).` }
  // The people with access to the Google Ads account are named by e-mail: the same permission as Nexus's own team list.
  if (view === 'users' && !ctx.can(F.usersManage)) {
    return { ok: false, error: `view users lists the e-mail addresses of the people with access to the Google Ads account: it needs the ${F.usersManage} permission.` }
  }
  // Billing names the payments account and profile and the account budget's limits: the ad-spend permission.
  if (view === 'billing' && !seesSpend(ctx)) {
    return { ok: false, error: `view billing shows the payments account and the account budget: it needs the ${ADSPEND} permission.` }
  }
  const account = await googleChangeAccount(text(args.accountId) ?? null)
  if ('refusal' in account) return { ok: false, error: account.refusal }
  const base = { account: accountOf(account), view, readAt: new Date().toISOString(), source: SOURCE }
  try {
    switch (view) {
      case 'campaigns': {
        const items = await liveCampaigns(account.target)
        return { ok: true, data: { ...base, items, total: items.length } }
      }
      case 'campaign': {
        const detail = await liveCampaignDetail(account.target, campaignId!)
        if (!detail) return { ok: false, error: `Campaign ${campaignId} is not in this account (or it is removed).` }
        return { ok: true, data: { ...base, ...detail } }
      }
      case 'budgets': {
        const items = await liveBudgets(account.target)
        return { ok: true, data: { ...base, items, total: items.length } }
      }
      case 'negative-lists': {
        const listId = text(args.listId)
        const items = await liveNegativeLists(account.target, listId)
        if (listId && !items.some((l) => l.listId === listId)) return { ok: false, error: `Negative keyword list ${listId} is not in this account (or it is removed).` }
        return { ok: true, data: { ...base, items, total: items.length, ...(listId ? {} : { note: 'Name one list (listId) for its keywords.' }) } }
      }
      case 'product-groups': {
        // Every Shopping dimension (condition, category, channel … too): a node of another dimension is never read as "everything else".
        const items = await liveCampaignProductGroups(account.target, campaignId!)
        const open = items.filter((g) => g.everythingElse && !g.excluded && g.kind === 'UNIT')
        return {
          ok: true,
          data: {
            ...base, campaignId, items, total: items.length,
            ...(open.length ? { warning: `${open.length} "everything else" product group${open.length === 1 ? ' is' : 's are'} NOT excluded: the campaign can advertise every other product of the feed under it.` } : {}),
          },
        }
      }
      case 'ads': {
        const items = await liveAds(account.target, campaignId!)
        return { ok: true, data: { ...base, campaignId, items, total: items.length } }
      }
      case 'assets': {
        const items = await liveAssets(account.target, campaignId)
        return { ok: true, data: { ...base, ...(campaignId ? { campaignId } : {}), items, total: items.length } }
      }
      case 'change-history': {
        const day = text(args.day) ?? new Intl.DateTimeFormat('en-CA', { timeZone: account.timeZone ?? 'UTC' }).format(new Date())
        const all = await liveChangeHistory(account.target, day)
        // Who made a change is an e-mail address: shown with the users permission; otherwise only that a person did.
        const showsPeople = ctx.can(F.usersManage)
        const items = all.slice(0, MAX_CHANGES).map((c) => (showsPeople ? c : { ...c, by: c.by ? 'a person' : null }))
        return {
          ok: true,
          data: {
            ...base, day, items, total: all.length,
            ...(all.length > items.length ? { truncated: `Showing the newest ${items.length} of ${all.length} changes.` } : {}),
            note: `Google keeps 30 days of change history; a change can take up to 3 minutes to appear.${showsPeople ? '' : ` Who made each change (an e-mail address) needs the ${F.usersManage} permission; client says through what (the Google Ads website, the API …).`}`,
          },
        }
      }
      case 'lookup': {
        const kind = args.lookup as LookupKind | AccountLookupKind | undefined
        const search = text(args.search) ?? ''
        if (kind && (ACCOUNT_LOOKUPS as readonly string[]).includes(kind)) {
          const items = await liveAccountLookup(account.target, kind as AccountLookupKind, search || null)
          return {
            ok: true,
            data: {
              ...base, lookup: kind, ...(search ? { search } : {}), items, total: items.length,
              note: kind === 'life-events'
                ? 'Google\'s life events, at most 200: their ids are what the audience tools take as LIFE_EVENT; channels says where each can serve (ALL = every channel).'
                : 'This account\'s own audiences (enabled), at most 200: their ids are what the targeting tools take.',
            },
          }
        }
        if (!kind || !search) return { ok: false, error: 'view lookup needs lookup (locations, languages, audiences, user-lists, custom-audiences, combined-audiences or life-events) and, for the first three, search (a word of the name).' }
        const items = await liveLookup(account.target, kind as LookupKind, search)
        return { ok: true, data: { ...base, lookup: kind, search, items, total: items.length, note: 'Google\'s own ids: pass them to create-google-campaign or set-google-targeting.' } }
      }
      case 'drafts': {
        const items = await liveDrafts(account.target)
        return {
          ok: true,
          data: { ...base, items, total: items.length, note: 'Campaign drafts (Drafts & experiments). The "Drafts in progress" of Google\'s campaign creation pages are not in the Google Ads API.' },
        }
      }
      case 'account': {
        const settings = await liveAccountSettings(account.target)
        if (!settings) return { ok: false, error: 'Google Ads answered no account row for this account.' }
        return {
          ok: true,
          data: {
            ...base, settings,
            note: 'Auto-tagging adds gclid to ad clicks (Google Analytics and sales imports need it). The tracking template and final URL suffix apply to every ad unless a campaign, ad group, keyword or ad sets its own.',
          },
        }
      }
      case 'conversions': {
        const read = await liveConversions(account.target)
        return {
          ok: true,
          data: {
            ...base, actions: read.actions, total: read.actions.length, accountGoals: read.accountGoals, campaigns: read.campaigns, ...notReadOf(read.notRead),
            note: 'A primary conversion action counts in "Conversions" and in bidding; a secondary one only observes. A campaign bids for the account\'s biddable goals unless it sets its own (differsFromAccount).',
          },
        }
      }
      case 'labels': {
        const labelId = text(args.labelId)
        const read = await liveLabels(account.target, labelId)
        if (labelId && !read.labels.some((l) => l.labelId === labelId)) return { ok: false, error: `Label ${labelId} is not in this account (or it is removed).` }
        return {
          ok: true,
          data: { ...base, labels: read.labels, total: read.labels.length, ...(read.usedOn ? { labelId, usedOn: read.usedOn } : { note: 'Name one label (labelId) for the campaigns, ad groups, ads and keywords that carry it.' }), ...notReadOf(read.notRead) },
        }
      }
      case 'experiments': {
        const read = await liveExperiments(account.target)
        return { ok: true, data: { ...base, items: read.experiments, total: read.experiments.length, ...notReadOf(read.notRead) } }
      }
      case 'users': {
        const read = await liveUsers(account.target)
        return {
          ok: true,
          data: {
            ...base, users: read.users, invitations: read.invitations, ...notReadOf(read.notRead),
            note: 'Roles: ADMIN, STANDARD (can change the account), READ_ONLY, EMAIL_ONLY. Nexus\'s Google sign-in needs STANDARD or ADMIN to make changes.',
          },
        }
      }
      case 'billing': {
        const read = await liveBilling(account.target)
        return {
          ok: true,
          data: {
            ...base, setups: read.setups, accountBudgets: read.accountBudgets, ...notReadOf(read.notRead),
            note: 'Google lists an account budget only where the account has one (often monthly invoicing); none does not mean there is no payment method. No Google Ads API reads or adds a payment card.',
          },
        }
      }
      case 'bid-strategies': {
        const items = await liveBidStrategies(account.target)
        return {
          ok: true,
          data: {
            ...base, items, total: items.length,
            note: 'Portfolio bid strategies (shared by campaigns). TARGET_SPEND is Maximize clicks; targetRoas 4 = 400%; impressionShare.targetPct is the share of impressions it aims for.',
          },
        }
      }
      case 'auto-apply': {
        const items = await liveAutoApply(account.target)
        return {
          ok: true,
          data: {
            ...base, items, total: items.length,
            note: 'ENABLED: Google applies this kind of recommendation by itself, without a person. PAUSED: it no longer does. A kind not listed was never switched on.',
          },
        }
      }
      case 'links': {
        const read = await liveLinks(account.target)
        return {
          ok: true,
          data: {
            ...base, productLinks: read.productLinks, invitations: read.invitations, youtube: read.youtube, ga4Properties: read.ga4Properties, ...notReadOf(read.notRead),
            note: 'Merchant Center and other Google Ads accounts: product links. YouTube: video data links. Google Analytics 4 links are not in the Google Ads API (Analytics keeps them); ga4Properties are the GA4 properties this account\'s GA4 conversion actions come from.',
          },
        }
      }
    }
  } catch (err) {
    const failure = readFailure(err)
    if (failure) return failure
    throw err
  }
  return { ok: false, error: `Unknown view ${String(view)}.` }
}

const googleAdsLive: AgentTool = {
  name: 'google-ads-live',
  title: 'Google Ads, live from Google',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  // It reads Google live (no change): Claude is told it reaches outside Nexus.
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: LIVE_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(GOOGLE_LIVE_VIEWS))
      .describe('what to read: campaigns | campaign | budgets | negative-lists | product-groups | ads | assets | change-history | drafts | lookup | account | conversions | labels | experiments | users | billing | links | bid-strategies | auto-apply'),
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign; needed for views campaign, product-groups and ads; narrows assets').optional(),
    listId: googleIdArg('one negative keyword list: view negative-lists then lists its keywords').optional(),
    labelId: googleIdArg('one label: view labels then lists the campaigns, ad groups, ads and keywords that carry it').optional(),
    day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('view change-history: the day (YYYY-MM-DD, the account\'s time zone; default today; Google keeps 30 days)'),
    lookup: z.preprocess(lower, z.enum(LOOKUPS)).optional()
      .describe('view lookup: what to find — locations (countries, regions, cities), languages, audiences (in-market and affinity segments), life-events (moving, marriage, …), or this account\'s own user-lists (remarketing, customer lists), custom-audiences, combined-audiences'),
    search: z.string().trim().min(1).max(80).optional().describe('view lookup: a word of the name (e.g. Italy, Italian, Motorcycles); needed for locations, languages and audiences, optional for life-events and the account\'s own lists'),
  }),
  description:
    'Google Ads, read LIVE from Google now (not from Nexus\'s daily read): the business\'s chosen Google Ads account as it '
    + 'is this minute, to plan a change and to check one after it ran. view campaigns: every campaign with status, type, '
    + 'bidding, Shopping priority and feed, budget. campaign (campaignId): one campaign in full, as its settings pages '
    + 'show it — settings, budget, bidding, networks, locations and the location option (PRESENCE = presence only), '
    + 'languages, ad schedule, audiences and whether they only observe, AI Max, broad match, asset automation, negative '
    + 'keywords and lists, ad groups with bids, keywords with bids, product groups, ads with their review, campaign assets '
    + 'with their review (a part Google refuses is listed in notRead). budgets: every budget with the campaigns on it. '
    + 'negative-lists: the shared negative keyword lists and their campaigns (listId: its keywords). product-groups '
    + '(campaignId): the product group tree of every ad group, every Shopping dimension, with bids and exclusions (warns '
    + 'when an "everything else" group is NOT excluded). ads (campaignId): ads with text, URLs, strength and review. assets: campaign assets (sitelinks, '
    + 'callouts, structured snippets …) with their review. change-history: Google\'s change history of one day (who, '
    + 'what; the e-mail of who needs the users permission). drafts: campaign drafts. lookup (lookup + search): Google\'s ids of locations, languages and audience '
    + 'segments whose name holds the word, Google\'s life events, and this account\'s own user lists, custom audiences and '
    + 'combined audiences, for the change tools. account: auto-tagging, tracking template, final URL suffix, time zone, currency, conversion '
    + 'tracking, the EU political ads declaration. conversions: conversion actions (category, primary or secondary, '
    + 'value, counting, windows, attribution, GA4 source), the account\'s goals and each campaign\'s goals. labels: the '
    + 'labels (labelId: what carries it). experiments: experiments with their arms and campaigns. users: who has access '
    + 'to the Google Ads account and open invitations (needs the users permission). billing: billing setups and account '
    + 'budgets (needs the ad-spend permission). links: Merchant Center and other product links, link invitations, YouTube '
    + 'links, GA4 properties. bid-strategies: portfolio bid strategies with targets, CPC ceilings and how many campaigns '
    + 'use each. auto-apply: which kinds of Google recommendations Google applies by itself. Each view '
    + 'costs one or a few operations of the account\'s daily Google Ads allowance: for numbers use google-ads-numbers '
    + '(live, today included) or google-ad-details (what Nexus stored). Amounts are minor units (cents) of the account '
    + 'currency; a person without the ad-spend money permission gets the same answer without them. Read only.',
  handler: (args, ctx) => asLiveRead(() => liveView(args, ctx)),
}

// ── google-ads-numbers ───────────────────────────────────────────────────────────────────────────────────────────

/** Sorting by these ranks the rows by money: only for a person who may see ad spend. */
const MONEY_ORDERS: readonly NumberOrder[] = ['cost', 'conversion-value']

async function numbersView(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const level = args.level as NumberLevel
  const spec = NUMBER_LEVEL_SPECS[level]
  if (!spec) return { ok: false, error: `Unknown level ${String(level)}.` }
  const spend = seesSpend(ctx)
  const asked = args.orderBy as NumberOrder | undefined
  if (asked && MONEY_ORDERS.includes(asked) && !spend) {
    return { ok: false, error: `orderBy ${asked} ranks the rows by money: it needs the ${ADSPEND} permission. Nothing was sent.` }
  }
  const orderBy: NumberOrder = asked ?? (spend ? 'cost' : 'impressions')
  const segments = [...new Set((Array.isArray(args.segments) ? args.segments : []) as NumberSegment[])]
  const bad = segments.filter((s) => !spec.segments.includes(s))
  if (bad.length) return { ok: false, error: `Google cannot split ${spec.what} by ${bad.join(', ')}: only campaigns and ad groups have numbers per hour. Nothing was sent.` }
  const adGroupId = text(args.adGroupId)
  if (adGroupId && !spec.adGroup) return { ok: false, error: `level ${level} is not read per ad group: leave adGroupId out (campaignId narrows it). Nothing was sent.` }
  const account = await googleChangeAccount(text(args.accountId) ?? null)
  if ('refusal' in account) return { ok: false, error: account.refusal }
  try {
    let timeZone = account.timeZone
    if (!timeZone) timeZone = (await liveAccountSettings(account.target))?.timeZone ?? null
    if (!timeZone) return { ok: false, error: 'Google Ads did not say the account\'s time zone, so Nexus cannot tell which day is today there. Nothing else was read.' }
    const window = numbersWindow(timeZone, { from: text(args.from), to: text(args.to) })
    if ('refusal' in window) return { ok: false, error: window.refusal }
    const campaignId = text(args.campaignId)
    const limit = Number(args.limit ?? 100)
    const read = await liveNumbers(account.target, { level, window, segments, campaignId, adGroupId, orderBy, limit })
    const notes = [
      'Rows with at least one impression in the window, most first by ' + orderBy + '.',
      'conversions is Google\'s "Conversions" column (primary conversion actions); conversionValueCents is their value.',
    ]
    if (window.includesToday) notes.unshift(`Today (${window.today}, ${timeZone}) is still running: Google adds today's clicks and cost through the day and conversions later, each counted on the day of the click.`)
    if (spec.impressionShare.length) notes.push('impressionShare is in percent of the impressions the ads could have had; Google writes a share under 10% as 9.99 and a lost share over 90% as 90.01.')
    if (spec.overlapping) notes.push(`No totals: one impression can count under several ${spec.what}, so their rows do not add up to the campaign's numbers (level campaign has those).`)
    if (read.truncated) notes.push(`The read stopped at its limit (${limit} rows): there may be more${spec.overlapping ? '' : ', and the totals cover only the rows shown'}. Raise limit (at most ${MAX_NUMBER_ROWS}) or narrow by campaignId or adGroupId.`)
    return {
      ok: true,
      data: {
        account: accountOf({ ...account, timeZone }), readAt: new Date().toISOString(), source: SOURCE,
        level, what: spec.what, window, ...(segments.length ? { segments } : {}),
        ...(campaignId ? { campaignId } : {}), ...(adGroupId ? { adGroupId } : {}),
        rows: read.rows, total: read.rows.length, ...(spec.overlapping ? {} : { totals: numbersTotals(read.rows) }), ...(read.truncated ? { truncated: true } : {}),
        ...notReadOf(read.notRead), notes, gaql: read.query,
      },
    }
  } catch (err) {
    const failure = readFailure(err)
    if (failure) return failure
    throw err
  }
}

const googleAdsNumbers: AgentTool = {
  name: 'google-ads-numbers',
  title: 'Google Ads numbers, live',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: LIVE_MONEY,
  input: z.object({
    level: z.preprocess(lower, z.enum(NUMBER_LEVELS))
      .describe('what the rows are: campaign | ad-group | keyword | ad | asset (linked to campaigns) | ad-group-asset | asset-group-asset (Performance Max) | product | search-term | location | age | gender | audience (set on campaigns) | ad-group-audience'),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('first day (YYYY-MM-DD, the account\'s time zone; default: the last day). At most 1,095 days back'),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('last day (YYYY-MM-DD, the account\'s time zone; default today — today\'s numbers are still coming in)'),
    segments: z.array(z.preprocess(lower, z.enum(NUMBER_SEGMENTS))).max(NUMBER_SEGMENTS.length).optional()
      .describe('split the numbers by: day | hour (campaign and ad-group only) | day-of-week | device | network; each split multiplies the rows'),
    campaignId: googleIdArg('only this campaign').optional(),
    adGroupId: googleIdArg('only this ad group (levels with ad groups)').optional(),
    orderBy: z.preprocess(lower, z.enum(NUMBER_ORDERS)).optional().describe('most first by: cost | clicks | impressions | conversions | conversion-value (default cost; impressions for a person without the ad-spend permission, who cannot sort by cost or conversion-value)'),
    limit: z.coerce.number().int().min(1).max(MAX_NUMBER_ROWS).optional().describe(`rows at most (default 100, at most ${MAX_NUMBER_ROWS})`),
    accountId: googleAccountArg,
  }),
  description:
    'Google Ads numbers read LIVE from Google now, for any window of account days up to and including TODAY (the daily '
    + 'read Nexus stores ends yesterday): impressions, clicks, CTR, cost, average CPC, conversions, conversion value, and '
    + 'search impression share where Google gives it: with what it lost to rank (campaigns, ad groups, keywords, products) '
    + 'and to budget (campaigns and products only). Levels: campaign, ad-group, keyword, ad, asset (sitelinks, callouts … linked to campaigns), '
    + 'ad-group-asset, asset-group-asset (Performance Max), product (Shopping and Performance Max, by item id), '
    + 'search-term, location (with Google\'s place names, and whether people were there or searched for it), age, gender, '
    + 'audience, ad-group-audience. Optional splits: day, hour (campaign and ad-group only, as Google allows), day-of-week, '
    + 'device, network. Narrow by campaignId and adGroupId; the most expensive rows first (orderBy), at most 1,000 rows, '
    + 'with totals (not for assets, audiences and locations, where one impression counts in several rows). Ids in the rows are the ones the change tools take (keywordId and adId are adGroupId~id). One '
    + 'operation of the account\'s daily Google Ads allowance (two for locations). Amounts are minor units (cents) of the '
    + 'account currency; a person without the ad-spend money permission gets the same answer without cost, value and '
    + 'the ratios built on them. Read only.',
  handler: (args, ctx) => asLiveRead(() => numbersView(args, ctx)),
}

// ── google-ads-query ─────────────────────────────────────────────────────────────────────────────────────────────

/** The permission each kind of sensitive field of a query needs (beyond the tool's own). */
const NEED_PERMISSION: Record<QueryNeed, (typeof F)[keyof typeof F] | (typeof FIELDS)[keyof typeof FIELDS]> = {
  people: F.usersManage, costs: FIELDS.financialsCostsView, margins: FIELDS.financialsMarginsView, revenue: FIELDS.financialsRevenueView,
}
const NEED_WHAT: Record<QueryNeed, string> = {
  people: 'name or reach people (e-mail addresses, leads, their messages)',
  costs: 'is the cost of goods sold',
  margins: 'is gross profit',
  revenue: 'is revenue',
}

/** The most text one answer carries; past it, rows are cut and the answer says so. */
const MAX_ANSWER_CHARS = 400_000

async function queryView(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await googleChangeAccount(text(args.accountId) ?? null)
  if ('refusal' in account) return { ok: false, error: account.refusal }
  const customerId = customerIdDigits(account.customerId)
  if (!customerId) return { ok: false, error: 'The Google Ads account id is not a customer id. Nothing was sent.' }
  const checked = checkedQuery(String(args.query ?? ''), customerId, Number(args.limit ?? DEFAULT_QUERY_ROWS))
  if ('refusal' in checked) return { ok: false, error: checked.refusal }
  for (const [need, fields] of Object.entries(checked.needs) as Array<[QueryNeed, string[]]>) {
    const permission = NEED_PERMISSION[need]
    const allowed = need === 'people' ? ctx.can(permission) : ctx.can(permission) || ctx.can(FIELDS.financialsView)
    if (!allowed) return { ok: false, error: `${fields.join(', ')} ${NEED_WHAT[need]}: the query needs the ${permission} permission. Nothing was sent.` }
  }
  try {
    const rows = await liveRows<Record<string, unknown>>(account.target, checked.query, 'ads.search.live.query')
    let shown = rows
    let size = JSON.stringify(rows).length
    while (shown.length > 1 && size > MAX_ANSWER_CHARS) {
      shown = shown.slice(0, Math.max(1, Math.floor(shown.length / 2)))
      size = JSON.stringify(shown).length
    }
    const notes = [
      ...checked.notes,
      'Rows exactly as Google answers them (camelCase). Fields ending in Micros are millionths of the account currency (÷ 10,000 = cents); metrics.conversionsValue is in currency units; ratios (ctr, impression shares) are fractions. Int64 values come as strings.',
    ]
    if (shown.length < rows.length) notes.push(`The answer was too large: ${shown.length} of ${rows.length} rows shown. Select fewer fields or lower the LIMIT.`)
    return {
      ok: true,
      data: {
        account: accountOf(account), readAt: new Date().toISOString(), source: 'Read live from Google now with the query below (GoogleAdsService.Search).',
        query: checked.query, rows: shown, total: rows.length, ...(rows.length >= checked.limit ? { truncated: `The query reached its LIMIT (${checked.limit} rows): there may be more.` } : {}), notes,
      },
    }
  } catch (err) {
    const failure = readFailure(err)
    if (failure) return failure
    throw err
  }
}

const googleAdsQuery: AgentTool = {
  name: 'google-ads-query',
  title: 'Google Ads query (GAQL), live',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // A query can select any cost, bid or value field: the answer is judged with the ad-spend money permission.
  requires: [F.adsView, ADSPEND],
  input: z.object({
    query: z.string().trim().min(1).max(20_000)
      .describe('ONE Google Ads Query Language query: SELECT fields FROM resource [WHERE …] [ORDER BY …] [LIMIT n] (Google\'s v25 field reference names every resource and field). A LIMIT of at most 1,000 is added or lowered; a selected segments.date needs a finite range in the WHERE'),
    limit: z.coerce.number().int().min(1).max(MAX_QUERY_ROWS).optional().describe(`the LIMIT added when the query has none (default ${DEFAULT_QUERY_ROWS}, at most ${MAX_QUERY_ROWS})`),
    accountId: googleAccountArg,
  }),
  description:
    'Run ONE Google Ads Query Language (GAQL) query, read only, LIVE on this business\'s chosen Google Ads account, and '
    + 'get Google\'s rows as Google gives them — the catch-all for any read the other Google Ads tools do not offer '
    + '(google-ads-live, google-ads-numbers and google-ad-details first). Only SELECT … FROM …; it never changes anything. '
    + 'Only this account: a query on another account\'s resources or customer id is refused (link fields that name a '
    + 'linked account are fine). People\'s e-mail addresses and leads need the users permission; Google\'s cost of goods, '
    + 'gross profit and revenue metrics need the matching money permission. At most 1,000 rows (a LIMIT is added or '
    + 'lowered). Google\'s rules apply: a segment in WHERE must be selected too (core date segments excepted), and a '
    + 'selected segments.date needs a finite date range. Money fields are Google\'s micros (÷ 10,000 = cents); the tool '
    + 'needs the ad-spend money permission. One operation of the account\'s daily Google Ads allowance per query.',
  handler: (args, ctx) => asLiveRead(() => queryView(args, ctx)),
}

export const GOOGLE_ADS_LIVE_TOOLS: AgentTool[] = [googleAdsLive, googleAdsNumbers, googleAdsQuery]
