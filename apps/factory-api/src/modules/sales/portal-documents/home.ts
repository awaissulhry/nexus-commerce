import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_CUSTOMER_DOCUMENTS_VIEW } from '@nexus/factory-domain/sales/portal-documents/permissions'
import type { HomeSource } from '../../../platform/portal/home/sources'
import { portalReader } from '../portal-orders/access'
import { readLibrary, visibleEntries } from './library'

/**
 * B-W2b-178: a customer's Home count of its documents (design portal.customer.home "New documents": documents issued since
 * the last visit, NEW until opened; the list itself is GET /portal/customer-documents?new=true&limit=5). Only the kinds the
 * person sees; null for a person whose role does not see the library (fails closed: the tile shows nothing).
 */
export const CUSTOMER_DOCUMENT_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'customerDocuments',
  counts: [{ key: 'documents.new', area: 'documents', kinds: ['CUSTOMER'], words: { it: 'Nuovi documenti', en: 'New documents' } }],
  async read(app, request, now) {
    const reader = portalReader(app, request)
    if (!can(reader.actor, PORTAL_CUSTOMER_DOCUMENTS_VIEW, { companyId: reader.session.company.id, partyId: reader.session.partyId })) return { 'documents.new': null }
    const library = await readLibrary(app, request, now)
    return { 'documents.new': visibleEntries(library).filter((entry) => entry.isNew).length }
  },
})
