import type { Permission } from '../../core/permissions'

/**
 * owb-of2 (order workflow, plan.md § 5f "People by customer", "Extra rights"; the base's offer templates, shared-asks 22:41): which
 * office people work for which customer (the pool, PartyOfficePerson: given, or taken out with an end — never deleted), and the
 * three extra rights a person may hold beside the main role. Each extra right IS the base's ready-made role template of that key,
 * given and ended through today's role assignment (apps/factory-api platform/auth/roles assignRole / endAssignment): no table, no
 * new path. The page and its writes need the right that gives roles today (`roles.assign`: the Owner and the Administrator).
 */

export const EXTRA_RIGHTS = ['ALLOW_PRODUCTION', 'PACK_AND_SEND', 'PRINT_AND_START'] as const
export type ExtraRight = (typeof EXTRA_RIGHTS)[number]

/** The role template of each extra right (factory-domain auth/roles/templates.ts, owb- offers). */
export const EXTRA_RIGHT_ROLE: Readonly<Record<ExtraRight, string>> = Object.freeze({
  ALLOW_PRODUCTION: 'extra_allow_production',
  PACK_AND_SEND: 'extra_pack_and_send',
  PRINT_AND_START: 'extra_print_and_start',
})

/** The extra right a role key gives, or null (any other role). */
export function extraRightOf(roleKey: string): ExtraRight | null {
  const found = (Object.entries(EXTRA_RIGHT_ROLE) as [ExtraRight, string][]).find(([, key]) => key === roleKey)
  return found ? found[0] : null
}

/** The right that keeps the pool and gives the extra rights: the one that assigns roles today. */
export const PEOPLE_BY_CUSTOMER_RIGHT = 'roles.assign' satisfies Permission

/** A person's roles in few words: the main roles' names (an extra right is not a main role), in the order given. */
export function roleWordsOf(roles: readonly { readonly roleKey: string; readonly roleName: string }[]): string {
  return [...new Set(roles.filter((role) => extraRightOf(role.roleKey) === null).map((role) => role.roleName))].join(' · ')
}

/** The extra rights a person holds, in EXTRA_RIGHTS' order, each once. */
export function extraRightsOf(roles: readonly { readonly roleKey: string }[]): ExtraRight[] {
  const held = new Set(roles.map((role) => extraRightOf(role.roleKey)).filter((right): right is ExtraRight => right !== null))
  return EXTRA_RIGHTS.filter((right) => held.has(right))
}
