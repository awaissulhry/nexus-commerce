import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * A supplier's documents and profile in the portal (B-W2b-189; SCM-096, SCM-097). apps/factory-api's
 * modules/purchasing/portal-profile emits them in the commands that make the change (the supplier's upload and change
 * request in the portal, the office's check). Their own module folder: the code is factory-domain purchasing/portal-profile.
 *
 *   supplier_document.uploaded         a supplier sent a document in the portal: it waits for our check, unshared
 *   supplier_document.accepted         a buyer or quality person accepted it (what it is, until when): shared back as seen,
 *                                      it counts for the required documents (`documentFileId`: the file now in force, the
 *                                      upload itself or the next version of the document it replaces)
 *   supplier_document.refused          they refused it with the reason; the supplier is asked to upload it again
 *   supplier_profile.change_requested  a supplier sent changes of its addresses and contacts for the buyer's check
 *   supplier_profile.change_withdrawn  the supplier withdrew them before the check
 *   supplier_profile.change_decided    the buyer approved them (applied) or refused them (with the reason)
 *
 * Reach the office screens that check them (purchasing.supplierDocuments.review, purchasing.supplierChanges.decide) and the
 * supplier's own portal (factory-domain portal/notifications/live.ts names the party field): ids, kinds, counts and states
 * only, never a name, an address or the reason's words.
 */

const document = { fileId: z.uuid(), partyId: z.uuid(), recordType: z.string().max(60), recordId: z.uuid() }
const request = { requestId: z.uuid(), partyId: z.uuid() }
const CATEGORIES = ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'] as const

export const events = [
  defineEvent({
    type: 'supplier_document.uploaded',
    context: 'supplier-portal',
    description: "A supplier sent a document in the portal (a certificate, a test report, a declaration): it waits for our check, unshared.",
    payload: z.strictObject({ ...document, category: z.enum(CATEGORIES), replacesFileId: z.uuid().nullable() }),
    live: { permission: 'purchasing.supplierDocuments.review', fields: ['fileId', 'partyId', 'recordType', 'recordId', 'category'] },
  }),
  defineEvent({
    type: 'supplier_document.accepted',
    context: 'supplier-portal',
    description: "A buyer or quality person accepted a supplier's document: shared back with the supplier as seen, it counts for the required documents.",
    payload: z.strictObject({ ...document, documentFileId: z.uuid(), category: z.enum(CATEGORIES), expiresOn: z.iso.date().nullable() }),
    live: { permission: 'purchasing.supplierDocuments.review', fields: ['fileId', 'partyId', 'recordType', 'recordId', 'documentFileId', 'category'] },
  }),
  defineEvent({
    type: 'supplier_document.refused',
    context: 'supplier-portal',
    description: "A buyer or quality person refused a supplier's document with the reason; the supplier is asked to upload it again.",
    payload: z.strictObject({ ...document }),
    live: { permission: 'purchasing.supplierDocuments.review', fields: ['fileId', 'partyId', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'supplier_profile.change_requested',
    context: 'supplier-portal',
    description: 'A supplier sent changes of its addresses and contacts in the portal: they wait for the buyer, nothing changed yet.',
    payload: z.strictObject({ ...request, addresses: z.number().int().min(0).max(20), contacts: z.number().int().min(0).max(20) }),
    live: { permission: 'purchasing.supplierChanges.decide', fields: ['requestId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_profile.change_withdrawn',
    context: 'supplier-portal',
    description: 'A supplier withdrew the changes of its addresses and contacts it had sent, before the buyer checked them.',
    payload: z.strictObject({ ...request }),
    live: { permission: 'purchasing.supplierChanges.decide', fields: ['requestId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_profile.change_decided',
    context: 'supplier-portal',
    description: "The buyer approved a supplier's changes of its addresses and contacts (they apply now) or refused them with the reason.",
    payload: z.strictObject({ ...request, outcome: z.enum(['APPROVED', 'REFUSED']) }),
    live: { permission: 'purchasing.supplierChanges.decide', fields: ['requestId', 'partyId', 'outcome'] },
  }),
] as const
