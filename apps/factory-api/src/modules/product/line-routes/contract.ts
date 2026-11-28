import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { dropLineRouteExceptionQuery, lineRouteExceptionBody, lineRoutesView, pickLineRouteBody } from '@nexus/factory-domain/product/routing/line-route-contracts'

/** owb-pd2 2.4: the line routes' contracts (factory-domain product/routing/line-route-contracts). No money. Every answer: the order's line routes. */
const order = input({ orderId: id() })
const line = input({ orderId: id(), lineId: id() })
const answer = { 200: lineRoutesView }

export const lineRoutesContract = defineContract({ params: order, response: answer })
export const pickLineRouteContract = defineContract({ params: line, body: pickLineRouteBody, response: answer })
export const putLineExceptionContract = defineContract({ params: line, body: lineRouteExceptionBody, response: answer })
export const dropLineExceptionContract = defineContract({ params: line, querystring: dropLineRouteExceptionQuery, response: answer })
