import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ledgerEntryView, ledgerQuery, postAnswer, reverseAnswer, reverseBody, workOrderCostsAnswer, workOrderCostsQuery, workOrderCostView } from '@nexus/factory-domain/costing/ledger/contracts'
import { z } from 'zod'

/** The route contracts of standard vs actual and the cost ledger: the shapes are factory-domain's costing/ledger/contracts. */

const workOrder = input({ workOrderId: id() })

export const workOrderCostsContract = defineContract({ querystring: workOrderCostsQuery, response: { 200: workOrderCostsAnswer } })
export const workOrderCostContract = defineContract({ params: workOrder, response: { 200: output({ detail: workOrderCostView }) } })
export const ledgerContract = defineContract({ querystring: ledgerQuery, response: { 200: output({ entries: z.array(ledgerEntryView), nextCursor: id().nullable() }) } })
export const postNowContract = defineContract({ params: workOrder, response: { 200: postAnswer, 201: postAnswer } })
export const reverseContract = defineContract({ params: input({ entryId: id() }), body: reverseBody, response: { 200: reverseAnswer, 201: reverseAnswer } })
