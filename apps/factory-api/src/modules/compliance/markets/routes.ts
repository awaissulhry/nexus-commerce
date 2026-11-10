import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createMarketContract, editMarketContract, getMarketContract, languagesContract, listMarketsContract, switchMarketContract } from './contract'
import { manifest } from './manifest'
import { createMarket, editMarket, getMarket, listMarkets, marketLanguages, switchMarket } from './markets'

/**
 * Market profiles (B-W2b-249; PRD-275): languages for the label, the DoC and the user information, marks, national
 * rules, importer and GPSR contact needs, switched on or off with the reason. The screen is B-W2b-265 (Rules & markets ›
 * Markets, the LanguageMatrix); labels, DoCs, user information and the gates read the markets by code.
 */
export default defineRoutes('compliance.markets', manifest, async (app) => {
  app.get('/compliance/rules/markets', { schema: listMarketsContract }, async (request) => listMarkets(request, request.query))
  app.get('/compliance/rules/markets/languages', { schema: languagesContract }, async (request) => marketLanguages(request))
  app.post('/compliance/rules/markets', { schema: createMarketContract }, async (request) => createMarket(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/rules/markets/:code', { schema: getMarketContract }, async (request) => getMarket(request, request.params.code))
  app.patch('/compliance/rules/markets/:code', { schema: editMarketContract }, async (request) => editMarket(request, request.params.code, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/rules/markets/:code/switch', { schema: switchMarketContract }, async (request) => switchMarket(request, request.params.code, request.body, idempotencyKeyFrom(request)))
})
