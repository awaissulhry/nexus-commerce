import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Portal search (B-W2b-168; SAL-084; design portal.frame › top-bar "Search orders, documents… (your PO number works)" and
 * portal.customer.home › search-hero). A partner permission (flagged `partner`: held only by partner roles, never by an
 * office or floor role): every main partner role holds it (../../auth/roles/templates PARTNER_ADDS). What a person finds is
 * still only what the wall shows them: their party's records of the kinds their portal has, in the session's company,
 * read through the partner role's row-level security, and an invoice only with the price grain (Finance, Buyer, Admin).
 */
export const PORTAL_SEARCH_DEFINITIONS = definePartnerPermissions('portal', {
  search: {
    risk: 'read',
    description: 'Search your orders, documents and jobs by your own references and ours (only what your role shows).',
  },
})

export const PORTAL_SEARCH = 'portal.search' satisfies Permission

export const PORTAL_SEARCH_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SEARCH])
