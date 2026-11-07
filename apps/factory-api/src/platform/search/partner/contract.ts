import { defineContract } from '@nexus/factory-domain/core/contracts'
import { partnerSearchAnswer, partnerSearchQuery } from '@nexus/factory-domain/search/partner/contracts'

/**
 * Portal search (B-W2b-168; SAL-084; design portal.frame › top-bar, portal.customer.home › search-hero). The shapes are
 * factory-domain's search/partner/contracts, shared with the portal's web.
 */
export const partnerSearchContract = defineContract({
  querystring: partnerSearchQuery,
  response: { 200: partnerSearchAnswer },
})
