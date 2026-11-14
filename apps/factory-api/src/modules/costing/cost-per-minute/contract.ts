import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  applyCalcAnswer,
  applyCalcBody,
  calcListQuery,
  calcRecordView,
  calcView,
  createCalcBody,
  prefillQuery,
  prefillView,
  removeCalcQuery,
  updateCalcBody,
} from '@nexus/factory-domain/costing/cost-per-minute/contracts'
import { z } from 'zod'

/** The route contracts of the cost-per-minute calculator: the shapes are factory-domain's costing/cost-per-minute/contracts (figures money.cost). */

const calc = input({ calcId: id() })
const one = output({ calc: calcRecordView })

export const listCalcsContract = defineContract({ querystring: calcListQuery, response: { 200: output({ calcs: z.array(calcView), nextCursor: id().nullable() }) } })
export const prefillContract = defineContract({ querystring: prefillQuery, response: { 200: output({ prefill: prefillView }) } })
export const calcContract = defineContract({ params: calc, response: { 200: one } })
export const createCalcContract = defineContract({ body: createCalcBody, response: { 201: one } })
export const updateCalcContract = defineContract({ params: calc, body: updateCalcBody, response: { 200: one } })
export const removeCalcContract = defineContract({ params: calc, querystring: removeCalcQuery, response: { 200: output({ id: id(), removed: z.literal(true) }) } })
export const applyCalcContract = defineContract({ params: calc, body: applyCalcBody, response: { 200: applyCalcAnswer } })
