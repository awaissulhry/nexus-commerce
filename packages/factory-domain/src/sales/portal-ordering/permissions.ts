import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Portal ordering (B-W2b-190; SAL-071 customer catalogue, SAL-072 reorder, SAL-073 order upload, SAL-074 portal orders
 * arrive as requests, SAL-079 ship-to addresses self-service; design portal.customer.catalogue, portal.customer.neworder,
 * portal.customer.account › Delivery addresses).
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   catalogue.view        the styles this customer may buy (its own private label and the open range its price lists
 *                         price), their colourways, sizes offered and certificate class; its price only with the price
 *                         grain of the role (customer Buyer, Finance, Admin)
 *   orderRequests.manage  keep an order request: start a draft (styles picked, a past order copied at today's prices, a
 *                         sheet uploaded after its dry run), change it, discard it, send it as a request and withdraw it
 *                         before the factory decided
 *   addresses.view        see the organisation's delivery addresses (the ones an order request may ask for)
 *   addresses.manage      the customer admin adds, archives and chooses the default delivery address (the factory sees
 *                         who did in the customer's record)
 *
 * Given in ../../auth/roles/templates PARTNER_ADDS: the catalogue and the addresses to every customer role, order requests
 * to the customer Buyer, the address changes to the customer Admin only (the Admin follows the others by itself). The
 * office decides a sent request with the sales orders' own permissions (orders.view, orders.manage; quotes.manage for a
 * quote): no office permission is added.
 */
export const PORTAL_ORDERING_DEFINITIONS = definePartnerPermissions('portal', {
  'catalogue.view': {
    risk: 'read',
    description: 'See the styles you can buy from the factory: colours, sizes, certificate class and, for roles that show prices, your price.',
  },
  'orderRequests.manage': {
    risk: 'write',
    description: 'Make order requests: pick styles, reorder a past order at today\'s prices or upload a sheet, then send the request (the factory confirms it as an order).',
  },
  'addresses.view': { risk: 'read', description: "See your organisation's delivery addresses." },
  'addresses.manage': { risk: 'write', description: "Add or archive your organisation's delivery addresses and choose the default one (the factory sees who did)." },
})

export const PORTAL_CATALOGUE_VIEW = 'portal.catalogue.view' satisfies Permission
export const PORTAL_ORDER_REQUESTS_MANAGE = 'portal.orderRequests.manage' satisfies Permission
export const PORTAL_ADDRESSES_VIEW = 'portal.addresses.view' satisfies Permission
export const PORTAL_ADDRESSES_MANAGE = 'portal.addresses.manage' satisfies Permission
export const PORTAL_ORDERING_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_CATALOGUE_VIEW, PORTAL_ORDER_REQUESTS_MANAGE, PORTAL_ADDRESSES_VIEW, PORTAL_ADDRESSES_MANAGE])

const CUSTOMER_MAIN_ROLES = ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer'] as const

/** The partner templates (keys) and what this step gives each; every customer Admin follows its kind's roles and adds its own. */
export const PORTAL_ORDERING_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  ...Object.fromEntries(CUSTOMER_MAIN_ROLES.map((key) => [key, key === 'customer-buyer' ? [PORTAL_CATALOGUE_VIEW, PORTAL_ADDRESSES_VIEW, PORTAL_ORDER_REQUESTS_MANAGE] : [PORTAL_CATALOGUE_VIEW, PORTAL_ADDRESSES_VIEW]])),
  'customer-admin': [PORTAL_ADDRESSES_MANAGE],
})
