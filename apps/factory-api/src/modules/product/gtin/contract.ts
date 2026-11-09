import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import {
  assignBody,
  assignView,
  createRangeBody,
  importBody,
  importView,
  rangeParams,
  rangeStatusBody,
  rangesQuery,
  rangesView,
  rangeView,
  styleParams,
  updateRangeBody,
} from '@nexus/factory-domain/product/gtin/contracts'

/** The GTIN routes' contracts (B-W2b-227): the bodies and answers are factory-domain's product/gtin/contracts. */

const range = { 200: output({ range: rangeView }) }

export const listRangesContract = defineContract({ querystring: rangesQuery, response: { 200: rangesView } })
export const createRangeContract = defineContract({ body: createRangeBody, response: { 201: output({ range: rangeView }) } })
export const updateRangeContract = defineContract({ params: rangeParams, body: updateRangeBody, response: range })
export const rangeStatusContract = defineContract({ params: rangeParams, body: rangeStatusBody, response: range })
export const assignContract = defineContract({ params: styleParams, body: assignBody, response: { 200: output({ assignment: assignView }) } })
export const importContract = defineContract({ body: importBody, response: { 200: output({ import: importView }) } })
