import type { Permission } from '../../core/permissions'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '../../numbering/permissions'
import { GRAIN_DESCRIPTIONS, GRAINS, grainPermission } from '../grains/grains'
import { definePermissions, permissionRegistry, type PermissionDefinition } from './registry'

/**
 * Every permission of the factory, assembled (feature PLT-029). A module that adds routes declares its permissions
 * with `definePermissions('<module>', {…})` in `factory-domain/src/<module>/permissions.ts` and adds its list to
 * FACTORY_PERMISSIONS here, in the same PR as the routes (the API refuses to boot on a manifest permission that is
 * not declared). It then gives the new permissions to the role templates that need them (`../roles/templates`).
 */

/** The tenant's people (apps/factory-api platform/auth/users and invitations). */
export const USERS_PERMISSIONS = definePermissions('users', {
  view: { risk: 'read', description: 'See the people of the tenant: status, two-factor, open invitations.' },
  invite: { risk: 'stepUp', description: 'Invite a person by email, with their first roles, and revoke an open invitation.' },
  suspend: { risk: 'stepUp', description: 'Suspend a person: every session ends at once.' },
  reactivate: { risk: 'stepUp', description: 'Give a suspended person their access back.' },
  deactivate: { risk: 'stepUp', description: 'Deactivate a person who left: credentials cleared, history kept.' },
  resetPassword: { risk: 'stepUp', description: 'Require a new password at the next sign-in.' },
})

/** Roles and their assignments (platform/auth/roles). */
export const ROLES_PERMISSIONS = definePermissions('roles', {
  view: { risk: 'read', description: 'See the role templates, the roles of the tenant and who holds them.' },
  manage: { risk: 'stepUp', description: 'Create and edit custom roles, and bring the system roles up to their templates.' },
  assign: { risk: 'stepUp', description: 'Give roles to people, limited to companies, sites or customers, and end them.' },
})

/** The audit log (platform/audit). */
export const AUDIT_PERMISSIONS = definePermissions('audit', {
  read: { risk: 'read', description: 'Read the history of a record (money values only with their grain).' },
})

/** Document numbering (platform/numbering; the constants live in factory-domain/src/numbering/permissions.ts). */
export const NUMBERING_DEFINITIONS = definePermissions('numbering', {
  view: { risk: 'read', description: "See the companies' number series and their next numbers." },
  manage: { risk: 'write', description: 'Create a number series, set where it starts, move it past a number.' },
})

/**
 * Files on R2 (apps/factory-api platform/files; plan A1 §3.6, COL-045, COL-050). Each is checked with can() against the
 * file's company, and for a floor, portal or link session against the site or party the file is shared with (that
 * audience's own rule decides what it sees; a role only grants the permission). Sharing beyond the office, retention
 * and legal hold are files.manage. Not step-up: A1 §3.10 keeps step-up for bank details, issuing invoices and user and
 * role changes; a retained or held file cannot be deleted by anyone (the database refuses it too).
 */
export const FILES_DEFINITIONS = definePermissions('files', {
  read: { risk: 'read', description: "See a record's files and download them (floor, portal and link sessions: only what is shared with them)." },
  upload: { risk: 'write', description: 'Upload a file to a record (seen by the office only, unless shared with files.manage).' },
  delete: { risk: 'write', description: 'Delete a file; never one on legal hold or before its retention date.' },
  manage: { risk: 'write', description: 'Share a file with a floor, a portal or links; set its retention date and legal hold.' },
})
export const FILES_READ = 'files.read' satisfies Permission
export const FILES_UPLOAD = 'files.upload' satisfies Permission
export const FILES_DELETE = 'files.delete' satisfies Permission
export const FILES_MANAGE = 'files.manage' satisfies Permission

/**
 * Imports with a dry run (apps/factory-api platform/imports; plan A1 W0-22, feature PLT-176). Each is checked with can()
 * against the job's company. An importer also names the permissions of the records it writes (its adapter's
 * `permission` to run and apply it, `viewPermission` to see its plans): imports.* alone never reaches a record. Money
 * columns need their grain as well, to import and to see. Not step-up (A1 §3.10, as files).
 */
export const IMPORTS_DEFINITIONS = definePermissions('imports', {
  view: { risk: 'read', description: 'See import jobs and their plans (values of money columns only with their grain).' },
  run: { risk: 'write', description: 'Upload a sheet for an import and see its dry run; cancel an import.' },
  apply: { risk: 'write', description: "Apply an import's plan: its valid rows are written to the records." },
})
export const IMPORTS_VIEW = 'imports.view' satisfies Permission
export const IMPORTS_RUN = 'imports.run' satisfies Permission
export const IMPORTS_APPLY = 'imports.apply' satisfies Permission

/** The money grains as they travel in grants (`../grains/grains`): from Role.grains, never Role.permissions. */
export const MONEY_PERMISSIONS: PermissionDefinition[] = GRAINS.map((grain) =>
  Object.freeze({ name: grainPermission(grain), area: 'money', description: GRAIN_DESCRIPTIONS[grain], risk: 'read' as const, grain }),
)

export const FACTORY_PERMISSIONS = permissionRegistry([
  USERS_PERMISSIONS,
  ROLES_PERMISSIONS,
  AUDIT_PERMISSIONS,
  NUMBERING_DEFINITIONS,
  FILES_DEFINITIONS,
  IMPORTS_DEFINITIONS,
  MONEY_PERMISSIONS,
])

// The modules' constants and their declarations name the same permissions.
for (const name of [NUMBERING_VIEW, NUMBERING_MANAGE, FILES_READ, FILES_UPLOAD, FILES_DELETE, FILES_MANAGE, IMPORTS_VIEW, IMPORTS_RUN, IMPORTS_APPLY]) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
}
