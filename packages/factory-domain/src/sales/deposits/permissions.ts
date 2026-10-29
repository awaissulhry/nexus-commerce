import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The company's bank account (B-W1-24; Q12: deposits are paid by bank transfer; apps/factory-api modules/sales/deposits
 * `/companies/:companyId/bank-details`), in the companies area, checked with can() on the company.
 *
 *   bank.view     see the account a company's customers pay to (deposit pages and documents show it anyway)
 *   bank.manage   set, change or remove it: a step-up each time (A1 §3.10: bank details), audited from → to, and the
 *                 owners and administrators are told (a changed IBAN is a classic fraud vector)
 */
export const COMPANY_BANK_DEFINITIONS = definePermissions('companies', {
  'bank.view': { risk: 'read', description: "See a company's bank account: the holder, the IBAN, the BIC and the bank deposits are paid to." },
  'bank.manage': { risk: 'stepUp', description: "Set, change or remove a company's bank account (a step-up each time; the owners and administrators are told)." },
})

export const COMPANY_BANK_VIEW = 'companies.bank.view' satisfies Permission
export const COMPANY_BANK_MANAGE = 'companies.bank.manage' satisfies Permission
export const COMPANY_BANK_PERMISSIONS: readonly Permission[] = Object.freeze([COMPANY_BANK_VIEW, COMPANY_BANK_MANAGE])
