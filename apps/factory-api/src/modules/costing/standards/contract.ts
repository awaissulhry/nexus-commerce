import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  createStandardBody,
  freezeAnswer,
  preparedSkipView,
  prepareStandardsBody,
  standardCostRecordView,
  standardCostView,
  standardsQuery,
  updateStandardBody,
  versionBody,
} from '@nexus/factory-domain/costing/standards/contracts'
import { z } from 'zod'

/** The route contracts of standard costs: the shapes are factory-domain's costing/standards/contracts (figures money.cost). */

const standard = input({ standardId: id() })
const one = output({ standard: standardCostRecordView })

export const listStandardsContract = defineContract({ querystring: standardsQuery, response: { 200: output({ standards: z.array(standardCostView), nextCursor: id().nullable() }) } })
export const standardContract = defineContract({ params: standard, response: { 200: one } })
export const createStandardContract = defineContract({ body: createStandardBody, response: { 201: one } })
export const prepareStandardsContract = defineContract({ body: prepareStandardsBody, response: { 200: output({ prepared: z.array(standardCostRecordView), skipped: z.array(preparedSkipView) }) } })
export const updateStandardContract = defineContract({ params: standard, body: updateStandardBody, response: { 200: one } })
export const discardStandardContract = defineContract({ params: standard, body: versionBody, response: { 200: output({ id: id(), discarded: z.literal(true) }) } })
export const freezeStandardContract = defineContract({ params: standard, body: versionBody, response: { 200: freezeAnswer } })
