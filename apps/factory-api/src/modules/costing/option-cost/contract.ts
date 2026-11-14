import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { groupCostsQuery, groupCostsView, setValueDeltaBody, styleOptionCostsQuery, styleOptionCostsView, valueDeltaView } from '@nexus/factory-domain/costing/option-cost/contracts'

/** The route contracts of an option's own cost: the shapes are factory-domain's costing/option-cost/contracts (costs money.cost). */
export const styleOptionCostsContract = defineContract({ params: input({ styleId: id() }), querystring: styleOptionCostsQuery, response: { 200: styleOptionCostsView } })
export const groupCostsContract = defineContract({ params: input({ groupId: id() }), querystring: groupCostsQuery, response: { 200: groupCostsView } })
export const setValueDeltaContract = defineContract({ params: input({ groupId: id(), valueId: id() }), body: setValueDeltaBody, response: { 200: valueDeltaView } })
