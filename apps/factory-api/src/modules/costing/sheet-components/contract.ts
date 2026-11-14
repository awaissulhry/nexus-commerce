import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  archiveBody,
  componentsQuery,
  componentsView,
  createLeatherBasisBody,
  createUpliftBody,
  landedQuery,
  landedView,
  leatherBasesQuery,
  leatherBasisView,
  pieceRateLabourQuery,
  pieceRateLabourView,
  setPieceRateLabourBody,
  sheetSplitView,
  updateLeatherBasisBody,
  updateUpliftBody,
  upliftsQuery,
  upliftView,
  workOrderSplitView,
  writeComponentsAnswer,
  writeComponentsBody,
} from '@nexus/factory-domain/costing/sheet-components/contracts'
import { z } from 'zod'

/** The route contracts of the cost sheet's components: the shapes are factory-domain's costing/sheet-components/contracts (costs money.cost). */

const basis = input({ basisId: id() })
const uplift = input({ upliftId: id() })
const sheet = input({ sheetId: id() })

export const componentsContract = defineContract({ params: input({ styleId: id(), revisionId: id() }), querystring: componentsQuery, response: { 200: componentsView } })
export const writeComponentsContract = defineContract({ params: sheet, body: writeComponentsBody, response: { 200: writeComponentsAnswer } })
export const sheetSplitContract = defineContract({ params: sheet, response: { 200: sheetSplitView } })
export const workOrderSplitContract = defineContract({ params: input({ workOrderId: id() }), response: { 200: workOrderSplitView } })

export const listLeatherBasesContract = defineContract({ querystring: leatherBasesQuery, response: { 200: output({ bases: z.array(leatherBasisView) }) } })
export const leatherBasisContract = defineContract({ params: basis, response: { 200: output({ basis: leatherBasisView }) } })
export const createLeatherBasisContract = defineContract({ body: createLeatherBasisBody, response: { 201: output({ basis: leatherBasisView }) } })
export const updateLeatherBasisContract = defineContract({ params: basis, body: updateLeatherBasisBody, response: { 200: output({ basis: leatherBasisView }) } })
export const archiveLeatherBasisContract = defineContract({ params: basis, body: archiveBody, response: { 200: output({ basis: leatherBasisView }) } })

export const listUpliftsContract = defineContract({ querystring: upliftsQuery, response: { 200: output({ uplifts: z.array(upliftView) }) } })
export const landedContract = defineContract({ querystring: landedQuery, response: { 200: landedView } })
export const upliftContract = defineContract({ params: uplift, response: { 200: output({ uplift: upliftView }) } })
export const createUpliftContract = defineContract({ body: createUpliftBody, response: { 201: output({ uplift: upliftView }) } })
export const updateUpliftContract = defineContract({ params: uplift, body: updateUpliftBody, response: { 200: output({ uplift: upliftView }) } })
export const archiveUpliftContract = defineContract({ params: uplift, body: archiveBody, response: { 200: output({ uplift: upliftView }) } })

export const pieceRateLabourContract = defineContract({ querystring: pieceRateLabourQuery, response: { 200: pieceRateLabourView } })
export const setPieceRateLabourContract = defineContract({ body: setPieceRateLabourBody, response: { 200: pieceRateLabourView } })
