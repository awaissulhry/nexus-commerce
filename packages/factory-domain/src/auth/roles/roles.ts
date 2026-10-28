import type { Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import type { Grant, Permission, ScopeSet } from '../../core/permissions'
import { GRAINS, grainPermission, isGrain, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS } from '../permissions/catalogue'
import type { PermissionRegistry } from '../permissions/registry'
import { templateOf, type RoleContent } from './templates'

/**
 * Roles, assignments and the grants they give (plan A1 §2.3 Role and RoleAssignment, §3.11; features PLT-030,
 * PLT-032, PLT-045). Pure: the API reads the rows and asks these functions.
 *
 * An assignment gives one role to one person, limited to:
 *   companies   every company of the tenant (`allCompanies`, also those added later) or exactly a list (never empty)
 *   sites       a list, or none for no site limit
 *   parties     a list of customers or suppliers, or none for no party limit
 * and live from `validFrom` until `validTo` (when set) or until it is ended. Each live assignment is one Grant: its
 * role's permissions plus a `money.<grain>` permission per grain, over the assignment's scope; a session holds the
 * union. A role that requires two-factor gives nothing until two-factor was proved on the session; a person who
 * requires two-factor (User.requireMfa) holds nothing at all until then.
 */

/** Custom roles' keys start with this; template keys never contain a dot, so they never clash. */
export const CUSTOM_KEY_PREFIX = 'custom.'
const SLUG = /^[a-z][a-z0-9_]{1,47}$/

export const customKey = (slug: string): string => `${CUSTOM_KEY_PREFIX}${slug}`
export const isCustomKey = (key: string): boolean => key.startsWith(CUSTOM_KEY_PREFIX)

/** The permission that makes an administrator: whoever holds it over every company can fix anyone's access. */
export const ADMIN_PERMISSION: Permission = 'roles.assign'

/** A role's content with its lists sorted and without repeats (what is stored and compared). */
export function normalizeContent<T extends Pick<RoleContent, 'permissions' | 'grains'>>(content: T): T {
  return {
    ...content,
    permissions: [...new Set(content.permissions)].sort(),
    grains: GRAINS.filter((grain) => content.grains.includes(grain)),
  }
}

/** What is wrong with a custom role's content (paths name the body fields). */
export function roleProblems(
  content: Pick<RoleContent, 'name' | 'requireMfa' | 'permissions' | 'grains'>,
  registry: PermissionRegistry = FACTORY_PERMISSIONS,
): Issue[] {
  const issues: Issue[] = []
  if (content.name.trim() === '' || content.name.length > 100) issues.push({ path: 'name', message: 'Expected 1 to 100 characters.' })
  content.permissions.forEach((permission, index) => {
    const definition = registry.get(permission)
    if (!definition) issues.push({ path: `permissions/${index}`, message: `${permission} is not a permission of the factory.` })
    else if (definition.grain !== undefined) issues.push({ path: `permissions/${index}`, message: `${permission} is a money grain: list it in grains.` })
    else if (definition.link === true) {
      issues.push({ path: `permissions/${index}`, message: `${permission} is held only by a one-off link session, from its purpose; a role cannot give it.` })
    }
  })
  content.grains.forEach((grain, index) => {
    if (!isGrain(grain)) issues.push({ path: `grains/${index}`, message: `${String(grain)} is not a money grain (${GRAINS.join(', ')}).` })
  })
  const sensitive = content.grains.filter((grain) => grain === 'cost' || grain === 'margin')
  if (sensitive.length > 0 && !content.requireMfa) {
    issues.push({ path: 'requireMfa', message: `A role that sees ${sensitive.join(' and ')} requires two-factor.` })
  }
  return issues
}

/** The custom key for a slug, or a problem. */
export function customKeyProblems(slug: string): Issue[] {
  return SLUG.test(slug) ? [] : [{ path: 'key', message: 'Expected 2 to 48 lower-case letters, digits or underscores, starting with a letter.' }]
}

/** What changed between two contents (for the audit row and the role screens). */
export interface ContentChange {
  readonly permissionsAdded: readonly string[]
  readonly permissionsRemoved: readonly string[]
  readonly grainsAdded: readonly Grain[]
  readonly grainsRemoved: readonly Grain[]
}

export function contentChange(
  before: Pick<RoleContent, 'permissions' | 'grains'>,
  after: Pick<RoleContent, 'permissions' | 'grains'>,
): ContentChange {
  const minus = <T>(a: readonly T[], b: readonly T[]): T[] => [...new Set(a)].filter((item) => !b.includes(item)).sort() as T[]
  return {
    permissionsAdded: minus(after.permissions, before.permissions),
    permissionsRemoved: minus(before.permissions, after.permissions),
    grainsAdded: minus(after.grains, before.grains),
    grainsRemoved: minus(before.grains, after.grains),
  }
}

/** True when the second content gives something the first does not (more permissions, grains, or less two-factor). */
export function widens(before: Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>, after: Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>): boolean {
  const change = contentChange(before, after)
  return change.permissionsAdded.length > 0 || change.grainsAdded.length > 0 || (before.requireMfa && !after.requireMfa)
}

/**
 * What the template a custom role was copied from now has that the copy lacks: shown on the role screens, never
 * applied by itself (a template update does not widen a custom role). Empty for a role not based on a template.
 */
export function templateAdds(role: { readonly basedOn: string | null } & Pick<RoleContent, 'permissions' | 'grains'>): Pick<ContentChange, 'permissionsAdded' | 'grainsAdded'> {
  const source = role.basedOn === null ? undefined : templateOf(role.basedOn)
  if (!source) return { permissionsAdded: [], grainsAdded: [] }
  const change = contentChange(role, source)
  return { permissionsAdded: change.permissionsAdded, grainsAdded: change.grainsAdded }
}

/** The scope of one assignment, as stored. */
export interface AssignmentScope {
  readonly allCompanies: boolean
  readonly companyIds: readonly string[]
  /** Empty: no site limit. */
  readonly siteIds: readonly string[]
  /** Empty: no party limit. */
  readonly partyIds: readonly string[]
}

export function scopeProblems(scope: AssignmentScope): Issue[] {
  const issues: Issue[] = []
  if (scope.allCompanies && scope.companyIds.length > 0) issues.push({ path: 'companyIds', message: 'Either every company or a list, not both.' })
  if (!scope.allCompanies && scope.companyIds.length === 0) issues.push({ path: 'companyIds', message: 'Name at least one company, or choose every company.' })
  for (const field of ['companyIds', 'siteIds', 'partyIds'] as const) {
    const ids = scope[field]
    if (ids.some((id) => !isUuid(id))) issues.push({ path: field, message: 'Expected ids.' })
    if (new Set(ids).size !== ids.length) issues.push({ path: field, message: 'An id is listed twice.' })
  }
  return issues
}

const scopeSet = (ids: readonly string[], emptyMeans: 'all' | 'none'): ScopeSet => (ids.length === 0 && emptyMeans === 'all' ? 'all' : Object.freeze([...ids].sort()))

/** The grant of one assignment of a role. */
export function grantOf(role: Pick<RoleContent, 'permissions' | 'grains'>, scope: AssignmentScope): Grant {
  const permissions = [...new Set([...role.permissions, ...role.grains.filter(isGrain).map(grainPermission)])].sort() as Permission[]
  return Object.freeze({
    permissions: Object.freeze(permissions),
    companies: scope.allCompanies ? 'all' : scopeSet(scope.companyIds, 'none'),
    sites: scopeSet(scope.siteIds, 'all'),
    parties: scopeSet(scope.partyIds, 'all'),
  })
}

/** An assignment is live: started, not past its end, not ended. */
export function isLive(assignment: { readonly validFrom: Date; readonly validTo: Date | null; readonly endedAt: Date | null }, now: Date): boolean {
  const at = now.getTime()
  return assignment.endedAt === null && assignment.validFrom.getTime() <= at && (assignment.validTo === null || assignment.validTo.getTime() > at)
}

/** One live assignment with its role, as the session's grants are built from. */
export interface HeldRole {
  readonly role: Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>
  readonly scope: AssignmentScope
}

/** Two-factor is required for this person: by their own flag or by a role they hold. */
export function mfaRequiredFor(user: { readonly requireMfa: boolean }, held: readonly HeldRole[]): boolean {
  return user.requireMfa || held.some(({ role }) => role.requireMfa)
}

/**
 * The grants of a session: one per live assignment, without the roles that require two-factor until it was proved on
 * the session; nothing at all when the person requires two-factor and has not proved it.
 */
export function sessionGrants(user: { readonly requireMfa: boolean }, held: readonly HeldRole[], mfaProved: boolean): Grant[] {
  if (user.requireMfa && !mfaProved) return []
  return held.filter(({ role }) => mfaProved || !role.requireMfa).map(({ role, scope }) => grantOf(role, scope))
}

/**
 * What of an assignment's scope the assigner's ADMIN_PERMISSION grants do not reach (plan A1 §3.11; no escalation): a
 * person gives roles only within their own roles.assign scope. Each part of the new scope needs ONE grant of the
 * assigner that reaches it, with a party limit at least as tight:
 *   every company, no site limit       a grant over every company and every site
 *   every company, some sites          per site, a grant over every company that reaches the site
 *   some companies, no site limit      per company, a grant that reaches it with every site
 *   some companies, some sites         per company a grant that reaches it; per site a grant that reaches its company
 *                                      and the site
 * `siteCompanies` maps each site of the new scope to its company. Empty: the assigner may give it.
 */
export function uncoveredScope(assignerGrants: readonly Grant[], scope: AssignmentScope, siteCompanies: ReadonlyMap<string, string>): Issue[] {
  const grants = assignerGrants.filter((grant) => grant.permissions.includes(ADMIN_PERMISSION))
  const reaches = (set: ScopeSet, id: string): boolean => set === 'all' || set.includes(id)
  const parties = (grant: Grant): boolean =>
    grant.parties === 'all' || (scope.partyIds.length > 0 && scope.partyIds.every((party) => reaches(grant.parties, party)))
  const some = (test: (grant: Grant) => boolean): boolean => grants.some((grant) => parties(grant) && test(grant))
  const issues: Issue[] = []
  const wider = (path: string, what: string) => issues.push({ path, message: `Outside your own ${ADMIN_PERMISSION} scope: ${what}.` })

  if (scope.allCompanies) {
    if (scope.siteIds.length === 0) {
      if (!some((grant) => grant.companies === 'all' && grant.sites === 'all')) wider('allCompanies', 'every company and site')
    } else {
      for (const site of scope.siteIds) {
        if (!some((grant) => grant.companies === 'all' && reaches(grant.sites, site))) wider('siteIds', `site ${site} in every company`)
      }
    }
  } else {
    for (const company of scope.companyIds) {
      const fits = scope.siteIds.length === 0 ? (grant: Grant) => reaches(grant.companies, company) && grant.sites === 'all' : (grant: Grant) => reaches(grant.companies, company)
      if (!some(fits)) wider('companyIds', `company ${company}`)
    }
    for (const site of scope.siteIds) {
      const company = siteCompanies.get(site)
      if (company === undefined || !some((grant) => reaches(grant.companies, company) && reaches(grant.sites, site))) wider('siteIds', `site ${site}`)
    }
  }
  return issues
}

/** The assignment makes its holder an administrator (ADMIN_PERMISSION over every company). */
export function isAdminAssignment(role: Pick<RoleContent, 'permissions'>, scope: Pick<AssignmentScope, 'allCompanies'>): boolean {
  return scope.allCompanies && role.permissions.includes(ADMIN_PERMISSION)
}
