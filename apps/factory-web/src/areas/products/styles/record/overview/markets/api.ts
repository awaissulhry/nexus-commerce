import { z } from 'zod'
import { styleMarketsView, type SetStyleMarketsBody, type StyleMarketsView } from '@nexus/factory-domain/product/markets/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../../lib/api/client'

/**
 * The markets a style is sold in (B-W2b-283, FU1:01): the Overview's calls, each answer checked against factory-domain's
 * product/markets contracts (apps/factory-api modules/product/markets).
 *
 *   GET /product/styles/:styleId/markets   product.styles.view: the list, the markets the pick offers, mayChange, refusal
 *   PUT /product/styles/:styleId/markets   product.styles.manage: {version, marketCodes} at the style's version
 */

export type { StyleMarketsView }
export type MarketChoice = StyleMarketsView['markets'][number]

const enc = encodeURIComponent
const answer = z.object({ markets: styleMarketsView })

export const readStyleMarkets = (api: ApiClient, styleId: string): Promise<StyleMarketsView> =>
  api.get(`/product/styles/${enc(styleId)}/markets`, { schema: answer }).then((value) => value.markets)

export const saveStyleMarkets = (api: ApiClient, styleId: string, body: SetStyleMarketsBody): Promise<StyleMarketsView> =>
  api.request('PUT', `/product/styles/${enc(styleId)}/markets`, { body, schema: answer, idempotencyKey: newIdempotencyKey() }).then((value) => value.markets)
