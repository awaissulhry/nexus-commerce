import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Saved views and the export of a list (apps/factory-api platform/views and platform/exports; B-W2a-23; PLT-163,
 * PLT-179; design shell.lists: the toolbar's Columns ▾ and Export ▾, the Customise, Save view and export-job pop-ups).
 * Reading the views shared with you needs no permission (any office session); a list's rows are always its own
 * module's permission. Office only. Nothing here carries money: an export leaves out every column of a money grain the
 * person does not hold, and names it.
 */
export const VIEWS_DEFINITIONS = definePermissions('views', {
  save: {
    risk: 'write',
    description: 'Save your own views of a list (its filters, columns and density), change and remove them, and share one with the holders of a role you hold.',
  },
  manage: {
    risk: 'write',
    description: "Share a view of a list with everyone who sees the list, make a view a role's default view of the list, and change or remove the views other people shared.",
  },
  export: {
    risk: 'write',
    description: 'Export a list you can see to a CSV or Excel file, in the background; the columns of a money grain you do not hold are left out and named in the file.',
  },
})

export const VIEWS_SAVE = 'views.save' satisfies Permission
export const VIEWS_MANAGE = 'views.manage' satisfies Permission
export const VIEWS_EXPORT = 'views.export' satisfies Permission

export const VIEWS_PERMISSIONS: readonly Permission[] = Object.freeze([VIEWS_SAVE, VIEWS_MANAGE, VIEWS_EXPORT])
