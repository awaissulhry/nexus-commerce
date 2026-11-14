import { defineContract } from '@nexus/factory-domain/core/contracts'
import { batchAnswer, batchesAnswer, batchesQuery, batchParams, cancelBody, candidatesAnswer, candidatesQuery, createBatchBody, issueBody, pickBody, settleBody, unpaidAnswer, unpaidQuery } from '@nexus/factory-domain/receivables/riba/contracts'

/** B-W2b-402: the route contracts of Ri.Ba. collections (the shapes are factory-domain's receivables/riba/contracts). */
export const candidatesContract = defineContract({ querystring: candidatesQuery, response: { 200: candidatesAnswer } })
export const listBatchesContract = defineContract({ querystring: batchesQuery, response: { 200: batchesAnswer } })
export const getBatchContract = defineContract({ params: batchParams, response: { 200: batchAnswer } })
export const createBatchContract = defineContract({ body: createBatchBody, response: { 201: batchAnswer } })
export const pickContract = defineContract({ params: batchParams, body: pickBody, response: { 200: batchAnswer } })
export const issueContract = defineContract({ params: batchParams, body: issueBody, response: { 200: batchAnswer } })
export const cancelBatchContract = defineContract({ params: batchParams, body: cancelBody, response: { 200: batchAnswer } })
export const settleContract = defineContract({ params: batchParams, body: settleBody, response: { 200: batchAnswer } })
export const unpaidContract = defineContract({ querystring: unpaidQuery, response: { 200: unpaidAnswer } })
