import type { Permission } from '../core/permissions'
import { definePartnerPermissions, PARTNERS_VIEW, PORTAL_COMMENT } from '../auth/partners/permissions'
import { definePermissions } from '../auth/permissions/registry'
import { PORTAL_APPROVALS_VIEW } from '../approvals-out/permissions'
import { PORTAL_HOME_VIEW } from '../portal/tasks/permissions'
import { WORKORDERS_HOLD } from '../production/work-orders/permissions'
import { PORTAL_CUSTOMER_DOCUMENTS_VIEW } from '../sales/portal-documents/permissions'
import { PORTAL_SALES_ORDERS_VIEW } from '../sales/portal-orders/permissions'
import { PORTAL_SAMPLES_VIEW } from '../sales/portal-samples/permissions'

/**
 * B-PR-13 (production plan §3 "Who may do what", §5 Roles; lead picks L10, L18, L21; review fixes R-05, R-45, R-52): the
 * permissions of a customer's own production. Checked with can() against the order's company AND its customer (the office's
 * customer limit walls production too, plan §2).
 *
 * The OFFICE's:
 *   partners.production.manage   the limits card of a customer (its own route PUT /partners/:partyId/production, B-PR-14):
 *                                what it sees, its urgency switch and urgent quota, the production asks it may make, its
 *                                named approver, whether overrides need a second person (step-up)
 *   production.brand.manage      answer its production asks (Urgent – asked, pause, resume), raise an order's health to At
 *                                risk with a reason, set the production supervisor of the customer and of its orders
 *   production.brand.override    decide for the customer or undo its act, with a reason it reads (a second person when its
 *                                switch is on); set its order back to Regular, lock or unlock it (step-up, never the person
 *                                who asked; no second person for the urgency: it is our own plan)
 * workorders.hold (place and lift a production hold, B-PR-21) is declared with the work orders (production/work-orders).
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles):
 *   production.view      its orders in production: stage, expected date, health, who acts next; progress, gates and dates
 *                        and quality only as far as its level shares (./levels)
 *   production.urgency   mark its orders Urgent or Regular inside its urgent quota and before cutting, and order its urgent
 *                        list (beyond that it becomes an ask the factory answers: B-PR-41); replaces the old "rank"
 * Answering a change, cancel or ship-what-is-ready ask stays orders.manage (Sales), another sample round
 * sales.samples.manage; a note to the supervisor threads.post — no new permission for them.
 */
export const PRODUCTION_BRAND_DEFINITIONS = [
  ...definePermissions('partners', {
    'production.manage': {
      risk: 'stepUp',
      description:
        "Set what a customer sees of its production and what it may do there: the share level, its urgency switch and urgent quota, the production asks it may make, its named approver, and whether overriding it needs a second person.",
    },
  }),
  ...definePermissions('production', {
    'brand.manage': {
      risk: 'write',
      description:
        "Answer a customer's production asks (Urgent – asked, pause, resume), raise one of its orders to At risk with a reason it reads, and set the production supervisor of the customer and of its orders.",
    },
    'brand.override': {
      risk: 'stepUp',
      description:
        "Decide for a customer or undo what it did, with a reason it reads (a second person grants it when the customer's switch is on; never the person who asked); set a customer's order back to Regular, lock or unlock it.",
    },
  }),
]

export const PORTAL_PRODUCTION_DEFINITIONS = definePartnerPermissions('portal', {
  'production.view': {
    risk: 'read',
    description:
      "See your organisation's orders in production: the stage of each, the expected date, its health and who acts next; the pieces, the gates and dates and the quality as far as the factory shares them.",
  },
  'production.urgency': {
    risk: 'write',
    description:
      "Mark your organisation's orders in production urgent or regular within the urgent quota the factory set and before cutting, and put the urgent ones in order; beyond that, an urgent mark is an ask the factory answers.",
  },
})

export const PARTNERS_PRODUCTION_MANAGE = 'partners.production.manage' satisfies Permission
export const PRODUCTION_BRAND_MANAGE = 'production.brand.manage' satisfies Permission
export const PRODUCTION_BRAND_OVERRIDE = 'production.brand.override' satisfies Permission
export const PRODUCTION_BRAND_PERMISSIONS: readonly Permission[] = Object.freeze([PARTNERS_PRODUCTION_MANAGE, PRODUCTION_BRAND_MANAGE, PRODUCTION_BRAND_OVERRIDE])

export const PORTAL_PRODUCTION_VIEW = 'portal.production.view' satisfies Permission
export const PORTAL_PRODUCTION_URGENCY = 'portal.production.urgency' satisfies Permission
export const PORTAL_PRODUCTION_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_PRODUCTION_VIEW, PORTAL_PRODUCTION_URGENCY])

/**
 * The office templates (auth/roles/templates; the owner from every(), read_only reads from the registry): the limits card
 * to Owner, Admin, Production manager and Sales (plan §7.2: Sales keeps a say); answering and the supervisor to Owner, Admin,
 * Production manager and Planner; overrides to Owner, Admin and Production manager; the production hold to the Production
 * manager and the Planner; the Production manager also opens the card (partners.view).
 */
export const PRODUCTION_BRAND_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PARTNERS_PRODUCTION_MANAGE, PRODUCTION_BRAND_MANAGE, PRODUCTION_BRAND_OVERRIDE],
  production_manager: [PARTNERS_PRODUCTION_MANAGE, PRODUCTION_BRAND_MANAGE, PRODUCTION_BRAND_OVERRIDE, PARTNERS_VIEW, WORKORDERS_HOLD],
  sales: [PARTNERS_PRODUCTION_MANAGE],
  planner: [PRODUCTION_BRAND_MANAGE, WORKORDERS_HOLD],
})

/** The customer's new main role (auth/roles/partner-templates MAIN_ROLES.CUSTOMER.production). */
export const CUSTOMER_PRODUCTION_ROLE = 'customer-production'

/**
 * The partner templates (auth/roles/templates PARTNER_ADDS, one line): the Production role sees its organisation's orders and
 * their production, marks them urgent, reads what we ask it to approve (answering takes portal.approve, a default capability)
 * and its samples, opens the order's shared files (portal.customerDocuments.view — never conformity or finance; order
 * confirmations and quotes need the price grain, which this role never has: sales/portal-documents/library GROUP_RULES) and
 * writes in its orders' threads (portal.comment: "Report a problem"). It asks for changes from B-PR-25 on (which hides a
 * cancel fee from roles without prices first). The Buyer also marks orders urgent; Quality and Viewer read production. The
 * customer Admin follows by itself; Designer and Finance do not see production.
 */
export const PRODUCTION_PARTNER_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  [CUSTOMER_PRODUCTION_ROLE]: [
    PORTAL_HOME_VIEW,
    PORTAL_SALES_ORDERS_VIEW,
    PORTAL_APPROVALS_VIEW,
    PORTAL_SAMPLES_VIEW,
    PORTAL_CUSTOMER_DOCUMENTS_VIEW,
    PORTAL_COMMENT,
    PORTAL_PRODUCTION_VIEW,
    PORTAL_PRODUCTION_URGENCY,
  ],
  'customer-buyer': [PORTAL_PRODUCTION_VIEW, PORTAL_PRODUCTION_URGENCY],
  'customer-quality': [PORTAL_PRODUCTION_VIEW],
  'customer-viewer': [PORTAL_PRODUCTION_VIEW],
})
