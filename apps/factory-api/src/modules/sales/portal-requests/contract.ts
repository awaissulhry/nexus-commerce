import { defineContract } from '@nexus/factory-domain/core/contracts'
import { inquiryParams, portalRequestList, portalRequestView, requestListQuery, requestsOpenAnswer, sendRequestAnswer, sendRequestBody } from '@nexus/factory-domain/sales/portal-requests/contracts'
import { output } from '@nexus/factory-domain/core/contracts'
// B-TH-085: the request takes files after Send (the composer's upload bodies).
import { z } from 'zod'
import { id, input } from '@nexus/factory-domain/core/contracts'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH, THREAD_STATUSES } from '@nexus/factory-domain/threads/rules'
import { partnerFileBody, partnerFileView, partnerMessageView, partnerUploadAnswer } from '../../../platform/threads/partner/contract'

/** The customer's requests in the portal (B-TH-010, B-TH-103, B-TH-012): the bodies and answers are factory-domain's sales/portal-requests/contracts. */
export const sendContract = defineContract({ body: sendRequestBody, response: { 201: sendRequestAnswer } })
export const listContract = defineContract({ querystring: requestListQuery, response: { 200: portalRequestList } })
export const recordContract = defineContract({ params: inquiryParams, response: { 200: output({ request: portalRequestView }) } })
export const openContract = defineContract({ response: { 200: requestsOpenAnswer } })

// ---- B-TH-085: the request takes files after Send (the composer's upload bodies, platform/threads/partner/contract) -------------
const fileParams = input({ inquiryId: id(), fileId: id() })
export const requestFileContract = defineContract({ params: inquiryParams, body: input(partnerFileBody), response: { 201: partnerUploadAnswer } })
export const requestFileDoneContract = defineContract({ params: fileParams, response: { 200: output({ file: partnerFileView }) } })
export const attachRequestFilesContract = defineContract({
  params: inquiryParams,
  body: input({
    /** The files sent to this request (each available: after the virus scan), in order. */
    fileIds: z.array(id()).min(1).max(MAX_ATTACHMENTS),
    /** A few words with them (optional). */
    body: z.string().max(MAX_BODY_LENGTH).nullish(),
  }),
  response: { 201: output({ thread: output({ id: id(), status: z.enum(THREAD_STATUSES) }), message: partnerMessageView }) },
})
// ---- end B-TH-085
