import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { addCurrencyContract, currenciesContract, listRatesContract, rateOfDayContract, readEcbContract, removeManualRateContract, setManualRateContract, switchCurrencyContract, switchFeedContract } from './contract'
import { addCurrency, currenciesOf, switchCurrency } from './currencies'
import { readEcbNow, switchFeed } from './feed'
import { manifest } from './manifest'
import { listRates, rateOfDay, removeManualRate, setManualRate } from './rates'

/**
 * Currencies and exchange rates (B-W2b-389; design finance.settings "Currencies & rates"):
 *   GET    /currencies?companyId                       the company's base and document currencies, today's rates, the switch
 *   POST   /currencies                                 a document currency added (or switched on again)
 *   POST   /currencies/:currencyId/switch              switched off or on (the base currency never off)
 *   GET    /exchange-rates?quote&source&from&to        the rates table per day (ECB and manual side by side)
 *   GET    /exchange-rates/day?base&quote&day          the rate a document of that day takes
 *   PUT    /exchange-rates/manual                      a manual rate of a day kept or corrected
 *   DELETE /exchange-rates/manual/:rateId?version=     a manual rate removed (the day falls back to the ECB's)
 *   PUT    /exchange-rates/feed                        the daily ECB rates switched on or off
 *   POST   /exchange-rates/fetch                       the ECB's file read now
 */
export default defineRoutes('currency', manifest, async (app) => {
  app.get('/currencies', { schema: currenciesContract }, async (request) => currenciesOf(request, request.query))
  app.post('/currencies', { schema: addCurrencyContract }, async (request, reply) => reply.code(201).send(await addCurrency(request, request.body, idempotencyKeyFrom(request))))
  app.post('/currencies/:currencyId/switch', { schema: switchCurrencyContract }, async (request) => switchCurrency(request, request.params.currencyId, request.body, idempotencyKeyFrom(request)))
  app.get('/exchange-rates', { schema: listRatesContract }, async (request) => listRates(request, request.query))
  app.get('/exchange-rates/day', { schema: rateOfDayContract }, async (request) => rateOfDay(request, request.query))
  app.put('/exchange-rates/manual', { schema: setManualRateContract }, async (request) => setManualRate(request, request.body, idempotencyKeyFrom(request)))
  app.delete('/exchange-rates/manual/:rateId', { schema: removeManualRateContract }, async (request) => removeManualRate(request, request.params.rateId, request.query, idempotencyKeyFrom(request)))
  app.put('/exchange-rates/feed', { schema: switchFeedContract }, async (request) => switchFeed(request, request.body, idempotencyKeyFrom(request)))
  app.post('/exchange-rates/fetch', { schema: readEcbContract }, async (request) => readEcbNow(request, idempotencyKeyFrom(request)))
})
