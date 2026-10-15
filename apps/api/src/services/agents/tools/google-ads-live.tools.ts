/**
 * Google Ads changes (2026-10-15) — google-ads-live: what the business's Google Ads account holds NOW, read from Google
 * (marketing/google-ads/live.ts), so a change can be planned on it and checked after it ran. Read only. Each view costs
 * one or a few operations of the account's daily Google Ads allowance; google-ad-details answers from what Nexus stored
 * (no Google call) and is the place for numbers.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { googleAccountArg, googleIdArg } from './google-ads-kit.js'
import { googleChangeAccount } from '../../marketing/google-ads/change-account.js'
import { GoogleAdsReadError } from '../../marketing/google-ads/errors.js'
import {
  liveAds, liveAssets, liveBudgets, liveCampaignDetail, liveCampaigns, liveChangeHistory, liveDrafts, liveNegativeLists, liveProductGroups,
} from '../../marketing/google-ads/live.js'
import { liveLookup, type LookupKind } from '../../marketing/google-ads/live-campaigns.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of this tool's answer (the shared registry names none of them). */
const LIVE_MONEY = {
  amountCents: ADSPEND, cpcBidCents: ADSPEND, effectiveCpcBidCents: ADSPEND, bidCents: ADSPEND, maxCpcCeilingCents: ADSPEND,
} as const

export const GOOGLE_LIVE_VIEWS = ['campaigns', 'campaign', 'budgets', 'negative-lists', 'product-groups', 'ads', 'assets', 'change-history', 'drafts', 'lookup'] as const
type LiveView = typeof GOOGLE_LIVE_VIEWS[number]
const NEEDS_CAMPAIGN: readonly LiveView[] = ['campaign', 'product-groups', 'ads']
const MAX_CHANGES = 200

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)

async function liveView(args: Record<string, unknown>): Promise<ToolResult> {
  const view = args.view as LiveView
  const campaignId = typeof args.campaignId === 'string' ? args.campaignId : undefined
  if (NEEDS_CAMPAIGN.includes(view) && !campaignId) return { ok: false, error: `view ${view} needs campaignId (view campaigns lists them).` }
  const account = await googleChangeAccount(typeof args.accountId === 'string' ? args.accountId : null)
  if ('refusal' in account) return { ok: false, error: account.refusal }
  const base = {
    account: { accountId: account.accountId, customerId: account.customerId, name: account.name, currency: account.currency, timeZone: account.timeZone },
    view,
    readAt: new Date().toISOString(),
    source: 'Read live from Google now (not the daily read). Amounts are minor units (cents) of the account currency.',
  }
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
        const listId = typeof args.listId === 'string' ? args.listId : undefined
        const items = await liveNegativeLists(account.target, listId)
        if (listId && !items.some((l) => l.listId === listId)) return { ok: false, error: `Negative keyword list ${listId} is not in this account (or it is removed).` }
        return { ok: true, data: { ...base, items, total: items.length, ...(listId ? {} : { note: 'Name one list (listId) for its keywords.' }) } }
      }
      case 'product-groups': {
        const items = await liveProductGroups(account.target, campaignId!)
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
        const day = typeof args.day === 'string' ? args.day : new Intl.DateTimeFormat('en-CA', { timeZone: account.timeZone ?? 'UTC' }).format(new Date())
        const all = await liveChangeHistory(account.target, day)
        const items = all.slice(0, MAX_CHANGES)
        return {
          ok: true,
          data: {
            ...base, day, items, total: all.length,
            ...(all.length > items.length ? { truncated: `Showing the newest ${items.length} of ${all.length} changes.` } : {}),
            note: 'Google keeps 30 days of change history; a change can take up to 3 minutes to appear.',
          },
        }
      }
      case 'lookup': {
        const kind = args.lookup as LookupKind | undefined
        const search = typeof args.search === 'string' ? args.search : ''
        if (!kind || !search.trim()) return { ok: false, error: 'view lookup needs lookup (locations, languages or audiences) and search (a word of the name).' }
        const items = await liveLookup(account.target, kind, search)
        return { ok: true, data: { ...base, lookup: kind, search, items, total: items.length, note: 'Google\'s own ids: pass them to create-google-campaign or set-google-targeting.' } }
      }
      case 'drafts': {
        const items = await liveDrafts(account.target)
        return {
          ok: true,
          data: { ...base, items, total: items.length, note: 'Campaign drafts (Drafts & experiments). The "Drafts in progress" of Google\'s campaign creation pages are not in the Google Ads API.' },
        }
      }
    }
  } catch (err) {
    if (err instanceof GoogleAdsReadError) return { ok: false, error: err.message }
    if (err instanceof Error && /Nothing was sent/.test(err.message)) return { ok: false, error: err.message }
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
      .describe('what to read: campaigns | campaign | budgets | negative-lists | product-groups | ads | assets | change-history | drafts | lookup'),
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign; needed for views campaign, product-groups and ads; narrows assets').optional(),
    listId: googleIdArg('one negative keyword list: view negative-lists then lists its keywords').optional(),
    day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('view change-history: the day (YYYY-MM-DD, the account\'s time zone; default today; Google keeps 30 days)'),
    lookup: z.enum(['locations', 'languages', 'audiences']).optional().describe('view lookup: what to find — locations (countries, regions, cities), languages, audiences (in-market and affinity segments)'),
    search: z.string().trim().min(1).max(80).optional().describe('view lookup: a word of the name (e.g. Italy, Italian, Motorcycles)'),
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
    + '(campaignId): the product group tree with bids and exclusions (warns when an "everything else" group is NOT '
    + 'excluded). ads (campaignId): ads with text, URLs, strength and review. assets: campaign assets (sitelinks, '
    + 'callouts, structured snippets …) with their review. change-history: Google\'s change history of one day (who, '
    + 'what). drafts: campaign drafts. lookup (lookup + search): Google\'s ids of locations, languages and audience '
    + 'segments whose name holds the word, for the change tools. Each view costs one or a few operations of the account\'s daily Google Ads '
    + 'allowance: for numbers (cost, clicks, conversions) use google-ad-details and ad-campaigns with channel google, '
    + 'which read what Nexus stored. Amounts are minor units (cents) of the account currency; a person without the '
    + 'ad-spend money permission gets the same answer without them. Read only.',
  handler: (args) => liveView(args),
}

export const GOOGLE_ADS_LIVE_TOOLS: AgentTool[] = [googleAdsLive]
