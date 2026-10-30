import type { PermissionCatalogue, Role, User } from '../shared/api'
import { matches, type Loaded, type ScopeOption } from '../shared/model'
import type { RoleTwoFactorModel } from '../security/view/RoleTwoFactor'

/**
 * SCR-012 Roles & permissions (design 02 admin.roles; PLT-029, PLT-030, PLT-034): the ready-made roles (kept equal to
 * their templates) and the tenant's custom copies, each said in plain words first — what it does, what money it sees —
 * then as a ticked list of actions. A role record: Permissions, Scope rules, Users, Activity. Creating and editing a
 * custom role comes in W2b (design: new-role, save-role); W0 reads and compares.
 */

export const ROLE_TABS = ['permissions', 'rules', 'users', 'activity'] as const
export type RoleTab = (typeof ROLE_TABS)[number]

export interface RolesViewModel {
  prefix: string
  roles: Loaded<Role>
  catalogue: PermissionCatalogue | null
  asOf: string | null
  query: string
  audience: 'all' | 'office' | 'floor'
  /** Pages of 50 rows shown ("Show 50 more" adds one). */
  pages: number
  /** Rows ticked at first (design fixtures); the view keeps the ticks. Compare reads them. */
  selected?: readonly string[]
  /** The compare dialog is open at first, with these roles (design fixtures). */
  compare?: readonly string[] | null
}

/** Compare puts two or three roles side by side: the ticked rows are the pick, held with its reason otherwise. */
export const COMPARE_MAX = 3
export function compareHeld(count: number): string | null {
  return count < 2 ? 'roles.bulk.held.compareOne' : count > COMPARE_MAX ? 'roles.bulk.held.compareMany' : null
}

export function roleRows(roles: readonly Role[], query: string, audience: RolesViewModel['audience']): Role[] {
  const order = (role: Role) => (role.audience === 'office' ? 0 : 1) * 10 + (role.system ? 0 : 1)
  return roles
    .filter((role) => audience === 'all' || role.audience === audience)
    .filter((role) => matches(query, role.name, role.key, role.description))
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
}

/** What a custom copy lacks that its ready-made template gained; or a ready-made role a sync will update. */
export function templateGap(role: Role): { kind: 'adds'; count: number } | { kind: 'outdated' } | null {
  if (role.outdated) return { kind: 'outdated' }
  const count = role.templateAdds.permissionsAdded.length + role.templateAdds.grainsAdded.length
  return count > 0 ? { kind: 'adds', count } : null
}

export interface RoleRecordModel {
  prefix: string
  tab: RoleTab
  role: Role | null
  problem?: string | null
  catalogue: PermissionCatalogue | null
  /** People who hold the role now (from the users list), with where. */
  holders: Loaded<User>
  companies: readonly ScopeOption[]
  dockOpen?: boolean
  /** B-W2a-36: Scope rules › Two-factor (the switch, with who it affects); absent: the W0 read-only words. */
  twoFactor?: RoleTwoFactorModel
}

/** The rules every role keeps whatever it holds (A1 §2.3, §3.11; PLT-033, PLT-035): message keys, read-only. */
export const ALWAYS_RULES = ['released', 'floorNoCost', 'partnerPrice', 'ownRequest', 'ownRoles', 'lastAdmin', 'stepUp'] as const

/** The permissions the role holds, by area, as the catalogue orders them (the "plain" card's lines). */
export function heldAreas(role: Role, catalogue: PermissionCatalogue | null): Array<{ area: string; count: number; total: number }> {
  if (!catalogue) return []
  const held = new Set(role.permissions)
  const areas: Array<{ area: string; count: number; total: number }> = []
  for (const permission of catalogue.permissions) {
    if (permission.area === 'floor' && role.audience === 'office') continue
    let row = areas.find((item) => item.area === permission.area)
    if (!row) areas.push((row = { area: permission.area, count: 0, total: 0 }))
    row.total += 1
    if (held.has(permission.name)) row.count += 1
  }
  return areas.filter((row) => row.count > 0)
}

/** One holder of a role: the person, and where and until when their assignment gives it. */
export interface Holder {
  /** The assignment's id (a person may hold a role twice, in two places). */
  id: string
  user: User
  scope: { allCompanies: boolean; companyIds: string[]; siteIds: string[] }
  validTo: string | null
}

/** The users who hold the role (a live assignment), with the assignment's scope. */
export function holdersOf(role: Role, users: readonly User[]): Holder[] {
  return users.flatMap((user) =>
    user.roles
      .filter((held) => held.roleId === role.id)
      .map((held) => ({ id: held.assignmentId, user, scope: { allCompanies: held.allCompanies, companyIds: held.companyIds, siteIds: held.siteIds }, validTo: held.validTo })),
  )
}
