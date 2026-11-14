import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The accountant's bridge (B-W2b-408; FIN-151, FIN-152, FIN-155; GATE-ACCOUNTANT), area `accounting`, office only, checked
 * against the company. Reading the mapping, the settings and the integrity checks is accounting.view; running the
 * integrity checks now is accounting.export (who prepares the month).
 *
 *   mapping.manage   add a row of the account mapping (a key to an account from a day), change or remove one before its
 *                    first day
 *   journals.switch  switch the company's journals with mapped accounts on or off (the accountant's word: a fresh code)
 *   close            close a month for good: the HARD lock with its typed phrase and a fresh code (nothing dated in it
 *                    changes after)
 */
export const ACCOUNTING_BRIDGE_DEFINITIONS = definePermissions('accounting', {
  'mapping.manage': {
    risk: 'write',
    description: "Keep a company's account mapping: map an item group, tax code, cost category, payment method or party group to an account of the accountant's chart from a day; change or remove a row before its first day.",
  },
  'journals.switch': {
    risk: 'stepUp',
    description: "Switch a company's journals with mapped accounts (sales, purchases, payments, cost of goods sold and variances) on or off in its accounting exports, once the accountant has confirmed the mapping.",
  },
  close: {
    risk: 'stepUp',
    description: 'Close a month for good (the hard lock, with its typed phrase): nothing dated in it can change afterwards.',
  },
})

export const ACCOUNTING_MAPPING_MANAGE = 'accounting.mapping.manage' satisfies Permission
export const ACCOUNTING_JOURNALS_SWITCH = 'accounting.journals.switch' satisfies Permission
export const ACCOUNTING_CLOSE = 'accounting.close' satisfies Permission

export const ACCOUNTING_BRIDGE_PERMISSIONS: readonly Permission[] = Object.freeze([ACCOUNTING_MAPPING_MANAGE, ACCOUNTING_JOURNALS_SWITCH, ACCOUNTING_CLOSE])

/** The role templates that get them (owner: every()): finance, who prepares and closes the month with the accountant. */
export const ACCOUNTING_BRIDGE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [ACCOUNTING_MAPPING_MANAGE, ACCOUNTING_JOURNALS_SWITCH, ACCOUNTING_CLOSE],
})
