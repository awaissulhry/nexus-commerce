import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The invoicing module's permissions (apps/factory-api modules/invoicing; features FIN-054, FIN-057, FIN-061, FIN-066,
 * FIN-085; A2 SCR-080, SCR-081). Each is checked with can() against the invoice's company AND its buyer (a role limited
 * to some customers sees and invoices only those). Amounts travel only with the money.price grain.
 *
 *   view    the invoices list and record, their lines and totals, the files, the checks before issue
 *   manage  draft invoices: create (generic, or a TD02 from a deposit request), edit their lines and text, delete a draft
 *   issue   issue a draft: its number from the company's fiscal series, its XML and courtesy PDF. Step-up (A1 §3.10:
 *           issuing invoices needs a fresh authenticator code), because an issued invoice never changes again
 */
export const INVOICES_DEFINITIONS = definePermissions('invoices', {
  view: { risk: 'read', description: 'See the invoices, deposit invoices and credit notes: lines, totals, files and the checks before issue.' },
  manage: { risk: 'write', description: 'Prepare draft invoices: create them, edit their lines and text, delete a draft.' },
  issue: { risk: 'stepUp', description: 'Issue an invoice: it gets its number and its legal XML and can never change again (a credit note corrects it).' },
})

export const INVOICES_VIEW = 'invoices.view' satisfies Permission
export const INVOICES_MANAGE = 'invoices.manage' satisfies Permission
export const INVOICES_ISSUE = 'invoices.issue' satisfies Permission
export const INVOICES_PERMISSIONS: readonly Permission[] = Object.freeze([INVOICES_VIEW, INVOICES_MANAGE, INVOICES_ISSUE])
