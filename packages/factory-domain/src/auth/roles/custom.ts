import type { Issue } from '../../core/errors'
import type { Grant, Permission } from '../../core/permissions'
import { grainPermission, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS, FLOOR_AREA } from '../permissions/catalogue'
import { contentChange, widens, type ContentChange } from './roles'
import type { RoleContent } from './templates'

/**
 * Custom roles in depth (B-W2b-404; PLT-031; design admin.roles "New role" and "Change role", ReviewChangesModal), pure.
 * A custom role is a copy of a ready-made office role whose permissions and grains a person ticks and unticks, then names
 * (W0). On top of W0's rules (office only, no floor or portal permission, a role that sees costs or margins asks for
 * two-factor, nobody edits a role they hold, the tenant keeps an administrator):
 *
 *   - never more than its maker: a new role holds only permissions and grains the person who makes it holds now; an edit
 *     adds only what the editor holds (what it already had stays, so a name can be changed by anyone allowed);
 *   - never the owner's every(): the owner role is not copied, and no custom role holds every office permission;
 *   - the review of a change says what it adds and removes, the grains, the two-factor rule, how many people get it at
 *     their next request, and whether it raises rights: raising asks for a fresh code, lowering never does;
 *   - archived, never deleted: an archived role changes no more and is given to nobody until it is restored (the database
 *     keeps both; B-W2b-373). Archiving ends its live assignments in the same command.
 *
 * Never a figure about a single person: the review counts the holders of the role, it never lists what one person did.
 */

/** The ready-made role that holds every office permission: never copied into a custom role. */
export const OWNER_TEMPLATE = 'owner'

/** The codes of a refused custom-role change (paths `body/<field>/<code>` or `roles/<code>`); the web says its own words. */
export const CUSTOM_ROLE_REFUSALS = Object.freeze({
  beyondYou: 'A custom role never holds more than the person who makes it: you do not hold this.',
  ownerEvery: "A custom role never holds every office permission: that is the owner's role.",
  ownerCopy: "The owner's role cannot be copied: a custom role never holds every office permission.",
  system: 'A ready-made role is never archived: it follows its template.',
  readyMade: 'A ready-made role follows its template and cannot be edited; copy it into a custom role.',
  archived: 'This role is archived: it changes no more. Restore it first.',
  held: 'You hold this role: ask another administrator.',
  notArchived: 'This role is not archived.',
  alreadyArchived: 'This role is archived already.',
  lastAdmin: 'Archiving would leave the tenant without an administrator.',
})
export type CustomRoleRefusal = keyof typeof CUSTOM_ROLE_REFUSALS

const refusal = (path: string, code: CustomRoleRefusal): Issue => ({ path: `${path}/${code}`, message: CUSTOM_ROLE_REFUSALS[code] })

/** Every permission a person holds now: the union of their grants (any company). */
export const heldPermissions = (grants: readonly Grant[]): ReadonlySet<string> => new Set(grants.flatMap((grant) => grant.permissions))

/** What of a content the maker does not hold (permissions, then grains: `money.<grain>` in their grants). */
export function beyondMaker(content: Pick<RoleContent, 'permissions' | 'grains'>, makerGrants: readonly Grant[]): { readonly permissions: readonly Permission[]; readonly grains: readonly Grain[] } {
  const held = heldPermissions(makerGrants)
  return {
    permissions: content.permissions.filter((permission) => !held.has(permission)),
    grains: content.grains.filter((grain) => !held.has(grainPermission(grain))),
  }
}

/** Every office permission a role may hold (the owner's every()). */
const OFFICE_ASSIGNABLE: readonly Permission[] = FACTORY_PERMISSIONS.assignable.filter((definition) => definition.area !== FLOOR_AREA).map((definition) => definition.name)

/** The content holds every office permission (the owner's every()). */
export const holdsEveryOfficePermission = (permissions: readonly string[]): boolean => {
  const listed = new Set(permissions)
  return OFFICE_ASSIGNABLE.every((permission) => listed.has(permission))
}

/**
 * The refusals of a custom role's content against its maker: a new role (`before` null) checks all of it, an edit what it
 * adds. Paths name the body fields.
 */
export function customContentRefusals(
  before: Pick<RoleContent, 'permissions' | 'grains'> | null,
  after: Pick<RoleContent, 'permissions' | 'grains'>,
  makerGrants: readonly Grant[],
): Issue[] {
  const change = before === null ? null : contentChange(before, after)
  const added = change === null ? after : { permissions: change.permissionsAdded as Permission[], grains: change.grainsAdded }
  const beyond = beyondMaker(added, makerGrants)
  const issues: Issue[] = []
  for (const permission of beyond.permissions) issues.push(refusal(`body/permissions/${permission}`, 'beyondYou'))
  for (const grain of beyond.grains) issues.push(refusal(`body/grains/${grain}`, 'beyondYou'))
  if (holdsEveryOfficePermission(after.permissions)) issues.push(refusal('body/permissions', 'ownerEvery'))
  return issues
}

/** The review of a change of a custom role (the ReviewChangesModal of "Change role"). */
export interface RoleReview extends ContentChange {
  readonly requireMfa: { readonly before: boolean; readonly after: boolean }
  /** The change gives something the role did not give (a permission, a grain, or two-factor no longer asked). */
  readonly raises: boolean
}

export function reviewOf(
  before: Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>,
  after: Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>,
): RoleReview {
  return { ...contentChange(before, after), requireMfa: { before: before.requireMfa, after: after.requireMfa }, raises: widens(before, after) }
}
