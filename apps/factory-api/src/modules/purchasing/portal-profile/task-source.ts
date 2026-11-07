import type { TaskSource } from '../../../platform/portal/tasks/sources'

/**
 * B-W2b-189 (SCM-096; design portal.supplier.documents "Rejected → the reason in words + Upload again"): when a buyer or
 * quality person refuses a document a supplier sent in the portal, the supplier is asked to upload it again — one
 * UPLOAD_DOCUMENT request on the record the document was for, sourceKey `SupplierDocument:<the refused file>`, due in 14
 * days, asked by the person who refused it. The supplier answers by sending a new document for it (the upload's confirm
 * closes the request, DONE by that person); it never marks it done by hand.
 *
 * This file holds the declaration only (platform/portal/tasks/sources imports it; the commands live beside it).
 */
export const SUPPLIER_DOCUMENT_SOURCE: TaskSource = Object.freeze({ name: 'purchasing.supplierDocuments', prefix: 'SupplierDocument', kinds: ['UPLOAD_DOCUMENT'] as const, partnerDone: false })

export const supplierDocumentSourceKey = (fileId: string): string => `${SUPPLIER_DOCUMENT_SOURCE.prefix}:${fileId}`

/** The refused file of a request's key, or null for another source's. */
export function refusedFileOf(sourceKey: string): string | null {
  const match = /^SupplierDocument:([0-9a-f-]{36})$/.exec(sourceKey)
  return match ? match[1]! : null
}
