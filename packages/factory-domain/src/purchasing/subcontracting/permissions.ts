import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Subcontracting (B-W2a-25; SCM-138, SCM-140, SCM-141, SCM-142; apps/factory-api modules/purchasing/subcontracting;
 * design purchasing.subcontracting, floor.kits). Seeing subcontract orders and the stock at each workshop is
 * purchasing.view (fees and values only with the cost grain, money.cost). Each act is checked with can() against the
 * order's company, site AND workshop (the party), so a role limited to some workshops reaches only theirs. The floor
 * holds kit and receive at its own device's site (B-W2a-76, the warehouse tablet's Subcontract kits task).
 *
 *   subcontract.manage   prepare an order from a work order's outside operations (pieces per size, fee, return date),
 *                        its kit plan, issue it to the workshop, take an issued one back to draft, cancel it while nothing
 *                        is out, close it once everything is back (the buyer)
 *   subcontract.kit      send the kit: our material moves into the workshop's stock location (it stays ours) and the
 *                        pieces go out, with the DDT for work on our behalf (conto lavorazione: that DDT also needs
 *                        shipping.ddt.issue); take back a kit line that never left (the warehouse)
 *   subcontract.receive  receive the goods back, operation by operation and bundle by bundle (back good, defective,
 *                        scrapped at the workshop), and the unused material returned (the warehouse)
 */
export const PURCHASING_SUBCONTRACT_DEFINITIONS = definePermissions('purchasing', {
  'subcontract.manage': {
    risk: 'write',
    description: "Prepare subcontract orders from a work order's outside operations (pieces per size, fee per piece, return date) and their kit, issue them to the workshop, take an issued one back to draft, cancel one while nothing is out, close one once everything is back.",
  },
  'subcontract.kit': {
    risk: 'write',
    description: "Send a subcontract order's kit: our material moves into the workshop's stock location (it stays ours) and the pieces go out, with the DDT for work on our behalf; take back a kit line that never left.",
  },
  'subcontract.receive': {
    risk: 'write',
    description: 'Receive the goods back from a workshop, operation by operation and bundle by bundle (good, defective, scrapped there), and the unused material it returns.',
  },
})

export const PURCHASING_SUBCONTRACT_MANAGE = 'purchasing.subcontract.manage' satisfies Permission
export const PURCHASING_SUBCONTRACT_KIT = 'purchasing.subcontract.kit' satisfies Permission
export const PURCHASING_SUBCONTRACT_RECEIVE = 'purchasing.subcontract.receive' satisfies Permission

export const PURCHASING_SUBCONTRACT_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_SUBCONTRACT_MANAGE, PURCHASING_SUBCONTRACT_KIT, PURCHASING_SUBCONTRACT_RECEIVE])

/** B-W2a-76: what a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the kit out and the goods back, at its own site. */
export const PURCHASING_SUBCONTRACT_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_SUBCONTRACT_KIT, PURCHASING_SUBCONTRACT_RECEIVE])
