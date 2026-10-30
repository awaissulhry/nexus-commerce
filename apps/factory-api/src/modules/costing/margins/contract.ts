import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { marginsAnswer, marginsQuery, orderMarginView } from '@nexus/factory-domain/costing/margins/contracts'

/** The route contracts of order margin: the shapes are factory-domain's costing/margins/contracts. */

export const marginsContract = defineContract({ querystring: marginsQuery, response: { 200: marginsAnswer } })
export const orderMarginContract = defineContract({ params: input({ orderId: id() }), response: { 200: orderMarginView } })
