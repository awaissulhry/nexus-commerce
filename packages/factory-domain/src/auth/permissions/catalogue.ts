import { LINK_SESSION_PERMISSIONS as LINK_SESSION_NAMES, LINKS_OFFICE_PERMISSIONS } from '../../links/permissions'
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

/** One-off links, office side (platform/links): make, revoke and follow the links of a record. */
export const LINKS_PERMISSIONS = definePermissions('links', {
  view: { risk: 'read', description: 'See the one-off links of a record: whom they were made for, their state, their uses and the evidence of each answer.' },
  manage: { risk: 'write', description: 'Make a one-off link for a record, to send to its customer or supplier, and revoke one.' },
})

/**
 * What a one-off link session may do (platform/links). Held only by link sessions, from the link's purpose
 * (factory-domain links/purposes): never assignable to a role.
 */
export const LINK_SESSION_PERMISSIONS: PermissionDefinition[] = definePermissions('links', {
  open: { risk: 'read', description: "Open the link's one record (its own prices only when the purpose shows its own document)." },
  accept: { risk: 'write', description: 'Accept the quote the link opens, with a typed name (and the address it was sent to, when known).' },
  decline: { risk: 'write', description: 'Decline the quote or purchase order the link opens.' },
  confirm: { risk: 'write', description: 'Confirm the purchase order the link opens.' },
}).map((definition) => Object.freeze({ ...definition, link: true as const }))

/** The money grains as they travel in grants (`../grains/grains`): from Role.grains, never Role.permissions. */
export const MONEY_PERMISSIONS: PermissionDefinition[] = GRAINS.map((grain) =>
  Object.freeze({ name: grainPermission(grain), area: 'money', description: GRAIN_DESCRIPTIONS[grain], risk: 'read' as const, grain }),
)

export const FACTORY_PERMISSIONS = permissionRegistry([
  USERS_PERMISSIONS,
  ROLES_PERMISSIONS,
  AUDIT_PERMISSIONS,
  NUMBERING_DEFINITIONS,
  LINKS_PERMISSIONS,
  LINK_SESSION_PERMISSIONS,
  MONEY_PERMISSIONS,
])

// The modules' constants and their declarations name the same permissions.
for (const name of [NUMBERING_VIEW, NUMBERING_MANAGE, ...LINKS_OFFICE_PERMISSIONS]) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by its module but not declared`)
}
for (const name of LINK_SESSION_NAMES) {
  if (FACTORY_PERMISSIONS.get(name)?.link !== true) throw new Error(`${name} is a link-session permission but not declared as one`)
}
