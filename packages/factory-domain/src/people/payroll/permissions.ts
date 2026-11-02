import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The payroll export (B-W2b-54; apps/factory-api modules/people/payroll; MES-267, MES-268, MES-270 to MES-274; design
 * people.payroll), in the people area. Nexus does not run payroll: it makes the month's file for the labour consultant. A
 * payroll export is a company's whole month, so each is checked over every site of the company. An amount in it carries the
 * pay grain (`money.pay`).
 *
 *   people.payroll.view      the month's state and checks (counts), the code mapping, the layouts, the past exports with
 *                            their seals and links: no person, no figure
 *   people.payroll.records   the values per employee code (the preview, an export's values), the files, the names behind
 *                            a check. `write` on purpose, so read-only never holds it; each opening is recorded. Amounts
 *                            also ask the pay grain
 *   people.payroll.manage    the code mapping and the layouts changed, an export made or corrected, a draft cancelled,
 *                            the file sent by secure link and the link withdrawn
 */
export const PEOPLE_PAYROLL_DEFINITIONS = definePermissions('people', {
  'payroll.view': {
    risk: 'read',
    description: "See a month's payroll export: its state, its checks as counts, the code mapping, the layouts and the past exports. Never one person's figures.",
  },
  'payroll.records': {
    risk: 'write',
    description: 'Open the values per employee code and the files of a payroll export. Amounts also ask the pay grain, and each opening is recorded.',
  },
  'payroll.manage': {
    risk: 'write',
    description: 'Keep the payroll code mapping and layouts, make a monthly payroll export or a correction export, and send it to the labour consultant by a secure link.',
  },
})

export const PEOPLE_PAYROLL_VIEW = 'people.payroll.view' satisfies Permission
export const PEOPLE_PAYROLL_RECORDS = 'people.payroll.records' satisfies Permission
export const PEOPLE_PAYROLL_MANAGE = 'people.payroll.manage' satisfies Permission

export const PEOPLE_PAYROLL_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_PAYROLL_VIEW, PEOPLE_PAYROLL_RECORDS, PEOPLE_PAYROLL_MANAGE])
