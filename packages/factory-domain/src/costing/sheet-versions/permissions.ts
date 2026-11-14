import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The permission of cost sheet versions (B-W2b-420; FIN-014, FIN-015), in the costing area, office only. Reading versions,
 * comparing two, a what-if, the goal-seek and the weighted cost is costing.view (figures only with their grain); making,
 * editing, deleting and sending a DRAFT for its yes, saving a what-if and keeping a style's size weights is B-W2b-418's
 * costing.sheets.manage.
 *
 *   sheets.approve   the costing owner's: a COST_SHEET request for a yes is asked of the roles that hold it (with
 *                    approvals.decide) when no approval rule names another approver; and an approved version taken back
 *                    (frozen, WITHDRAWN). Nobody approves a version they made or sent for its yes (four eyes are two people).
 */
export const COST_SHEET_VERSIONS_DEFINITIONS = definePermissions('costing', {
  'sheets.approve': {
    risk: 'write',
    description:
      'Approve a cost sheet version before prices are released from it (the approval engine asks the roles holding it, with approvals.decide, when no approval rule names another approver; never a version you made or sent), and take an approved version back. Figures need their grain.',
  },
})

export const COSTING_SHEETS_APPROVE = 'costing.sheets.approve' satisfies Permission

export const COST_SHEET_VERSIONS_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_SHEETS_APPROVE])

/** The role templates that get it (owner: every()): finance, who owns the costing. */
export const COST_SHEET_VERSIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [COSTING_SHEETS_APPROVE],
})
