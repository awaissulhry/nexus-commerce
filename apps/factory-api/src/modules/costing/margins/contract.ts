import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { marginsAnswer, marginsQuery, orderMarginView } from '@nexus/factory-domain/costing/margins/contracts'
import { addCostLineBody, removeCostLineBody, setTargetBody } from '@nexus/factory-domain/costing/margins/contracts' // B-OM-021

/** The route contracts of order margin: the shapes are factory-domain's costing/margins/contracts. */

export const marginsContract = defineContract({ querystring: marginsQuery, response: { 200: marginsAnswer } })
export const orderMarginContract = defineContract({ params: input({ orderId: id() }), response: { 200: orderMarginView } })

// ── B-OM-021 (order money tab; lead L2, L4): hand cost lines (added only) and the order's target; each answers the profitability ──
export const addCostLineContract = defineContract({ params: input({ orderId: id() }), body: addCostLineBody, response: { 200: orderMarginView } })
export const removeCostLineContract = defineContract({ params: input({ orderId: id(), lineId: id() }), body: removeCostLineBody, response: { 200: orderMarginView } })
export const setTargetContract = defineContract({ params: input({ orderId: id() }), body: setTargetBody, response: { 200: orderMarginView } })
// ── end B-OM-021 ──
