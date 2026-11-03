import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The quality documents for a customer (apps/factory-api modules/quality/inspection-docs; B-W2b-123; QHS-055 inspection
 * report PDF and share link, QHS-059 certificate of conformity per shipment; design quality.inspections "Report PDF",
 * "Share report link", "Print 6 reports" and the new tab "Inspection report (PDF)"), in the quality area. Reading them is
 * the record's own view permission (quality.inspections.view for an inspection, shipping.view for a shipment).
 *
 *   make    keep a version of a signed final inspection's report or of a packed shipment's certificate of conformity: a
 *           GeneratedDocument with its PDF; the same contents give the same version back
 *   share   put a kept version on a shipment's documents link (the shipment's existing DOCUMENT_VIEW link, never a new
 *           kind of link), so the customer finds it with the goods; and mail that link
 *
 * No price, cost, margin or pay figure is ever on these documents, nor on the link (the Owner: pay figures never go by link).
 */
export const QUALITY_DOCUMENTS_DEFINITIONS = definePermissions('quality', {
  'documents.make': {
    risk: 'write',
    description:
      "Keep a version of a signed final inspection's report or of a packed shipment's certificate of conformity as a PDF (no price, cost or pay figure on either).",
  },
  'documents.share': {
    risk: 'write',
    description:
      "Put a kept inspection report or certificate of conformity on a shipment's documents link, so the customer finds it with the goods, and mail that link.",
  },
})

export const QUALITY_DOCUMENTS_MAKE = 'quality.documents.make' satisfies Permission
export const QUALITY_DOCUMENTS_SHARE = 'quality.documents.share' satisfies Permission

export const QUALITY_DOCUMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_DOCUMENTS_MAKE, QUALITY_DOCUMENTS_SHARE])
