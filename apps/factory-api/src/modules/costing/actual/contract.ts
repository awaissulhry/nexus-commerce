import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ledgerEntryView, ledgerQuery, postAnswer, reverseAnswer, reverseBody, workOrderCostsAnswer, workOrderCostsQuery, workOrderCostView } from '@nexus/factory-domain/costing/ledger/contracts'
import { z } from 'zod'
// B-W2b-F46: the cost read of a CLOSED work order says what arrived after the close.
import { afterCloseView } from '@nexus/factory-domain/costing/close/after-close'

/** The route contracts of standard vs actual and the cost ledger: the shapes are factory-domain's costing/ledger/contracts. */

const workOrder = input({ workOrderId: id() })

// B-PR-05: partyId = one customer's work orders / entries (inside the caller's reach: another customer's gives none).
export const workOrderCostsContract = defineContract({ querystring: workOrderCostsQuery.extend({ partyId: id().optional() }), response: { 200: workOrderCostsAnswer } })
// B-W2b-F46: + afterClose (null unless CLOSED).
export const workOrderCostContract = defineContract({ params: workOrder, response: { 200: output({ detail: workOrderCostView.extend({ afterClose: afterCloseView.nullable() }) }) } })
export const ledgerContract = defineContract({ querystring: ledgerQuery.extend({ partyId: id().optional() }), response: { 200: output({ entries: z.array(ledgerEntryView), nextCursor: id().nullable() }) } })
export const postNowContract = defineContract({ params: workOrder, response: { 200: postAnswer, 201: postAnswer } })
export const reverseContract = defineContract({ params: input({ entryId: id() }), body: reverseBody, response: { 200: reverseAnswer, 201: reverseAnswer } })
