import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { orderLogAnswerSchema, orderLogQuery, pictureSetAnswer, pictureSetBody } from '@nexus/factory-domain/sales/order-log/contract'

/**
 * owb- (order workflow, b3.1 + b3.2): the contracts of the order log and the order picture, office and portal — ONE answer shape
 * each (factory-domain sales/order-log/contract: the Shapes the web builders code against).
 */
export const officeOrderLogContract = defineContract({ params: input({ orderId: id() }), querystring: orderLogQuery, response: { 200: orderLogAnswerSchema } })
export const officeRequestLogContract = defineContract({ params: input({ requestId: id() }), querystring: orderLogQuery, response: { 200: orderLogAnswerSchema } })
export const portalOrderLogContract = defineContract({ params: input({ orderId: id() }), querystring: orderLogQuery, response: { 200: orderLogAnswerSchema } })
export const portalRequestLogContract = defineContract({ params: input({ requestId: id() }), querystring: orderLogQuery, response: { 200: orderLogAnswerSchema } })

export const orderPictureContract = defineContract({ params: input({ orderId: id() }), body: pictureSetBody, response: { 200: pictureSetAnswer } })
export const requestPictureContract = defineContract({ params: input({ requestId: id() }), body: pictureSetBody, response: { 200: pictureSetAnswer } })
