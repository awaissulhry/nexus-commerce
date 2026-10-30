import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import {
  addLinesContract,
  cancelShipmentContract,
  changeLineContract,
  createShipmentContract,
  getShipmentContract,
  listShipmentsContract,
  packingListContract,
  readyContract,
  backordersContract,
  orderBackorderContract,
  packingListsContract,
  setFreightContract,
  getFreightRuleContract,
  saveFreightRuleContract,
  removeLineContract,
  updateShipmentContract,
} from './contract'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { listBackorders, orderBackorder } from './backorder'
import { getFreightRule, saveFreightRule, setFreight } from './freight'
import { manifest } from './manifest'
import { packingList, packingLists } from './packing-list'
import { readyToShip } from './ready'
import { addLines, cancelShipment, changeLine, createShipment, getShipment, listShipments, removeLine, updateShipment } from './shipments'

/**
 * Shipments from released goods only (B-W1-46; LOG-001, LOG-002, LOG-039, GAP-002; A2 SCR-066, SCR-067): what is ready
 * to ship, the shipments list and record, a DRAFT planned from a sales order, its lines and delivery details,
 * cancelling, the packing list. Packing (parcels, serials, packed) is ../packing; leaving with the DDT is B-W1-47.
 */
export default defineRoutes('shipping.shipments', manifest, async (app) => {
  app.get('/shipping/ready', { schema: readyContract }, async (request) => readyToShip(request, request.query))

  app.get('/shipping/shipments', { schema: listShipmentsContract }, async (request) => listShipments(request, request.query))

  app.get('/shipping/shipments/:shipmentId', { schema: getShipmentContract }, async (request) => getShipment(request, request.params.shipmentId))

  app.post('/shipping/shipments', { schema: createShipmentContract }, async (request, reply) => reply.code(201).send(await createShipment(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/shipping/shipments/:shipmentId', { schema: updateShipmentContract }, async (request) => updateShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/lines', { schema: addLinesContract }, async (request) => addLines(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.patch('/shipping/shipments/:shipmentId/lines/:lineId', { schema: changeLineContract }, async (request) =>
    changeLine(request, request.params.shipmentId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.delete('/shipping/shipments/:shipmentId/lines/:lineId', { schema: removeLineContract }, async (request) =>
    removeLine(request, request.params.shipmentId, request.params.lineId, request.query, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/cancel', { schema: cancelShipmentContract }, async (request) => cancelShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/packing-list', { schema: packingListContract }, async (request, reply) =>
    reply.code(201).send(await packingList(processFiles(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-48: shipping every day.
  app.get('/shipping/backorders', { schema: backordersContract }, async (request) => listBackorders(request, request.query))

  app.get('/shipping/orders/:salesOrderId/backorder', { schema: orderBackorderContract }, async (request) => orderBackorder(request, request.params.salesOrderId, request.query))

  app.get('/shipping/shipments/:shipmentId/packing-lists', { schema: packingListsContract }, async (request) => packingLists(request, request.params.shipmentId))

  app.put('/shipping/shipments/:shipmentId/freight', { schema: setFreightContract }, async (request) => {
    if (request.body.freightCharge === undefined) throw new ValidationError('Give the freight charged (minor units), or null for the site\'s rule.', [{ path: 'body/freightCharge', message: 'Required (null: back to the rule).' }])
    return setFreight(request, request.params.shipmentId, { version: request.body.version, freightCharge: request.body.freightCharge }, idempotencyKeyFrom(request))
  })

  app.get('/shipping/sites/:siteId/freight-rule', { schema: getFreightRuleContract }, async (request) => getFreightRule(request, request.params.siteId))

  app.put('/shipping/sites/:siteId/freight-rule', { schema: saveFreightRuleContract }, async (request) => saveFreightRule(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))
})
