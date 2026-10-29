import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { compareCostQuery, costCellsBody, costCellsView, costDiffView, costSheetQuery, costSheetView } from '@nexus/factory-domain/costing/contracts'

/** Costing's route contracts (A2 SCR-044): the bodies and answers are factory-domain's costing/contracts; every cost figure is money.cost. */

export const getCostSheetContract = defineContract({
  params: input({ styleId: id(), revisionId: id() }),
  querystring: costSheetQuery,
  response: { 200: output({ sheet: costSheetView }) },
})
export const compareCostContract = defineContract({ params: input({ styleId: id() }), querystring: compareCostQuery, response: { 200: output({ diff: costDiffView }) } })
export const costCellsContract = defineContract({ body: costCellsBody, response: { 200: output({ batch: costCellsView }) } })
