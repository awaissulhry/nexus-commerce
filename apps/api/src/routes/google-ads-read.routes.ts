/**
 * Google Ads step 1a — the read routes of the Google Ads tab (/marketing/ads/google), PLAN.md "API contract":
 *
 *   R1  GET  /google-ads/overview?account=&from=&to=                        the account's totals, window before, days
 *   R2  GET  /google-ads/campaigns?account=&from=&to=&status=&type=&search=&limit=&cursor=   one page of campaigns
 *   R3  GET  /google-ads/campaigns/:campaignId/days?from=&to=               one campaign's days
 *   R4  GET  /google-ads/campaigns/:campaignId/changes                      Google's change history (30 days)
 *   S   POST /google-ads/sync?account=                                       ask for a read now (no body)
 *
 * Step 1b (PLAN-1B.md "API contract"), GET only, `campaignId` = Nexus's id or the step-1a `<customerId>~<id>` id:
 *   R5  /google-ads/ad-groups?account=&from=&to=&campaignId=&status=&search=&limit=&cursor=
 *   R6  /google-ads/keywords?account=&from=&to=&campaignId=&adGroupId=&status=&matchType=&search=&sort=&limit=&cursor=
 *   R7  /google-ads/negatives?account=&campaignId=&level=&search=&limit=&cursor=
 *   R8  /google-ads/search-terms?account=&from=&to=&campaignId=&brand=&search=&sort=&limit=&cursor=
 *   R9  /google-ads/brand-split?account=&from=&to=
 *   R10 /google-ads/asset-groups?account=&from=&to=&campaignId=&status=&limit=&cursor=
 *   R11 /google-ads/products?account=&from=&to=&campaignId=&issue=&search=&sort=&limit=&cursor=
 *   R12 /google-ads/acts-on-its-own?account=
 *   R13 /google-ads/recommendations?account=&campaignId=&type=
 *   R14 /google-ads/alerts?account=
 *   R15 /google-ads/disapprovals?account=&campaignId=&kind=
 *
 * Read only: nothing here changes Google Ads. The logic is in services/marketing/google-ads/ (read.service.ts,
 * read-detail.service.ts, read-search-terms.service.ts, read-acts.service.ts, alerts.service.ts); this file holds no
 * database call. Money keys the shared registry names (spendCents, conversionValueCents, avgCpcCents,
 * costPerConversionCents, roas) are stripped by the global financial filter for a person without
 * `financials.adspend.view`; the others (PLAN-1B M12) by this plugin's own hook.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { FIELDS } from '@nexus/shared/permissions'
import { financialFilterHookWith } from '../lib/auth/field-filter.js'
import { InvalidCursorError } from '../lib/pagination/cursor.js'
import {
  GoogleAdsReadError,
  googleAdsCampaigns,
  googleAdsOverview,
  googleCampaignChanges,
  googleCampaignDays,
  requestGoogleAdsRead,
} from '../services/marketing/google-ads/read.service.js'
import {
  googleAdsAdGroups,
  googleAdsAssetGroups,
  googleAdsDisapprovals,
  googleAdsKeywords,
  googleAdsNegatives,
  googleAdsProducts,
} from '../services/marketing/google-ads/read-detail.service.js'
import { googleAdsBrandSplit, googleAdsSearchTerms } from '../services/marketing/google-ads/read-search-terms.service.js'
import { googleAdsActsOnItsOwn, googleAdsRecommendations } from '../services/marketing/google-ads/read-acts.service.js'
import { googleAdsAlerts } from '../services/marketing/google-ads/alerts.service.js'

type Query = Record<string, string | undefined>

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** A refusal keeps its status and sentence; anything else is a real failure (500). */
async function answer<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof GoogleAdsReadError) {
      reply.code(error.status)
      return { error: error.message }
    }
    if (error instanceof InvalidCursorError) {
      reply.code(400)
      return { error: error.message }
    }
    throw error
  }
}

/** Ad money the shared registry does not name (PLAN-1B M12): shown only to a person who may see ad spend. */
export const GOOGLE_ADS_MONEY_KEYS = [
  'dailyBudgetCents', 'cpcBidCents', 'effectiveCpcBidCents', 'targetCpaCents', 'targetRoas', 'impact', 'numbers',
] as const

/** The window and the list filters every step-1b list takes. */
const listQuery = (q: Query) => ({
  connectionId: text(q.account),
  from: text(q.from),
  to: text(q.to),
  campaignId: text(q.campaignId),
  limit: text(q.limit),
  cursor: text(q.cursor),
})

const googleAdsReadRoutes: FastifyPluginAsync = async (app) => {
  // A campaign's daily budget, bids, targets, Google's estimates and an alert's numbers are ad money.
  app.addHook('preSerialization', financialFilterHookWith(Object.fromEntries(GOOGLE_ADS_MONEY_KEYS.map((key) => [key, FIELDS.financialsAdspendView]))))

  app.get<{ Querystring: Query }>('/google-ads/overview', (req, reply) =>
    answer(reply, () => googleAdsOverview({ connectionId: text(req.query.account), from: text(req.query.from), to: text(req.query.to) })))

  app.get<{ Querystring: Query }>('/google-ads/campaigns', (req, reply) =>
    answer(reply, () => googleAdsCampaigns({
      connectionId: text(req.query.account),
      from: text(req.query.from),
      to: text(req.query.to),
      status: text(req.query.status),
      type: text(req.query.type),
      search: text(req.query.search),
      limit: text(req.query.limit),
      cursor: text(req.query.cursor),
    })))

  app.get<{ Params: { campaignId: string }; Querystring: Query }>('/google-ads/campaigns/:campaignId/days', (req, reply) =>
    answer(reply, () => googleCampaignDays(req.params.campaignId, { from: text(req.query.from), to: text(req.query.to) })))

  app.get<{ Params: { campaignId: string } }>('/google-ads/campaigns/:campaignId/changes', (req, reply) =>
    answer(reply, () => googleCampaignChanges(req.params.campaignId)))

  // ── Step 1b ──
  app.get<{ Querystring: Query }>('/google-ads/ad-groups', (req, reply) =>
    answer(reply, () => googleAdsAdGroups({ ...listQuery(req.query), status: text(req.query.status), search: text(req.query.search) })))

  app.get<{ Querystring: Query }>('/google-ads/keywords', (req, reply) =>
    answer(reply, () => googleAdsKeywords({
      ...listQuery(req.query),
      adGroupId: text(req.query.adGroupId),
      status: text(req.query.status),
      matchType: text(req.query.matchType),
      search: text(req.query.search),
      sort: text(req.query.sort),
    })))

  app.get<{ Querystring: Query }>('/google-ads/negatives', (req, reply) =>
    answer(reply, () => googleAdsNegatives({
      connectionId: text(req.query.account),
      campaignId: text(req.query.campaignId),
      level: text(req.query.level),
      search: text(req.query.search),
      limit: text(req.query.limit),
      cursor: text(req.query.cursor),
    })))

  app.get<{ Querystring: Query }>('/google-ads/search-terms', (req, reply) =>
    answer(reply, () => googleAdsSearchTerms({ ...listQuery(req.query), brand: text(req.query.brand), search: text(req.query.search), sort: text(req.query.sort) })))

  app.get<{ Querystring: Query }>('/google-ads/brand-split', (req, reply) =>
    answer(reply, () => googleAdsBrandSplit({ connectionId: text(req.query.account), from: text(req.query.from), to: text(req.query.to) })))

  app.get<{ Querystring: Query }>('/google-ads/asset-groups', (req, reply) =>
    answer(reply, () => googleAdsAssetGroups({ ...listQuery(req.query), status: text(req.query.status) })))

  app.get<{ Querystring: Query }>('/google-ads/products', (req, reply) =>
    answer(reply, () => googleAdsProducts({ ...listQuery(req.query), issue: text(req.query.issue), search: text(req.query.search), sort: text(req.query.sort) })))

  app.get<{ Querystring: Query }>('/google-ads/acts-on-its-own', (req, reply) =>
    answer(reply, () => googleAdsActsOnItsOwn({ connectionId: text(req.query.account) })))

  app.get<{ Querystring: Query }>('/google-ads/recommendations', (req, reply) =>
    answer(reply, () => googleAdsRecommendations({ connectionId: text(req.query.account), campaignId: text(req.query.campaignId), type: text(req.query.type) })))

  app.get<{ Querystring: Query }>('/google-ads/alerts', (req, reply) =>
    answer(reply, () => googleAdsAlerts({ connectionId: text(req.query.account) })))

  app.get<{ Querystring: Query }>('/google-ads/disapprovals', (req, reply) =>
    answer(reply, () => googleAdsDisapprovals({ connectionId: text(req.query.account), campaignId: text(req.query.campaignId), kind: text(req.query.kind) })))

  // Never `/budget` in a path here: the permissions manifest maps any path holding it to the budget-edit permission.
  app.post<{ Querystring: Query }>('/google-ads/sync', (req, reply) =>
    answer(reply, () => requestGoogleAdsRead({ connectionId: text(req.query.account) })))
}

export default googleAdsReadRoutes
