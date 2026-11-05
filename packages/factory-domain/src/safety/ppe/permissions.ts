import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: PPE for workers (apps/factory-api modules/safety/ppe; B-W2b-134; QHS-259, QHS-260, QHS-261; design plant.ppe
 * "Catalogue", "Kits per role", "Gaps per person", "Issues and receipts", the pop-ups "Issue PPE", "PPE item", "Void an
 * issue"; floor.training "Receive PPE"), in the safety area. Reading is safety.view (../organisation/permissions.ts); checked
 * with can() against the record's company (an item) or the person's company and site (an issue, a gap).
 *
 *   safety.ppe.manage   keep the PPE catalogue of a company: add an item (category I, II or III, the standard it meets, its
 *                       sizes, how many months it lasts, the supplier; its unit cost with the cost grain), change it, archive
 *                       one no role's kit names, restore it; start from the common items.
 *   safety.ppe.issue    record PPE handed over in the office with the person's paper receipt (its scan a file of the
 *                       receipt), void a wrong issue with the reason (the receipt stays with a void mark), keep a receipt's
 *                       PDF.
 *
 * A role's kit is the role sheet's (safety.rolesheets.manage): read here, never typed twice. On the floor the person receiving
 * signs with their badge and PIN (floor.work: the floor's own sign-in rules and lockout).
 */
export const SAFETY_PPE_DEFINITIONS = definePermissions('safety', {
  'ppe.manage': {
    risk: 'write',
    description:
      'Keep the PPE catalogue of a company: add a PPE item (category I, II or III, the standard it meets, its sizes, how many months it lasts, its supplier; its unit cost only with the cost grain), change it, archive an item no role kit names and restore it, or start from the common items.',
  },
  'ppe.issue': {
    risk: 'write',
    description:
      "Record PPE handed over in the office with the person's signed paper receipt (the scan kept with the receipt), void a wrong issue with the reason (the receipt stays, marked void), and keep a receipt's PDF. On the floor the person signs with their badge and PIN.",
  },
})

export const SAFETY_PPE_MANAGE = 'safety.ppe.manage' satisfies Permission
export const SAFETY_PPE_ISSUE = 'safety.ppe.issue' satisfies Permission

export const SAFETY_PPE_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_PPE_MANAGE, SAFETY_PPE_ISSUE])
