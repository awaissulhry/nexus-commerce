import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_SUPPLIER_DOCUMENTS_VIEW } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf } from '../../../platform/auth/portal/authenticator'
import type { HomeSource } from '../../../platform/portal/home/sources'
import { supplierDocumentCounts } from './documents'

/**
 * B-W2b-189 (SCM-096; design portal.supplier.home "five counts", portal.supplier.documents "We ask for", "expires in 22
 * days"): what we ask the supplier for (the rules' missing or expired documents and the open requests, less those it sent
 * and that wait for our check), and its accepted documents expiring within 30 days or expired. Null when the person does not
 * see the documents page (fails closed: never 0).
 */
export const SUPPLIER_DOCUMENT_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'supplier-documents',
  counts: [
    { key: 'supplier_documents.requested', area: 'documents', kinds: ['SUPPLIER', 'SUBCONTRACTOR'], words: { it: 'Documenti richiesti', en: 'Documents we ask for' } },
    { key: 'supplier_documents.expiring', area: 'documents', kinds: ['SUPPLIER', 'SUBCONTRACTOR'], words: { it: 'Documenti in scadenza', en: 'Documents expiring' } },
  ],
  async read(_app, request, now) {
    const session = portalSessionOf(request)
    if (!can(actorOf(requireContext(request)), PORTAL_SUPPLIER_DOCUMENTS_VIEW, { companyId: session.company.id, partyId: session.partyId })) {
      return { 'supplier_documents.requested': null, 'supplier_documents.expiring': null }
    }
    const counts = await supplierDocumentCounts(request, now)
    return { 'supplier_documents.requested': counts.requested, 'supplier_documents.expiring': counts.expiring }
  },
})
