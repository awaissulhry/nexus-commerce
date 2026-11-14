import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { cogsAnswer, cogsPostAnswer, cogsPostBody, cogsQuery, cogsReverseAnswer, cogsReverseBody } from '@nexus/factory-domain/costing/cost-of-sales/contracts'

/** The route contracts of cost of goods sold: factory-domain's costing/cost-of-sales shapes. */

export const cogsListContract = defineContract({ querystring: cogsQuery, response: { 200: cogsAnswer } })
export const cogsPostContract = defineContract({ body: cogsPostBody, response: { 200: cogsPostAnswer, 201: cogsPostAnswer } })
export const cogsReverseContract = defineContract({ params: input({ entryId: id() }), body: cogsReverseBody, response: { 200: cogsReverseAnswer, 201: cogsReverseAnswer } })
