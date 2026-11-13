import { defineContract } from '@nexus/factory-domain/core/contracts'
import { warningsParams, warningsView } from '@nexus/factory-domain/sales/quote-warnings/contracts'

/** The quote's Warnings section (B-W2b-294): the answer is factory-domain's sales/quote-warnings/contracts. */
export const warningsContract = defineContract({ params: warningsParams, response: { 200: warningsView } })
