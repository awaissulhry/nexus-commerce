import { defineContract } from '@nexus/factory-domain/core/contracts'
import { inquiryParams, portalRequestList, portalRequestView, requestListQuery, requestsOpenAnswer, sendRequestAnswer, sendRequestBody } from '@nexus/factory-domain/sales/portal-requests/contracts'
import { output } from '@nexus/factory-domain/core/contracts'

/** The customer's requests in the portal (B-TH-010, B-TH-103, B-TH-012): the bodies and answers are factory-domain's sales/portal-requests/contracts. */
export const sendContract = defineContract({ body: sendRequestBody, response: { 201: sendRequestAnswer } })
export const listContract = defineContract({ querystring: requestListQuery, response: { 200: portalRequestList } })
export const recordContract = defineContract({ params: inquiryParams, response: { 200: output({ request: portalRequestView }) } })
export const openContract = defineContract({ response: { 200: requestsOpenAnswer } })
