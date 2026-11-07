import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334 return request from the portal, SAL-424 complaint status in the
 * portal; design portal.customer.returns "Returns & claims", links.claim "Report a problem").
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   returns.view       see the organisation's returns and complaints with the factory: each case with its status in customer
 *                      words and the next step for them, what was asked (lines, reasons, photos), where it is (asked,
 *                      decided, back with us, inspected, outcome), the return instructions to print, and the credit note
 *                      once issued (only for roles that show prices)
 *   returns.request    ask for a return of what was delivered, or report a quality problem (a complaint), add photos while
 *                      it is not decided yet (the photo also takes the person's upload right, B-W2b-162), and cancel a return
 *                      request before the goods leave
 *   complaints.view    follow the quality complaints: the investigation's steps, the answer letter and the 8D report once
 *                      the factory shares it
 *
 * Given in ../../auth/roles/templates PARTNER_ADDS (PORTAL_RETURNS_ADDS): the page to the customer Buyer, Finance, Quality and
 * Viewer; asking to the Buyer and Quality; the complaints' investigation to Quality. The customer Admin follows by itself. Not
 * the Designer, never a supplier, subcontractor or guest role. The office decides a request with the returns' and the
 * complaints' own permissions (sales.returns.manage, quality.complaints.manage): no office permission is added.
 */
export const PORTAL_RETURNS_DEFINITIONS = definePartnerPermissions('portal', {
  'returns.view': {
    risk: 'read',
    description:
      "See your organisation's returns and complaints: each case with its next step, what was asked, where it is, the return instructions and, for roles that show prices, the credit note.",
  },
  'returns.request': {
    risk: 'write',
    description: 'Ask for a return of what you received or report a quality problem, add photos while it is not decided, and cancel a return request before the goods leave.',
  },
  'complaints.view': {
    risk: 'read',
    description: "Follow your quality complaints: the investigation's steps, the factory's answer letter and the 8D report once it is shared with you.",
  },
})

export const PORTAL_RETURNS_VIEW = 'portal.returns.view' satisfies Permission
export const PORTAL_RETURNS_REQUEST = 'portal.returns.request' satisfies Permission
export const PORTAL_COMPLAINTS_VIEW = 'portal.complaints.view' satisfies Permission
export const PORTAL_RETURNS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_RETURNS_VIEW, PORTAL_RETURNS_REQUEST, PORTAL_COMPLAINTS_VIEW])

/** The partner templates (keys) and what this step gives each; every customer Admin follows its kind's roles by itself. */
export const PORTAL_RETURNS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  'customer-buyer': [PORTAL_RETURNS_VIEW, PORTAL_RETURNS_REQUEST],
  'customer-quality': [PORTAL_RETURNS_VIEW, PORTAL_RETURNS_REQUEST, PORTAL_COMPLAINTS_VIEW],
  'customer-finance': [PORTAL_RETURNS_VIEW],
  'customer-viewer': [PORTAL_RETURNS_VIEW],
})
