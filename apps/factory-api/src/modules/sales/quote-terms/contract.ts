import { defineContract } from '@nexus/factory-domain/core/contracts'
import { lineParams, quoteParams, scheduleBody, termsBody, termsView } from '@nexus/factory-domain/sales/quote-terms/contracts'

/** A quote's delivery terms and schedule (B-W2b-294): the bodies and answers are factory-domain's sales/quote-terms/contracts. */

export const getTermsContract = defineContract({ params: quoteParams, response: { 200: termsView } })
export const saveTermsContract = defineContract({ params: quoteParams, body: termsBody, response: { 200: termsView } })
export const saveScheduleContract = defineContract({ params: lineParams, body: scheduleBody, response: { 200: termsView } })
