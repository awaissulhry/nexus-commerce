import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Bank statements and matching (B-W2b-393; FIN-130, FIN-132, FIN-117; apps/factory-api modules/payments/{bank,matching}).
 * Checked with can() against the statement's company (a line has no party until it is matched); accepting a match is
 * also checked against its party. Amounts travel only with money.price. Office only. Declared in
 * `auth/permissions/catalogue.ts`.
 *
 *   bank.view    the company's bank accounts, its imported statements and their lines with the suggestions (how sure,
 *                why), the tiles, and the payments not placed on an invoice
 *   bank.import  import a statement file downloaded from the bank (camt.053, CSV, Excel, OFX): the dry run, then the
 *                new lines (a duplicate is never imported twice)
 *   bank.match   accept a suggestion, choose another (a person's own match), accept all the sure ones, take a wrong
 *                acceptance back; accepting money in records the payment and places it (also payments.record), taking
 *                one back voids that payment (also payments.void)
 */
export const PAYMENTS_BANK_DEFINITIONS = definePermissions('payments', {
  'bank.view': { risk: 'read', description: "See the company's bank accounts, imported statements and their lines with the suggested matches, and the payments not placed on an invoice." },
  'bank.import': { risk: 'write', description: 'Import a bank statement file downloaded from the bank (camt.053, CSV, Excel or OFX): a dry run, then the new lines; a line imported before is refused.' },
  'bank.match': { risk: 'write', description: 'Accept a suggested match of a bank line, choose another, accept all the sure ones, and take a wrong acceptance back (money in also needs payments.record, taking it back payments.void).' },
})

export const PAYMENTS_BANK_VIEW = 'payments.bank.view' satisfies Permission
export const PAYMENTS_BANK_IMPORT = 'payments.bank.import' satisfies Permission
export const PAYMENTS_BANK_MATCH = 'payments.bank.match' satisfies Permission
export const PAYMENTS_BANK_PERMISSIONS: readonly Permission[] = Object.freeze([PAYMENTS_BANK_VIEW, PAYMENTS_BANK_IMPORT, PAYMENTS_BANK_MATCH])
