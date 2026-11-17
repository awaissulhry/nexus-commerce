
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
  askInfoBody,
  // B-TH-025 / B-TH-026
  orderAnswer,
  orderBody,
  styleDraftAnswer,
  styleDraftBody,
  inquiryPictureView,
  // B-TH-042
  customerCheckView,
  makeCustomerAnswer,
  makeCustomerBody,
} from '@nexus/factory-domain/sales/inquiries/contracts'

/** The inquiries' contracts (B-W2b-295): the bodies and answers are factory-domain's sales/inquiries/contracts. */

const answer = { 200: inquiryAnswer }

export const listInquiriesContract = defineContract({ querystring: inquiryListQuery, response: { 200: inquiryList } })
export const readInquiryContract = defineContract({ params: inquiryParams, response: answer })
export const createInquiryContract = defineContract({ body: createInquiryBody, response: { 201: inquiryAnswer } })
export const updateInquiryContract = defineContract({ params: inquiryParams, body: updateInquiryBody, response: answer })
export const assignInquiryContract = defineContract({ params: inquiryParams, body: assignBody, response: answer })
export const bulkAssignContract = defineContract({ body: bulkAssignBody, response: { 200: bulkAnswer } })
// B-TH-013: the question travels with the move to NEED_INFO.
export const askInfoContract = defineContract({ params: inquiryParams, body: askInfoBody, response: answer })
export const resumeContract = defineContract({ params: inquiryParams, body: versionBody, response: answer })
export const declineInquiryContract = defineContract({ params: inquiryParams, body: declineBody, response: answer })
export const bulkDeclineContract = defineContract({ body: bulkDeclineBody, response: { 200: bulkAnswer } })
export const loseInquiryContract = defineContract({ params: inquiryParams, body: loseBody, response: answer })
export const quoteInquiryContract = defineContract({ params: inquiryParams, body: quoteBody, response: { 201: quoteAnswer } })
export const mailDraftContract = defineContract({ params: mailParams, response: { 200: mailDraftView } })
export const fromMailContract = defineContract({ params: mailParams, body: fromMailBody, response: { 201: inquiryAnswer } })
export const sourceContract = defineContract({ querystring: sourceQuery, response: { 200: sourceView } })
// B-TH-025: Make order (201: the order made). B-TH-026: Make style draft (201: the draft made).
export const orderInquiryContract = defineContract({ params: inquiryParams, body: orderBody, response: { 201: orderAnswer } })
export const styleDraftContract = defineContract({ params: inquiryParams, body: styleDraftBody, response: { 201: styleDraftAnswer } })
export const assigneesContract = defineContract({ querystring: input({ companyId: id(), partyId: id().optional() }), response: { 200: assigneesView } })
// B-TH-216 (Sales › Incoming): the Picture cell's small preview.
export const inquiryPictureContract = defineContract({ params: inquiryParams, response: { 200: inquiryPictureView } })
// B-TH-042: answer a new customer — the check, and the customer made or matched.
export const customerCheckContract = defineContract({ params: inquiryParams, response: { 200: customerCheckView } })
export const makeCustomerContract = defineContract({ params: inquiryParams, body: makeCustomerBody, response: { 200: makeCustomerAnswer } })
