import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { bySizeView, putSizeWeightsBody, sizeWeightsQuery, sizeWeightsView } from '@nexus/factory-domain/costing/size-weights/contracts'

/** The route contracts of size weights and the cost by size: the shapes are factory-domain's costing/size-weights/contracts. */

export const sizeWeightsContract = defineContract({ querystring: sizeWeightsQuery, response: { 200: sizeWeightsView } })
export const setSizeWeightsContract = defineContract({ body: putSizeWeightsBody, response: { 200: output({ styleId: id() }) } })
export const bySizeContract = defineContract({ params: input({ sheetId: id() }), response: { 200: bySizeView } })
