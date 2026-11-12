import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Ask to buy (B-W2b-332; SCM-035, SCM-037; design purchasing.requests pop-up "Ask to buy"; apps/factory-api
 * modules/purchasing/ask-to-buy). Office only (area `purchasing`), checked with can() against the request's company and
 * site.
 *
 *   requests.ask   ask the buyers for a material: what (a material of the library, with a colour and words of one's own),
 *                  how much, by when, why and for which work order; from a work order's shortage, the shortage as it is
 *                  now. See one's own requests and take one back. A switched-on PURCHASE_REQUEST approval rule may ask a
 *                  yes first (never from the person who asked). Seeing everybody's requests is purchasing.view (the
 *                  buyer's queue, Purchasing › Requests to buy); drafting them into purchase orders, or refusing one with
 *                  the reason, is purchasing.manage; a shortage's request also needs planning.view over the site (it
 *                  reads the shortage list); "Draft a purchase order now" from a shortage is purchasing.manage.
 */
export const ASK_TO_BUY_DEFINITIONS = definePermissions('purchasing', {
  'requests.ask': {
    risk: 'write',
    description: 'Ask the buyers to buy a material (what, how much, by when, why, for which work order), also from a work order’s shortage; see your own requests and take one back.',
  },
})

export const PURCHASING_REQUESTS_ASK = 'purchasing.requests.ask' satisfies Permission

export const ASK_TO_BUY_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_REQUESTS_ASK])

/**
 * Who holds it (auth/roles/templates): every office template whose people work in the office ("Ask to buy from any office
 * user", plan B-W2b-332): the owner from every(); not read-only (it writes) and not the company doctor (an outside
 * professional who buys nothing for the factory).
 */
export const ASK_TO_BUY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PURCHASING_REQUESTS_ASK],
  finance: [PURCHASING_REQUESTS_ASK],
  sales: [PURCHASING_REQUESTS_ASK],
  planner: [PURCHASING_REQUESTS_ASK],
  buyer: [PURCHASING_REQUESTS_ASK],
  warehouse: [PURCHASING_REQUESTS_ASK],
  production_manager: [PURCHASING_REQUESTS_ASK],
  quality_inspector: [PURCHASING_REQUESTS_ASK],
  floor_supervisor: [PURCHASING_REQUESTS_ASK],
  maintenance: [PURCHASING_REQUESTS_ASK],
  hr: [PURCHASING_REQUESTS_ASK],
  safety_officer: [PURCHASING_REQUESTS_ASK],
})
