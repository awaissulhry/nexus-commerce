import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Supplier documents and profile in the portal (B-W2b-189; SCM-096 "Document upload", SCM-097 "Profile self-service"; design
 * portal.supplier.documents, portal.supplier.profile; QHS-112 and PRD-305 point here).
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles):
 *
 *   supplierDocuments.view    see what we ask for (the documents our rules need from you and the requests we made, with why
 *                             and by when) and your documents with their check and expiry; sending one also needs the
 *                             person's capability `portal.upload` (B-W2b-162: a portal write checks its page's permission AND
 *                             the capability its verb takes). Every supplier and workshop main role; each Admin follows.
 *   supplierProfile.view      see your company as we hold it (legal name and VAT read-only, addresses, contacts) and the
 *                             changes you sent that wait for our check. Every supplier and workshop main role.
 *   supplierProfile.change    send changes of your addresses and contacts for our check; they apply only on the buyer's yes.
 *                             The supplier's and the workshop's Admin.
 *
 * The OFFICE's (area `purchasing`):
 *
 *   supplierDocuments.review  accept a document a supplier sent (what it is, until when; it is then shared back with the
 *                             supplier as seen and counts for the required-document rules) or refuse it with the reason.
 *                             Administrator, buyer, quality inspector.
 *   supplierChanges.decide    approve a supplier's change of its addresses and contacts (it applies then) or refuse it with
 *                             the reason (Home › Approvals). Administrator, buyer.
 *
 * Bank details are not here: they change with their own control and a call-back (SCM-007, W2b-5).
 */
export const PORTAL_SUPPLIER_PROFILE_DEFINITIONS = definePartnerPermissions('portal', {
  'supplierDocuments.view': {
    risk: 'read',
    description: 'See the documents we ask your organisation for, with why and by when, and your documents with our check and their expiry; send one when you may upload.',
  },
  'supplierProfile.view': {
    risk: 'read',
    description: "See your organisation's company data, addresses and contacts as we hold them, and the changes waiting for our check.",
  },
  'supplierProfile.change': {
    risk: 'write',
    description: "Send changes of your organisation's addresses and contacts for our check; they apply once the buyer approves them.",
  },
})

export const SUPPLIER_REVIEW_DEFINITIONS = definePermissions('purchasing', {
  'supplierDocuments.review': {
    risk: 'write',
    description: 'Accept a document a supplier sent in the portal (what it is and until when; it is then shared back and counts for the required documents), or refuse it with the reason.',
  },
  'supplierChanges.decide': {
    risk: 'write',
    description: "Approve a supplier's change of its addresses and contacts sent in the portal (it applies then), or refuse it with the reason.",
  },
})

export const PORTAL_SUPPLIER_DOCUMENTS_VIEW = 'portal.supplierDocuments.view' satisfies Permission
export const PORTAL_SUPPLIER_PROFILE_VIEW = 'portal.supplierProfile.view' satisfies Permission
export const PORTAL_SUPPLIER_PROFILE_CHANGE = 'portal.supplierProfile.change' satisfies Permission
export const SUPPLIER_DOCUMENTS_REVIEW = 'purchasing.supplierDocuments.review' satisfies Permission
export const SUPPLIER_CHANGES_DECIDE = 'purchasing.supplierChanges.decide' satisfies Permission

export const PORTAL_SUPPLIER_PROFILE_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SUPPLIER_DOCUMENTS_VIEW, PORTAL_SUPPLIER_PROFILE_VIEW, PORTAL_SUPPLIER_PROFILE_CHANGE])
export const SUPPLIER_REVIEW_PERMISSIONS: readonly Permission[] = Object.freeze([SUPPLIER_DOCUMENTS_REVIEW, SUPPLIER_CHANGES_DECIDE])
