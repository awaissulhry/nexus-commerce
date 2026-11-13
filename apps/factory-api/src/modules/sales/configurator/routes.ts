import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { announceOrderArtwork, announceQuoteArtwork } from './artwork'
import {
  checkOrderLineContract,
  checkQuoteLineContract,
  orderArtworkContract,
  orderLineConfiguratorContract,
  quoteArtworkContract,
  quoteLineConfiguratorContract,
  saveOrderOptionsContract,
  saveQuoteOptionsContract,
  styleConfiguratorContract,
} from './contract'
import { checkOrderLine, checkQuoteLine, orderLineConfigurator, quoteLineConfigurator, saveOrderOptions, saveQuoteOptions } from './line'
import { manifest } from './manifest'
import { styleConfigurator } from './style'

/**
 * The configurator on a quote or order line (B-W2b-340): a line's configurator (the style's options with their rules and
 * surcharges, panel colours and leathers, the chosen values, the check, the price, margin and picture, the artwork), a choice
 * checked without writing, the choice written (a quote line priced again through its waterfall; an order line keeps its
 * accepted price), artwork announced, and a style's configurator for "Test a combination".
 */
export default defineRoutes('sales.configurator', manifest, async (app) => {
  app.get('/sales/configurator/styles/:styleId', { schema: styleConfiguratorContract }, async (request) => styleConfigurator(request, request.params.styleId, request.query))

  app.get('/sales/quotes/:quoteId/lines/:lineId/configurator', { schema: quoteLineConfiguratorContract }, async (request) => quoteLineConfigurator(request, request.params.quoteId, request.params.lineId))

  app.post('/sales/quotes/:quoteId/lines/:lineId/configurator/check', { schema: checkQuoteLineContract }, async (request) => checkQuoteLine(request, request.params.quoteId, request.params.lineId, request.body))

  app.put('/sales/quotes/:quoteId/lines/:lineId/options', { schema: saveQuoteOptionsContract }, async (request) => saveQuoteOptions(request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/lines/:lineId/artwork', { schema: quoteArtworkContract }, async (request, reply) =>
    reply.code(201).send(await announceQuoteArtwork(processFiles(), request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/sales/orders/:orderId/lines/:lineId/configurator', { schema: orderLineConfiguratorContract }, async (request) => orderLineConfigurator(request, request.params.orderId, request.params.lineId))

  app.post('/sales/orders/:orderId/lines/:lineId/configurator/check', { schema: checkOrderLineContract }, async (request) => checkOrderLine(request, request.params.orderId, request.params.lineId, request.body))

  app.put('/sales/orders/:orderId/lines/:lineId/options', { schema: saveOrderOptionsContract }, async (request) => saveOrderOptions(request, request.params.orderId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/lines/:lineId/artwork', { schema: orderArtworkContract }, async (request, reply) =>
    reply.code(201).send(await announceOrderArtwork(processFiles(), request, request.params.orderId, request.params.lineId, request.body, idempotencyKeyFrom(request))),
  )
})
