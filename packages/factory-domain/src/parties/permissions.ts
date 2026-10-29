import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The parties module's permissions (apps/factory-api modules/parties; features SAL-001, SAL-003..006, SCM-001), in the
 * parties area: ONE record for customers and suppliers, so one set of permissions for both (Sales and Purchasing show
 * the same record from two sides). Each is checked with can() against the party's company AND the party itself, so a
 * role limited to some customers sees and changes only those; a tenant-wide party (no company) is changed only by a
 * grant that reaches every company.
 *
 *   view    the list and the record: identity, tax data, addresses, contacts, VIES checks (contacts are personal data)
 *   manage  create, edit, archive and reactivate; addresses, contacts and tax identities; import from a sheet
 *   block   block a party (no new quotes, orders or purchase orders: the later modules check the status) and unblock
 *           it: a credit or supplier decision of its own, apart from editing
 *   vies    check a VAT number with VIES (an outside call through the gateway, kept as the art. 41 DL 331/1993 proof)
 */
export const PARTIES_DEFINITIONS = definePermissions('parties', {
  view: { risk: 'read', description: 'See customers and suppliers: identity, tax data, addresses, contacts and VIES checks.' },
  manage: { risk: 'write', description: 'Add customers and suppliers, edit them, archive and reactivate them; keep their addresses, contacts and tax identities; import them from a sheet.' },
  block: { risk: 'write', description: 'Block a customer or supplier (no new quotes, orders or purchase orders) and unblock it.' },
  vies: { risk: 'write', description: "Check a customer's or supplier's EU VAT number with VIES; the answer is kept as the proof for zero-rated sales." },
})

export const PARTIES_VIEW = 'parties.view' satisfies Permission
export const PARTIES_MANAGE = 'parties.manage' satisfies Permission
export const PARTIES_BLOCK = 'parties.block' satisfies Permission
export const PARTIES_VIES = 'parties.vies' satisfies Permission
export const PARTIES_PERMISSIONS: readonly Permission[] = Object.freeze([PARTIES_VIEW, PARTIES_MANAGE, PARTIES_BLOCK, PARTIES_VIES])
