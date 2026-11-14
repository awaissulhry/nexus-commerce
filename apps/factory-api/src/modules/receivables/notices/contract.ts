import { defineContract } from '@nexus/factory-domain/core/contracts'
import { collectionsAnswer, collectionsBody, collectionsQuery, trustAnswer, trustBody, trustParams } from '@nexus/factory-domain/receivables/notices/contracts'

/** B-W2b-402: the route contracts of the trusted levels and the collections switches (factory-domain's receivables/notices/contracts). */
export const getTrustContract = defineContract({ params: trustParams, response: { 200: trustAnswer } })
export const putTrustContract = defineContract({ params: trustParams, body: trustBody, response: { 200: trustAnswer } })
export const getCollectionsContract = defineContract({ querystring: collectionsQuery, response: { 200: collectionsAnswer } })
export const putCollectionsContract = defineContract({ body: collectionsBody, response: { 200: collectionsAnswer } })
