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

/** The floor devices of the sites (apps/factory-api platform/auth/floor; features PLT-056, PLT-226). */
export const DEVICES_PERMISSIONS = definePermissions('devices', {
  view: { risk: 'read', description: 'See the floor devices of the sites: station, status, last contact, whether someone is signed in.' },
  manage: { risk: 'write', description: 'Enrol a floor device with a one-time QR code, rename it, move it to a station, set the floor session times of a site.' },
  revoke: { risk: 'write', description: 'Revoke a lost or retired floor device: its sign-ins end at once.' },
})

/** The floor workers of the sites, kept to what the work needs (features PLT-018, PLT-019; GDPR art. 5(1)(c)). */
export const WORKERS_PERMISSIONS = definePermissions('workers', {
  view: { risk: 'read', description: 'See the floor workers of the sites: name, language, badges, floor roles.' },
  manage: { risk: 'write', description: 'Add a floor worker, edit their name and language, give them floor roles, deactivate and reactivate them.' },
  credentials: { risk: 'write', description: "Issue and revoke a worker's badge, and reset their PIN." },
})

/**
 * What floor sessions do (audience floor: only floor roles hold them). The floor modules add theirs (scans, cut
 * logs, inspections) and give them to the floor templates.
 */
export const FLOOR_PERMISSIONS = definePermissions('floor', {
  work: { risk: 'write', description: "Work on an enrolled floor device: the work screens of the device's site." },
  lead: { risk: 'write', description: "Lead a crew on the floor: the team leader's screens of the device's site." },
})

/** The money grains as they travel in grants (`../grains/grains`): from Role.grains, never Role.permissions. */
export const MONEY_PERMISSIONS: PermissionDefinition[] = GRAINS.map((grain) =>
  Object.freeze({ name: grainPermission(grain), area: 'money', description: GRAIN_DESCRIPTIONS[grain], risk: 'read' as const, grain }),
)

export const FACTORY_PERMISSIONS = permissionRegistry([
  USERS_PERMISSIONS,
  ROLES_PERMISSIONS,
  AUDIT_PERMISSIONS,
  NUMBERING_DEFINITIONS,
  DEVICES_PERMISSIONS,
  WORKERS_PERMISSIONS,
  FLOOR_PERMISSIONS,
  MONEY_PERMISSIONS,
])

/** The area of the permissions only floor roles hold (and floor roles hold no other). */
export const FLOOR_AREA = 'floor'

// The numbering module's constants and its declarations name the same permissions.
for (const name of [NUMBERING_VIEW, NUMBERING_MANAGE]) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by the numbering module but not declared`)
}
