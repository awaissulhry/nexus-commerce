import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  archiveRateBody,
  compareCostQuery,
  costCellsBody,
  costCellsView,
  costDiffView,
  costingSettingsView,
  costSheetQuery,
  costSheetView,
  createRateBody,
  labourRateView,
  listRatesQuery,
  saveSettingsBody,
  settingsListView,
  settingsQuery,
  updateRateBody,
} from '@nexus/factory-domain/costing/contracts'
import { z } from 'zod'

/** Costing's route contracts (A2 SCR-044): the bodies and answers are factory-domain's costing/contracts; every cost figure is money.cost. */

export const getCostSheetContract = defineContract({
  params: input({ styleId: id(), revisionId: id() }),
  querystring: costSheetQuery,
  response: { 200: output({ sheet: costSheetView }) },
})
export const compareCostContract = defineContract({ params: input({ styleId: id() }), querystring: compareCostQuery, response: { 200: output({ diff: costDiffView }) } })
export const costCellsContract = defineContract({ body: costCellsBody, response: { 200: output({ batch: costCellsView }) } })

const rate = input({ rateId: id() })
const oneRate = { 200: output({ rate: labourRateView }) }
export const listRatesContract = defineContract({ querystring: listRatesQuery, response: { 200: output({ rates: z.array(labourRateView) }) } })
export const createRateContract = defineContract({ body: createRateBody, response: { 201: output({ rate: labourRateView }) } })
export const updateRateContract = defineContract({ params: rate, body: updateRateBody, response: oneRate })
export const archiveRateContract = defineContract({ params: rate, body: archiveRateBody, response: oneRate })
export const getSettingsContract = defineContract({ querystring: settingsQuery, response: { 200: output({ settings: settingsListView }) } })
export const saveSettingsContract = defineContract({ body: saveSettingsBody, response: { 200: output({ settings: costingSettingsView }) } })
