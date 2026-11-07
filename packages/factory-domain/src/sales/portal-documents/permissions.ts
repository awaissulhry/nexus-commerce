import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Customer documents in the portal (B-W2b-178; SAL-086 document library per account, SAL-087 declaration of conformity per
 * shipped style, SAL-092 fixed document versions, QHS-111 customer document download; design portal.customer.documents,
 * the order record's Documents tab, Home's "New documents").
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role). Which
 * documents a person sees goes by role (the plan: "Quality: certificates; Finance: invoices"):
 *   customerDocuments.view         the library: delivery papers (DDT, packing list, proof of delivery, CMR), order
 *                                  confirmations and quotes (they carry prices: only with the price grain), and the other
 *                                  files the factory shared with the organisation; previews and downloads, each recorded
 *   customerDocuments.conformity   the conformity documents: EU declarations of conformity, user information, certificates
 *                                  of conformity, inspection and test reports, certificates; for each style received, the
 *                                  declaration and the certificate valid on the shipping date
 *   customerDocuments.finance      invoices and credit notes (the PDF courtesy copy and the XML e-invoice) and statements of
 *                                  account; only with the price grain
 *
 * Given in ../../auth/roles/templates PARTNER_ADDS: view to the customer Buyer, Finance, Quality and Viewer; conformity to
 * the customer Quality, Buyer and Viewer (the declaration travels to the buyer's address too, B-W1-49); finance to the
 * customer Finance. The customer Admin follows by itself. Not the Designer, never a supplier, workshop or guest role.
 */
export const PORTAL_CUSTOMER_DOCUMENTS_DEFINITIONS = definePartnerPermissions('portal', {
  'customerDocuments.view': {
    risk: 'read',
    description:
      "See your organisation's documents: delivery papers, order confirmations and quotes (with prices only for roles that show prices) and the other files shared with you, each in its fixed version; preview and download them (every download is recorded).",
  },
  'customerDocuments.conformity': {
    risk: 'read',
    description:
      'See the conformity documents: declarations of conformity, user information, certificates of conformity, inspection and test reports; for each style you received, the declaration and the certificate valid on the shipping date.',
  },
  'customerDocuments.finance': {
    risk: 'read',
    description: 'See the invoices and credit notes (the PDF copy and the XML e-invoice) and the statements of account sent to you; only for roles that show prices.',
  },
})

export const PORTAL_CUSTOMER_DOCUMENTS_VIEW = 'portal.customerDocuments.view' satisfies Permission
export const PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY = 'portal.customerDocuments.conformity' satisfies Permission
export const PORTAL_CUSTOMER_DOCUMENTS_FINANCE = 'portal.customerDocuments.finance' satisfies Permission
export const PORTAL_CUSTOMER_DOCUMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_CUSTOMER_DOCUMENTS_VIEW, PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, PORTAL_CUSTOMER_DOCUMENTS_FINANCE])

/** Which customer roles get which (template keys; the customer Admin follows). */
export const CUSTOMER_DOCUMENT_READERS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  'customer-buyer': [PORTAL_CUSTOMER_DOCUMENTS_VIEW, PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY],
  'customer-finance': [PORTAL_CUSTOMER_DOCUMENTS_VIEW, PORTAL_CUSTOMER_DOCUMENTS_FINANCE],
  'customer-quality': [PORTAL_CUSTOMER_DOCUMENTS_VIEW, PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY],
  'customer-viewer': [PORTAL_CUSTOMER_DOCUMENTS_VIEW, PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY],
})
