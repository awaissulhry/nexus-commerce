import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'
import { definePermissions, type PermissionDefinition } from '../../auth/permissions/registry'

/**
 * Accountant access (B-W2b-201; FIN-158, PLT-022; design portal.guest.accountant, SCR-268, and the finance.accounting
 * connection "Portal › Accountant"): the company's accounting firm is a party with the CONSULTANT role whose people sign in
 * to a guest portal (kind GUEST, role `guest-accountant`) that always ends on a date.
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   accounting.view   the accountant's room: the months finance handed over (a month is handed over by its numbered
 *                     export), their accounting exports, every sales and purchase e-invoice of those months as XML and PDF,
 *                     the registers the exports hold; FILES only (names, numbers, dates and states on screen, never an
 *                     amount and never a record), every download in the audit log. An accountant reads every invoice of
 *                     a company, which the party wall cannot express: the API reads in the tenant's system scope after
 *                     this grant names the company (the session's) and the period (a month handed over).
 *
 * The OFFICE's (area `accounting`, beside B-W2a-39's):
 *   accountants.manage   give the company's accountant the guest portal (the firm's portal switched on, the person invited
 *                        with an end date), change when it ends, end it now (step-up: it opens the company's books to an
 *                        outside firm). Seeing who has access and what they downloaded is accounting.view.
 *
 * Given in ../../auth/roles/templates: accounting.view to `guest-accountant` (PARTNER_ADDS); accountants.manage to finance
 * (the owner by every()).
 */
export const PORTAL_ACCOUNTING_DEFINITIONS: PermissionDefinition[] = definePartnerPermissions('portal', {
  'accounting.view': {
    risk: 'read',
    description:
      "The accountant's room: the months the company's finance handed over, their numbered accounting exports, every sales and purchase e-invoice of those months (XML and PDF) and the registers; files only, read-only, every download recorded.",
  },
})

export const ACCOUNTANTS_DEFINITIONS: PermissionDefinition[] = definePermissions('accounting', {
  'accountants.manage': {
    risk: 'stepUp',
    description:
      "Give the company's accountant a read-only guest portal that ends on a date (the firm's portal switched on, the person invited), change when it ends, or end it now.",
  },
})

export const PORTAL_ACCOUNTING_VIEW = 'portal.accounting.view' satisfies Permission
export const ACCOUNTING_ACCOUNTANTS_MANAGE = 'accounting.accountants.manage' satisfies Permission

export const PORTAL_ACCOUNTING_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_ACCOUNTING_VIEW])
export const ACCOUNTANTS_PERMISSIONS: readonly Permission[] = Object.freeze([ACCOUNTING_ACCOUNTANTS_MANAGE])

/** The partner role template of the accountant (B-W2b-162's guest kind). */
export const ACCOUNTANT_ROLE_KEY = 'guest-accountant'
