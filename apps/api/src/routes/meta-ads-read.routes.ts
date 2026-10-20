/**
 * Meta ads step 2 — the read routes of Ads › Meta (/marketing/ads/meta):
 *
 *   GET  /meta-ads/overview?account=&from=&to=                      the account, its totals, the window before, its days
 *   GET  /meta-ads/campaigns?account=&from=&to=&status=&search=&limit=&cursor=   one page of campaigns with numbers
 *   GET  /meta-ads/campaigns/:campaignId/days?from=&to=             one campaign's days
 *   GET  /meta-ads/adsets?account=&campaign=&from=&to=&limit=&cursor=   one page of ad sets with numbers
 *   GET  /meta-ads/ads?account=&adset=&from=&to=&limit=&cursor=     one page of ads with numbers
 *   POST /meta-ads/sync?account=                                    ask for a read now (no body; once an hour)
 *
 * Read only: nothing here changes Meta. The logic is services/marketing/meta-ads/read.service.ts (this file holds no
 * database call). Money keys are stripped for a person without `financials.adspend.view`: the shared registry's, and
 * those other answers name too (cpcCents, budgets, bid) by this plugin's own hook.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { FIELDS } from '@nexus/shared/permissions'
import { financialFilterHookWith } from '../lib/auth/field-filter.js'
import { InvalidCursorError } from '../lib/pagination/cursor.js'
import { MetaAdsReadError, metaAdsAds, metaAdsAdSets, metaAdsCampaigns, metaAdsOverview, metaCampaignDays, requestMetaAdsRead } from '../services/marketing/meta-ads/read.service.js'

type Query = Record<string, string | undefined>
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

async function answer<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof MetaAdsReadError) { reply.code(error.status); return { error: error.message } }
    if (error instanceof InvalidCursorError) { reply.code(400); return { error: error.message } }
    throw error
  }
}

const ADSPEND = FIELDS.financialsAdspendView
export const META_READ_ROUTE_MONEY = { cpcCents: ADSPEND, dailyBudgetCents: ADSPEND, lifetimeBudgetCents: ADSPEND, bidAmountCents: ADSPEND } as const

const metaAdsReadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preSerialization', financialFilterHookWith(META_READ_ROUTE_MONEY))

  app.get<{ Querystring: Query }>('/meta-ads/overview', (req, reply) =>
    answer(reply, () => metaAdsOverview({ connectionId: text(req.query.account), from: text(req.query.from), to: text(req.query.to) })))

  app.get<{ Querystring: Query }>('/meta-ads/campaigns', (req, reply) =>
    answer(reply, () => metaAdsCampaigns({
      connectionId: text(req.query.account), from: text(req.query.from), to: text(req.query.to), status: text(req.query.status),
      search: text(req.query.search), limit: text(req.query.limit), cursor: text(req.query.cursor),
    })))

  app.get<{ Params: { campaignId: string }; Querystring: Query }>('/meta-ads/campaigns/:campaignId/days', (req, reply) =>
    answer(reply, () => metaCampaignDays(req.params.campaignId, { from: text(req.query.from), to: text(req.query.to) })))

  app.get<{ Querystring: Query }>('/meta-ads/adsets', (req, reply) =>
    answer(reply, () => metaAdsAdSets({
      connectionId: text(req.query.account), metaCampaignId: text(req.query.campaign), from: text(req.query.from), to: text(req.query.to),
      limit: text(req.query.limit), cursor: text(req.query.cursor),
    })))

  app.get<{ Querystring: Query }>('/meta-ads/ads', (req, reply) =>
    answer(reply, () => metaAdsAds({
      connectionId: text(req.query.account), metaAdSetId: text(req.query.adset), from: text(req.query.from), to: text(req.query.to),
      limit: text(req.query.limit), cursor: text(req.query.cursor),
    })))

  // Never `/budget` in a path here: the permissions manifest maps any path holding it to the budget-edit permission.
  app.post<{ Querystring: Query }>('/meta-ads/sync', (req, reply) =>
    answer(reply, () => requestMetaAdsRead({ connectionId: text(req.query.account) })))
}

export default metaAdsReadRoutes
