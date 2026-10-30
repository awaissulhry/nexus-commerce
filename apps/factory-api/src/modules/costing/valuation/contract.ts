import { defineContract } from '@nexus/factory-domain/core/contracts'
import { layersAnswer, layersQuery, leatherAnswer, leatherQuery, valuationAnswer, valuationQuery } from '@nexus/factory-domain/costing/valuation/contracts'

/** The route contracts of the stock valuation: the shapes are factory-domain's costing/valuation/contracts. */

export const valuationContract = defineContract({ querystring: valuationQuery, response: { 200: valuationAnswer } })
export const layersContract = defineContract({ querystring: layersQuery, response: { 200: layersAnswer } })
export const leatherContract = defineContract({ querystring: leatherQuery, response: { 200: leatherAnswer } })
