import { z } from 'zod'
import { defineContract, id, output } from '@nexus/factory-domain/core/contracts'
import {
  cancelRoundBody,
  createRoundBody,
  createShipmentBody,
  moveRoundBody,
  removeShipmentQuery,
  roundList,
  roundListQuery,
  roundParams,
  roundView,
  shipmentParams,
  shipmentView,
  updateRoundBody,
  updateShipmentBody,
  workOrderBody,
  workOrderOptionsView,
} from '@nexus/factory-domain/sales/samples/contracts'

/** The sample rounds' contracts (B-W2b-246): the bodies and answers are factory-domain's sales/samples/contracts. */

const round = { 200: output({ round: roundView }) }
const withShipment = output({ shipment: shipmentView.optional(), round: roundView })

export const listRoundsContract = defineContract({ querystring: roundListQuery, response: { 200: roundList } })
export const readRoundContract = defineContract({ params: roundParams, response: round })
export const createRoundContract = defineContract({ body: createRoundBody, response: { 201: output({ round: roundView }) } })
export const updateRoundContract = defineContract({ params: roundParams, body: updateRoundBody, response: round })
export const moveRoundContract = defineContract({ params: roundParams, body: moveRoundBody, response: round })
export const cancelRoundContract = defineContract({ params: roundParams, body: cancelRoundBody, response: round })
export const workOrderOptionsContract = defineContract({ params: roundParams, response: { 200: workOrderOptionsView } })
export const makeWorkOrderContract = defineContract({
  params: roundParams,
  body: workOrderBody,
  response: { 201: output({ workOrder: output({ id: id(), number: z.string(), status: z.string() }), round: roundView }) },
})
export const addShipmentContract = defineContract({ params: roundParams, body: createShipmentBody, response: { 201: withShipment } })
export const updateShipmentContract = defineContract({ params: shipmentParams, body: updateShipmentBody, response: { 200: withShipment } })
export const removeShipmentContract = defineContract({ params: shipmentParams, querystring: removeShipmentQuery, response: round })
