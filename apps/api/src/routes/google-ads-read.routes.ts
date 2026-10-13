/**
 * Google Ads step 1a — the read routes of the Google Ads tab (/marketing/ads/google), PLAN.md "API contract":
 *
 *   R1  GET  /google-ads/overview?account=&from=&to=                        the account's totals, window before, days
 *   R2  GET  /google-ads/campaigns?account=&from=&to=&status=&type=&search=&limit=&cursor=   one page of campaigns
 *   R3  GET  /google-ads/campaigns/:campaignId/days?from=&to=               one campaign's days
 *   R4  GET  /google-ads/campaigns/:campaignId/changes                      Google's change history (30 days)
 *   S   POST /google-ads/sync?account=                                       ask for a read now (no body)
 *
 * Read only: nothing here changes Google Ads. The logic is services/marketing/google-ads/read.service.ts (this file
 * holds no database call). Money keys (spendCents, conversionValueCents, avgCpcCents, costPerConversionCents, roas)
 * are stripped by the global financial filter for a person without `financials.adspend.view`; a campaign's
 * dailyBudgetCents, which the shared registry does not name, by this plugin's own hook.
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

const googleAdsReadRoutes: FastifyPluginAsync = async (app) => {
  // A campaign's daily budget is ad money (the Google Ads tab shows it only to a person who may see ad spend).
  app.addHook('preSerialization', financialFilterHookWith({ dailyBudgetCents: FIELDS.financialsAdspendView }))

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

  // Never `/budget` in a path here: the permissions manifest maps any path holding it to the budget-edit permission.
  app.post<{ Querystring: Query }>('/google-ads/sync', (req, reply) =>
    answer(reply, () => requestGoogleAdsRead({ connectionId: text(req.query.account) })))
}

export default googleAdsReadRoutes
