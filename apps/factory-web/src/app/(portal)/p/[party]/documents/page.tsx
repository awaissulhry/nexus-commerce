'use client'

import { usePortalFrame } from '../../../../../portal/shell/frame'
import { NotInAccessHere } from '../../../../../portal/supplier/orders/parts'
import { CustomerDocumentsRoute } from '../../../../../portal/customer/documents/DocumentsPage'
import { SupplierDocumentsRoute } from '../../../../../portal/supplier/documents/DocumentsPage'

/**
 * `/p/<party code>/documents?group=&q=&by=&versions=&invoice=` — a customer's Documents (B-W2b-195, SCR-186) and a supplier's
 * Documents (B-W2b-193) share the address: one thin route file picks the page by the person's kind (plan §12, a merge
 * point). Until a kind's page is built, a typed address says it is not part of the person's access.
 */
export default function PortalDocumentsPage() {
  const { kinds } = usePortalFrame()
  // B-W2b-195: the customer's Documents.
  if (kinds.includes('CUSTOMER')) return <CustomerDocumentsRoute />
  // B-W2b-193: a supplier's or a workshop's Documents (SCR-190).
  if (kinds.includes('SUPPLIER') || kinds.includes('SUBCONTRACTOR')) return <SupplierDocumentsRoute />
  return <NotInAccessHere />
}
