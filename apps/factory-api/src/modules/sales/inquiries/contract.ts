
import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import {
  assignBody,
  assigneesView,
  bulkAnswer,
  bulkAssignBody,
  bulkDeclineBody,
  createInquiryBody,
  declineBody,
  fromMailBody,
  inquiryAnswer,
  inquiryList,
  inquiryListQuery,
  inquiryParams,
  loseBody,
  mailDraftView,
  mailParams,
  quoteAnswer,
  quoteBody,
  sourceQuery,
  sourceView,
  updateInquiryBody,
  versionBody,
} from '@nexus/factory-domain/sales/inquiries/contracts'

/** The inquiries' contracts (B-W2b-295): the bodies and answers are factory-domain's sales/inquiries/contracts. */

const answer = { 200: inquiryAnswer }

export const listInquiriesContract = defineContract({ querystring: inquiryListQuery, response: { 200: inquiryList } })
export const readInquiryContract = defineContract({ params: inquiryParams, response: answer })
export const createInquiryContract = defineContract({ body: createInquiryBody, response: { 201: inquiryAnswer } })
export const updateInquiryContract = defineContract({ params: inquiryParams, body: updateInquiryBody, response: answer })
export const assignInquiryContract = defineContract({ params: inquiryParams, body: assignBody, response: answer })
export const bulkAssignContract = defineContract({ body: bulkAssignBody, response: { 200: bulkAnswer } })
export const askInfoContract = defineContract({ params: inquiryParams, body: versionBody, response: answer })
export const resumeContract = defineContract({ params: inquiryParams, body: versionBody, response: answer })
export const declineInquiryContract = defineContract({ params: inquiryParams, body: declineBody, response: answer })
export const bulkDeclineContract = defineContract({ body: bulkDeclineBody, response: { 200: bulkAnswer } })
export const loseInquiryContract = defineContract({ params: inquiryParams, body: loseBody, response: answer })
export const quoteInquiryContract = defineContract({ params: inquiryParams, body: quoteBody, response: { 201: quoteAnswer } })
export const mailDraftContract = defineContract({ params: mailParams, response: { 200: mailDraftView } })
export const fromMailContract = defineContract({ params: mailParams, body: fromMailBody, response: { 201: inquiryAnswer } })
export const sourceContract = defineContract({ querystring: sourceQuery, response: { 200: sourceView } })
export const assigneesContract = defineContract({ querystring: input({ companyId: id(), partyId: id().optional() }), response: { 200: assigneesView } })


