import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { readStyleMarketsContract, setStyleMarketsContract } from './contract'
import { manifest } from './manifest'
import { readStyleMarkets, setStyleMarkets } from './markets'

/**
 * The markets a style is sold in (B-W2b-283, FU1:01; ./markets.ts). The requirements gate reads the list through
 * ./store.ts (`styleMarketCodes`, `soldThereTargets`); the status board's "Not sold there" is B-W2b-288's.
 */
export default defineRoutes('product.markets', manifest, async (app) => {
  app.get('/product/styles/:styleId/markets', { schema: readStyleMarketsContract }, async (request) => ({ markets: await readStyleMarkets(request, request.params.styleId) }))
  app.put('/product/styles/:styleId/markets', { schema: setStyleMarketsContract }, async (request) => ({
    markets: await setStyleMarkets(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))
})
