import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../quotes/preview'
import {
  createMinimumContract,
  deleteMinimumContract,
  discountDisplayContract,
  exportContract,
  getMinimumContract,
  getStyleSurchargesContract,
  listMinimumsContract,
  moveMinimumContract,
  orderLineChecksContract,
  quoteLineChecksContract,
  quoteListPricesContract,
  rulesContract,
  setBreaksContract,
  setDatedPricesContract,
  setStyleSurchargesContract,
  setVersionSurchargesContract,
  updateMinimumContract,
} from './contract'
import { priceListExportFile } from './export'
import { manifest } from './manifest'
import { createMinimum, deleteMinimum, getMinimum, listMinimums, moveMinimum, updateMinimum } from './minimums'
import { orderLineCheckView, quoteLineCheckView, quoteListPrices } from './quote-pricing'
import { readVersionFor, rulesViewOf } from './store'
import { getStyleSurcharges, setBreaks, setDatedPrices, setDiscountDisplay, setStyleSurcharges, setVersionSurcharges } from './writes'

/**
 * Price lists in depth (B-W2b-325): a version's quantity breaks and size surcharges (the record's Breaks & surcharges
 * tab), its dated prices (Prices › Valid from–to), the list's discount on documents, a style's own size surcharges, the
 * minimum order quantities, a version's prices as a file for the import (`sales.priceLists` on the imports routes), and
 * what a quote's lines take from their list and what the line rules say of a quote or an order.
 */
export default defineRoutes('sales.pricing-depth', manifest, async (app) => {
  app.get('/sales/price-lists/:listId/versions/:versionId/rules', { schema: rulesContract }, async (request) => {
    const { list, version } = await readVersionFor(request, request.params.listId, request.params.versionId)
    return request.withClient((client) => rulesViewOf(client, list, version))
  })

  app.put('/sales/price-lists/:listId/versions/:versionId/breaks', { schema: setBreaksContract }, async (request) => setBreaks(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.put('/sales/price-lists/:listId/versions/:versionId/size-surcharges', { schema: setVersionSurchargesContract }, async (request) =>
    setVersionSurcharges(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)),
  )

  app.put('/sales/price-lists/:listId/versions/:versionId/dated-prices', { schema: setDatedPricesContract }, async (request) =>
    setDatedPrices(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/sales/price-lists/:listId/versions/:versionId/export', { schema: exportContract }, async (request, reply) => {
    const file = await priceListExportFile(request, request.params.listId, request.params.versionId, request.query.format, request.query.numberFormat)
    return reply.type(file.contentType).header('content-disposition', inlineDisposition(file.fileName)).header('cache-control', 'no-store').send(file.body)
  })

  app.put('/sales/price-lists/:listId/discount-display', { schema: discountDisplayContract }, async (request) => setDiscountDisplay(request, request.params.listId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/styles/:styleId/size-surcharges', { schema: getStyleSurchargesContract }, async (request) => getStyleSurcharges(request, request.params.styleId))

  app.put('/sales/styles/:styleId/size-surcharges', { schema: setStyleSurchargesContract }, async (request) => setStyleSurcharges(request, request.params.styleId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/minimums', { schema: listMinimumsContract }, async (request) => listMinimums(request, request.query))

  app.get('/sales/minimums/:ruleId', { schema: getMinimumContract }, async (request) => getMinimum(request, request.params.ruleId))

  app.post('/sales/minimums', { schema: createMinimumContract }, async (request, reply) => reply.code(201).send(await createMinimum(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/minimums/:ruleId', { schema: updateMinimumContract }, async (request) => updateMinimum(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/minimums/:ruleId/archive', { schema: moveMinimumContract }, async (request) => moveMinimum(request, request.params.ruleId, 'archive', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/minimums/:ruleId/reactivate', { schema: moveMinimumContract }, async (request) => moveMinimum(request, request.params.ruleId, 'reactivate', request.body, idempotencyKeyFrom(request)))

  app.delete('/sales/minimums/:ruleId', { schema: deleteMinimumContract }, async (request) => deleteMinimum(request, request.params.ruleId, request.query, idempotencyKeyFrom(request)))

  app.get('/sales/quotes/:quoteId/list-prices', { schema: quoteListPricesContract }, async (request) => quoteListPrices(request, request.params.quoteId))

  app.get('/sales/quotes/:quoteId/line-checks', { schema: quoteLineChecksContract }, async (request) => quoteLineCheckView(request, request.params.quoteId))

  app.get('/sales/orders/:orderId/line-checks', { schema: orderLineChecksContract }, async (request) => orderLineCheckView(request, request.params.orderId))
})
