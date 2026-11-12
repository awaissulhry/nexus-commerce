import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Subcontracting in depth (B-W2b-331; SCM-049, SCM-143, SCM-144, SCM-145, SCM-146, SCM-150; apps/factory-api
 * modules/purchasing/subcontract-depth; design purchasing.subcontracting "Material balance", "Cost", the written terms
 * link, days out). Reading the written terms, the material balance, the bundles out and back, the cost on the work order
 * and the days out at each workshop is purchasing.view (prices, amounts and values only with the cost grain, money.cost).
 * Each act is checked with can() against the order's company, site AND workshop, an agreement's against its company and
 * workshop. Office only.
 *
 *   subcontract.terms    write the written terms with a workshop (L. 192/1998 art. 2) as a numbered revision, sign it with
 *                        its signed file (the revision in force is superseded in the same act), end it with why, delete a
 *                        draft (the buyer)
 *   subcontract.balance  book what the workshop declares of the material we sent (used in the goods back, returned unused,
 *                        scrapped there) and adjust it after the receipt with a reason: the used material is issued to the
 *                        work order and the scrap written off at the workshop's place (the buyer, the warehouse)
 *   subcontract.cost     book the workshop's charges on the order (the fee at its price, transport, material it supplied,
 *                        anything else in words) onto the work order's cost, and take one back with a reason (the buyer;
 *                        the prices need the cost grain too)
 */
export const SUBCONTRACT_DEPTH_DEFINITIONS = definePermissions('purchasing', {
  'subcontract.terms': {
    risk: 'write',
    description:
      'Write the written subcontract terms with a workshop (L. 192/1998 art. 2) as a numbered revision, sign one with its signed file (the revision in force is superseded in the same act), end one with why, delete a draft.',
  },
  'subcontract.balance': {
    risk: 'write',
    description:
      "Book what a workshop declares of the material we sent it (used in the goods back, returned unused, scrapped there) and adjust it after the receipt with a reason: the used material is issued to the work order and the scrap written off at the workshop's place.",
  },
  'subcontract.cost': {
    risk: 'write',
    description: "Book a workshop's charges on its subcontract order (the fee at its price, transport, material it supplied, anything else in words) onto the work order's cost, and take one back with a reason.",
  },
})

export const PURCHASING_SUBCONTRACT_TERMS = 'purchasing.subcontract.terms' satisfies Permission
export const PURCHASING_SUBCONTRACT_BALANCE = 'purchasing.subcontract.balance' satisfies Permission
export const PURCHASING_SUBCONTRACT_COST = 'purchasing.subcontract.cost' satisfies Permission

export const SUBCONTRACT_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_SUBCONTRACT_TERMS, PURCHASING_SUBCONTRACT_BALANCE, PURCHASING_SUBCONTRACT_COST])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the buyer keeps the workshops' terms, their material
 * balance and their charges; the warehouse, which takes the goods back, books the workshop's declaration of the material
 * that came with them.
 */
export const SUBCONTRACT_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [PURCHASING_SUBCONTRACT_TERMS, PURCHASING_SUBCONTRACT_BALANCE, PURCHASING_SUBCONTRACT_COST],
  warehouse: [PURCHASING_SUBCONTRACT_BALANCE],
})
