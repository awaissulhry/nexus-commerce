import { defineRoutes } from '../../../core/manifest'
import { partnerSearchContract } from '../../search/partner/contract'
import { searchForPartner } from '../../search/partner/search'
import { manifest } from './manifest'

/**
 * Portal search (B-W2b-168; SAL-084; design portal.frame › top-bar, portal.customer.home › search-hero). The work is
 * platform/search/partner (this folder holds the route only: the route loader does not look under platform/search, which
 * has its own routes file).
 *   GET /portal/search?q=&group=&limit=   the partner's own records by their references and ours, grouped
 */
export default defineRoutes('portal-search', manifest, async (app) => {
  app.get('/portal/search', { schema: partnerSearchContract }, async (request) => searchForPartner(request, request.query))
})
