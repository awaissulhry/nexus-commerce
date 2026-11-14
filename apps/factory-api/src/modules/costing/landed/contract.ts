import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { z } from 'zod'
import { landedAllocationAnswer, landedAnswer, landedChangeBody, landedCreateBody, landedPostBody, landedQuery, landedRemoveQuery, landedReverseBody } from '@nexus/factory-domain/costing/landed/contracts'

/** The route contracts of landed cost: factory-domain's costing/landed shapes. */

const allocation = input({ allocationId: id() })

export const landedListContract = defineContract({ querystring: landedQuery, response: { 200: landedAnswer } })
export const landedDetailContract = defineContract({ params: allocation, response: { 200: landedAllocationAnswer } })
export const landedCreateContract = defineContract({ body: landedCreateBody, response: { 201: landedAllocationAnswer, 200: landedAllocationAnswer } })
export const landedChangeContract = defineContract({ params: allocation, body: landedChangeBody, response: { 200: landedAllocationAnswer } })
export const landedRemoveContract = defineContract({ params: allocation, querystring: landedRemoveQuery, response: { 200: output({ id: id(), removed: z.literal(true) }) } })
export const landedPostContract = defineContract({ params: allocation, body: landedPostBody, response: { 200: landedAllocationAnswer } })
export const landedReverseContract = defineContract({ params: allocation, body: landedReverseBody, response: { 200: landedAllocationAnswer } })
