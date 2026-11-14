import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Tax rules as data (B-W2b-392; FIN-100, FIN-101, FIN-107; apps/factory-api modules/invoicing/{tax-codes,intent,stamp-duty}).
 * Checked with can() against the company (a declaration of intent also against its customer). Reading needs
 * invoices.view (the tax codes, declarations, stamp duty quarters and the company's switches); naming a declaration on a
 * draft invoice is invoices.manage. Amounts (a declaration's, a quarter's total) travel only with the money.price grain.
 * Declared in `auth/permissions/catalogue.ts`.
 *
 *   tax.manage  keep the company's tax codes (new code or version, the change of one not yet in force, its end, archive,
 *               delete before its first day), the customers' declarations of intent (record, check on the tax agency's
 *               site with its receipt, revoke) and the stamp duty quarters (recount, record the payment)
 *   tax.switch  switch a company's tax duties on or off and record the accountant's confirmation of a tax code. Step-up:
 *               GATE-ACCOUNTANT, each stays off until the accountant confirms (lead decision 11-13)
 */
export const TAX_RULES_DEFINITIONS = definePermissions('invoices', {
  'tax.manage': {
    risk: 'write',
    description:
      "Keep the company's tax codes (rates, Natura codes with their law, account keys, the days they apply), the customers' declarations of intent (record, check on the tax agency's site with its receipt, revoke) and the stamp duty of each quarter (recount, record the payment).",
  },
  'tax.switch': {
    risk: 'stepUp',
    description:
      "Switch a company's tax duties on or off (its tax codes on invoices, stamp duty charged to the customer, declarations of intent on invoices) and record the accountant's confirmation of a tax code: each stays off until the accountant confirms.",
  },
})

export const INVOICES_TAX_MANAGE = 'invoices.tax.manage' satisfies Permission
export const INVOICES_TAX_SWITCH = 'invoices.tax.switch' satisfies Permission

export const TAX_RULES_PERMISSIONS: readonly Permission[] = Object.freeze([INVOICES_TAX_MANAGE, INVOICES_TAX_SWITCH])

/** Who holds them (auth/roles/templates; the owner from every(), the read-only role none: writes): finance. */
export const TAX_RULES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [INVOICES_TAX_MANAGE, INVOICES_TAX_SWITCH],
})
