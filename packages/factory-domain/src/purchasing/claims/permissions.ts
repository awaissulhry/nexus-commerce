import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Supplier claims and returns to the supplier (B-W2a-44; SCM-134; apps/factory-api modules/purchasing/claims; design
 * purchasing.claims SCR-131). Seeing claims is purchasing.view (the value of the goods and the credit asked only with the
 * cost grain, money.cost). Each act is checked with can() against the claim's company, site AND supplier (the party), so
 * a role limited to some suppliers reaches only theirs. Office only.
 *
 *   claims.manage   prepare a claim (from a receipt's discrepancies, from a lot, or typed), its lines, send it to the
 *                   supplier (by e-mail on the claim's thread), record the supplier's answer, close or cancel it (the
 *                   buyer and the warehouse)
 *   claims.return   send the goods of a return claim back: the stock leaves the site and the return DDT travels with it
 *                   (that DDT also needs shipping.ddt.issue). "Return to supplier" in one go needs both (the warehouse)
 */
export const PURCHASING_CLAIMS_DEFINITIONS = definePermissions('purchasing', {
  'claims.manage': {
    risk: 'write',
    description: "Prepare supplier claims (from a receipt's discrepancies, a lot or typed lines), send them to the supplier by e-mail, record the supplier's answer, close or cancel them.",
  },
  'claims.return': {
    risk: 'write',
    description: 'Send the goods of a return claim back to the supplier: the stock leaves the site with the return DDT.',
  },
})

export const PURCHASING_CLAIMS_MANAGE = 'purchasing.claims.manage' satisfies Permission
export const PURCHASING_CLAIMS_RETURN = 'purchasing.claims.return' satisfies Permission

export const PURCHASING_CLAIMS_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_CLAIMS_MANAGE, PURCHASING_CLAIMS_RETURN])
