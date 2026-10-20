/**
 * Meta ads, step 2 (2026-10-20) — Claude's read tools for Meta (Facebook + Instagram ads). Read only: nothing here
 * changes Meta, and the gateway lets only GET through.
 *
 *   meta-ad-accounts     the ad account this business chose (no Meta call), and LIVE its business portfolio's own,
 *                        client and pending ones (master AA-001…AA-005; what the system user reaches is meta-connection
 *                        view choices)
 *   meta-ads-overview    Nexus's stored daily numbers (the daily read): the account's totals and days, campaigns, ad
 *                        sets, ads, one campaign's days, a weekly trend computed from them (IN-103), the business
 *                        context (IN-104); industry and auction benchmarks have no public Meta API (IN-100, IN-101)
 *   meta-ads-live        the chosen ad account LIVE from Meta: settings, campaigns / ad sets / ads with numbers inline
 *                        (IN-006), insights for any days (today allowed), promoted Pages, Instagram accounts, minimum
 *                        budgets, ads volume
 *   meta-ads-graph-read  the catch-all: one GET on the chosen ad account's own objects (an object and at most one edge)
 *                        for anything not wrapped yet (ACC-028 async requests, TG-038 audience funnel, …)
 * Money is in minor units (cents) of the account currency, except graph-read, which answers Meta's raw units.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'
import { listMetaConnections } from '../../meta/meta-accounts.service.js'
import { metaAdsAds, metaAdsAdSets, metaAdsCampaigns, metaAdsOverview, metaCampaignDays, MetaAdsReadError, type MetaAdsDay } from '../../marketing/meta-ads/read.service.js'
import { AD_ACCOUNT_LISTS, graphRead, INLINE_PRESETS, INSIGHT_LEVELS, LIVE_VIEWS, liveAdAccounts, liveView, MAX_GRAPH_ROWS, MetaLiveRefusal, type AdAccountList, type LiveView } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { addDays, dayCount } from '../../marketing/meta-ads/dates.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' answers (some are in the shared registry too; named here so each tool states its own). */
export const META_MONEY = {
  spendCents: ADSPEND, purchaseValueCents: ADSPEND, cpcCents: ADSPEND, cpmCents: ADSPEND, roas: ADSPEND, costPerPurchaseCents: ADSPEND,
  dailyBudgetCents: ADSPEND, lifetimeBudgetCents: ADSPEND, budgetRemainingCents: ADSPEND, spendCapCents: ADSPEND, bidAmountCents: ADSPEND,
  amountSpentCents: ADSPEND, balanceCents: ADSPEND, minDailyBudgetCents: ADSPEND,
} as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD, the ad account's time zone)`)
const metaIdArg = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')

const BENCHMARKS = 'Meta has no public API for industry benchmarks or auction ranking benchmarks (they exist in Meta\'s own ads MCP and in Ads Manager only); Nexus does not copy them. Use Meta\'s own MCP or Ads Manager for them.'

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError || err instanceof MetaAdsReadError) return { ok: false, error: err.message }
    throw err
  }
}

// ── meta-ad-accounts ─────────────────────────────────────────────────────────────────────────────────────────────

const metaAdAccounts: AgentTool = {
  name: 'meta-ad-accounts',
  title: 'Meta ad accounts',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    list: z.preprocess(lower, z.enum(['chosen', ...AD_ACCOUNT_LISTS])).default('chosen')
      .describe('chosen (what this business reads; no Meta call) | owned | client | pending (the business portfolio\'s, live)'),
    portfolioId: metaIdArg('owned / client / pending: the Meta business portfolio (an ad account\'s businessId in meta-connection view choices); default: the chosen account\'s'),
    maxRows: z.number().int().min(1).max(500).optional().describe('at most this many accounts (default 200)'),
    connectionId: connectionArg,
  }),
  description:
    'Meta ad accounts. list chosen (default, no Meta call): the ad account, Facebook Page and Instagram account this '
    + 'business reads, and the state of their daily read. owned, client, pending (live): the business portfolio\'s own ad '
    + 'accounts, its client ad accounts, and claims still waiting for approval, with status in words, currency, time zone '
    + 'and whether it is the chosen one; one another business in Nexus already picked is its id only (each ad account '
    + 'belongs to ONE business; never which one). The ad accounts the system user itself reaches are meta-connection view '
    + 'choices. Read only: to choose another account, set-meta-connection asks for it (a person approves '
    + 'it), or a person chooses it in Settings › Channels › Meta.',
  async handler(args): Promise<ToolResult> {
    const list = (args.list ?? 'chosen') as 'chosen' | AdAccountList
    const connectionId = typeof args.connectionId === 'string' ? args.connectionId : null
    if (list === 'chosen') {
      const connections = await listMetaConnections()
      const c = connectionId ? connections.find((x) => x.connectionId === connectionId) : connections[0]
      if (!c) return { ok: true, data: { connected: false, sentence: 'Meta is not connected for this business. A person connects it in Settings › Channels › Meta.' } }
      return { ok: true, data: { connected: true, connectionId: c.connectionId, state: c.state, stateText: c.stateText, adAccount: c.adAccount, page: c.page, instagram: c.instagram, read: c.read } }
    }
    return guarded(() => liveAdAccounts({ connectionId, list, portfolioId: typeof args.portfolioId === 'string' ? args.portfolioId : null, maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined }))
  },
}

// ── meta-ads-overview ────────────────────────────────────────────────────────────────────────────────────────────

export const OVERVIEW_VIEWS = ['overview', 'campaigns', 'campaign-days', 'adsets', 'ads', 'trend', 'context', 'benchmarks'] as const
type OverviewView = typeof OVERVIEW_VIEWS[number]

/** Weekly sums of the read days (IN-103), with the ratios computed from them; a week with an unread day says so. */
export function weeklyTrend(days: MetaAdsDay[]) {
  const weeks: Array<{ from: string; to: string; daysRead: number; days: number; spendCents: number; impressions: number; clicks: number; purchases: number; purchaseValueCents: number }> = []
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7)
    const read = chunk.filter((d): d is Extract<MetaAdsDay, { read: true }> => d.read)
    weeks.push({
      from: chunk[0].date, to: chunk[chunk.length - 1].date, daysRead: read.length, days: chunk.length,
      spendCents: read.reduce((s, d) => s + d.spendCents, 0), impressions: read.reduce((s, d) => s + d.impressions, 0),
      clicks: read.reduce((s, d) => s + d.clicks, 0), purchases: read.reduce((s, d) => s + d.purchases, 0),
      purchaseValueCents: read.reduce((s, d) => s + d.purchaseValueCents, 0),
    })
  }
  return weeks.map((w) => ({
    ...w,
    complete: w.daysRead === w.days,
    ctr: w.impressions > 0 ? w.clicks / w.impressions : null,
    cpcCents: w.clicks > 0 ? Math.round(w.spendCents / w.clicks) : null,
    cpmCents: w.impressions > 0 ? Math.round((w.spendCents * 1000) / w.impressions) : null,
    costPerPurchaseCents: w.purchases > 0 ? Math.round(w.spendCents / w.purchases) : null,
    roas: w.spendCents > 0 ? w.purchaseValueCents / w.spendCents : null,
    conversionRate: w.clicks > 0 ? w.purchases / w.clicks : null,
  }))
}

const metaAdsOverviewTool: AgentTool = {
  name: 'meta-ads-overview',
  title: 'Meta ads, Nexus\'s daily read',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: META_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(OVERVIEW_VIEWS)).default('overview')
      .describe('overview | campaigns | campaign-days (campaignId) | adsets | ads | trend | context | benchmarks'),
    from: dayArg('first day'),
    to: dayArg('last day (at most yesterday)'),
    days: z.number().int().min(1).max(400).optional().describe('when from is absent: the last N days ending at to (default 30)'),
    campaignId: z.string().trim().min(1).max(64).optional().describe('campaign-days: Nexus\'s campaign id (campaignId from view campaigns)'),
    metaCampaignId: metaIdArg('adsets: only the ad sets of this Meta campaign id'),
    metaAdSetId: metaIdArg('ads: only the ads of this Meta ad set id'),
    status: z.string().trim().min(1).max(30).optional().describe('campaigns: only this status or effective status (ACTIVE, PAUSED, ARCHIVED, DELETED …)'),
    search: z.string().trim().min(1).max(80).optional().describe('campaigns: a word of the name'),
    limit: z.number().int().min(1).max(500).optional().describe('rows per page (default 100)'),
    cursor: z.string().trim().min(1).max(500).optional().describe('the nextCursor of the page before'),
    connectionId: connectionArg,
  }),
  description:
    'Meta (Facebook + Instagram) ads as Nexus\'s daily read stored them (06:50 UTC; no Meta call): view overview '
    + '(default): the chosen ad account (status in words, amount spent, spending limit), totals of the window (spend, '
    + 'impressions, clicks, link clicks, purchases and purchase value as Meta counts them with each ad set\'s attribution '
    + 'setting, CTR, CPC, CPM, cost per purchase, ROAS), the window before when both were read in full, and every day — a '
    + 'day Nexus did not read is "not read", never 0; days of the last 28 are provisional (Meta still attributes late '
    + 'purchases). campaigns: each with status, objective, budget and its numbers; campaign-days: one campaign\'s days; '
    + 'adsets, ads: with their numbers. trend: weekly CPC, CPM, cost per purchase, ROAS, CTR and conversion rate, computed '
    + 'from the stored days. context: the account, its campaigns by objective and their share of spend. benchmarks: Meta '
    + 'has no public API for industry or auction benchmarks — use Meta\'s own MCP or Ads Manager. Numbers today and '
    + 'breakdowns: meta-ads-live. Read only; money in minor units (cents) of the account currency.',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'overview') as OverviewView
    const window = { from: (args.from as string | undefined) ?? null, to: (args.to as string | undefined) ?? null, days: (args.days as number | undefined) ?? null }
    const connectionId = (args.connectionId as string | undefined) ?? null
    if (view === 'benchmarks') return { ok: true, data: { sentence: BENCHMARKS } }
    return guarded(async () => {
      switch (view) {
        case 'overview': return { ...(await metaAdsOverview({ connectionId, ...window })), benchmarks: BENCHMARKS }
        case 'campaigns': return metaAdsCampaigns({ connectionId, ...window, status: (args.status as string) ?? null, search: (args.search as string) ?? null, limit: args.limit, cursor: (args.cursor as string) ?? null })
        case 'campaign-days': {
          if (typeof args.campaignId !== 'string') throw new MetaLiveRefusal('Name the campaign (campaignId from view campaigns).')
          return metaCampaignDays(args.campaignId, window)
        }
        case 'adsets': return metaAdsAdSets({ connectionId, ...window, metaCampaignId: (args.metaCampaignId as string) ?? null, limit: args.limit, cursor: (args.cursor as string) ?? null })
        case 'ads': return metaAdsAds({ connectionId, ...window, metaAdSetId: (args.metaAdSetId as string) ?? null, limit: args.limit, cursor: (args.cursor as string) ?? null })
        case 'trend': {
          const overview = await metaAdsOverview({ connectionId, ...window, days: window.from ? window.days : window.days ?? 84 })
          return { window: overview.window, currency: overview.currency, dataAsOf: overview.dataAsOf, weeks: weeklyTrend(overview.days), note: 'Computed by Nexus from the stored days (Meta has no trend API); a week with a day not read is marked complete: false.' }
        }
        case 'context': {
          const [overview, campaigns] = await Promise.all([metaAdsOverview({ connectionId, ...window }), metaAdsCampaigns({ connectionId, ...window, limit: 500 })])
          const byObjective = new Map<string, { campaigns: number; active: number; spendCents: number }>()
          for (const c of campaigns.items) {
            const key = c.objective ?? 'UNKNOWN'
            const entry = byObjective.get(key) ?? { campaigns: 0, active: 0, spendCents: 0 }
            entry.campaigns++
            if (c.effectiveStatus === 'ACTIVE') entry.active++
            entry.spendCents += c.metrics?.spendCents ?? 0
            byObjective.set(key, entry)
          }
          const spend = [...byObjective.values()].reduce((s, e) => s + e.spendCents, 0)
          return {
            account: overview.account, window: overview.window, currency: overview.currency, totals: overview.totals,
            objectives: [...byObjective.entries()].map(([objective, e]) => ({ objective, ...e, spendShare: spend > 0 ? e.spendCents / spend : null })).sort((a, b) => b.spendCents - a.spendCents),
            note: 'Composed by Nexus from the stored read (Meta has no "advertiser context" API).',
          }
        }
      }
    })
  },
}

// ── meta-ads-live ────────────────────────────────────────────────────────────────────────────────────────────────

const metaAdsLive: AgentTool = {
  name: 'meta-ads-live',
  title: 'Meta ads, live from Meta',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(LIVE_VIEWS)).describe('account | campaigns | adsets | ads | insights | pages | instagram | minimum-budgets | ads-volume'),
    campaignId: metaIdArg('adsets, ads, insights: only this Meta campaign id'),
    adSetId: metaIdArg('ads: only this Meta ad set id'),
    numbers: z.preprocess(lower, z.enum(INLINE_PRESETS)).optional().describe('campaigns, adsets, ads: numbers inline for this period (today, yesterday, last_7d, last_14d, last_30d, this_month, last_month)'),
    level: z.preprocess(lower, z.enum(INSIGHT_LEVELS)).optional().describe('insights: account | campaign (default) | adset | ad'),
    from: dayArg('insights: first day'),
    to: dayArg('insights: last day (today allowed)'),
    daily: z.boolean().optional().describe('insights: one row per day (default: one row for the whole period)'),
    maxRows: z.number().int().min(1).max(500).optional().describe('at most this many rows (default 200)'),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s chosen Meta ad account read LIVE from Meta now (not the daily read), to see it as it is this minute. '
    + 'view account: status and disable reason, amount spent, spending limit, balance, minimum daily budget, prepay, '
    + 'capabilities, terms accepted, failed delivery checks, inventory filter levels, opportunity score. campaigns, adsets, '
    + 'ads: every one with status, objective, budgets, bids, schedule, targeting, creative and issues, with numbers inline '
    + 'for a period (numbers). insights (from, to; today allowed): spend, impressions, reach, clicks, purchases and value '
    + 'at account, campaign, ad set or ad level, by day or for the whole period, with each ad set\'s attribution setting. '
    + 'pages: Pages promoted by the account; instagram: its Instagram accounts; minimum-budgets; ads-volume. Only the '
    + 'chosen ad account is ever read. Read only; money in minor units (cents) of the account currency.',
  async handler(args): Promise<ToolResult> {
    const from = (args.from as string | undefined) ?? null
    const to = (args.to as string | undefined) ?? null
    if (from && to && (to < from || dayCount({ from, to }) > 92)) return { ok: false, error: 'insights reads at most 92 days at once, from before to.' }
    return guarded(() => liveView({
      connectionId: (args.connectionId as string | undefined) ?? null,
      view: args.view as LiveView,
      campaignId: (args.campaignId as string | undefined) ?? null,
      adSetId: (args.adSetId as string | undefined) ?? null,
      numbers: (args.numbers as string | undefined) ?? null,
      level: (args.level as string | undefined) ?? null,
      from: from ?? (to ? addDays(to, -6) : null),
      to,
      daily: args.daily === true,
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }))
  },
}

// ── meta-ads-graph-read ──────────────────────────────────────────────────────────────────────────────────────────

const metaAdsGraphRead: AgentTool = {
  name: 'meta-ads-graph-read',
  title: 'Meta Graph read (catch-all)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // Any field may be money (budgets, spend): the answer is judged with the ad-spend money permission.
  requires: [F.adsView, ADSPEND],
  input: z.object({
    path: z.string().trim().min(1).max(120).describe('act_<the chosen ad account> or a Meta object id of it (campaign, ad set, ad, creative …), and at most one edge: e.g. act_1234567890/async_requests, act_1234567890/audience_funnel, 120000000000001/insights'),
    fields: z.string().trim().min(1).max(800).optional().describe('Meta\'s field list, as the Graph API takes it (e.g. id,name,status or spend,impressions)'),
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.union([z.string().max(500), z.number(), z.boolean()])).optional()
      .describe('other query parameters Meta\'s reference names for that edge (e.g. date_preset, level, time_increment, effective_status); never a token'),
    limit: z.number().int().min(1).max(MAX_GRAPH_ROWS).optional().describe(`an edge: at most this many rows (default 100, at most ${MAX_GRAPH_ROWS})`),
    after: z.string().trim().min(1).max(500).optional().describe('the nextAfter of the answer before'),
    connectionId: connectionArg,
  }),
  description:
    'The catch-all Meta read, so no read is ever missing: ONE GET on the business\'s chosen ad account or one of its own '
    + 'objects (a campaign, ad set, ad, creative …, or the chosen Page or Instagram account) and at most one edge, with '
    + 'the fields and parameters Meta\'s Marketing API reference names (e.g. act_<id>/async_requests, act_<id>/'
    + 'audience_funnel, <ad id>/insights). Another account, an object of another account, a batch or anything but a read '
    + 'is refused before a call. Edges that list people need the users permission; the payment method is not read here. '
    + 'Meta\'s raw answer, paging links removed (use nextAfter): money in Meta\'s own units (budgets in the currency\'s '
    + 'smallest unit for most currencies, insights spend a decimal of the currency); needs the ad-spend money permission. '
    + 'Prefer meta-ads-live and meta-ads-overview where they answer.',
  async handler(args, ctx: ToolContext): Promise<ToolResult> {
    return guarded(() => graphRead({
      connectionId: (args.connectionId as string | undefined) ?? null,
      path: String(args.path),
      fields: (args.fields as string | undefined) ?? null,
      params: (args.params as Record<string, string | number | boolean> | undefined) ?? {},
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      after: (args.after as string | undefined) ?? null,
      canSeePeople: ctx.can(F.usersManage),
    }))
  },
}

export const META_ADS_READ_TOOLS: AgentTool[] = [metaAdAccounts, metaAdsOverviewTool, metaAdsLive, metaAdsGraphRead]
