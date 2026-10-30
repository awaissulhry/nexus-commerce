import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { libraryCan, type LibraryCan } from './model'

/**
 * Design-only made-up data shared by the libraries' fixtures (SCR-047, SCR-048, SCR-049): ids, instants and the role
 * cases the Owner reviews. Nothing here is a real company, person, supplier or price: "Demo" names, DEMO- codes,
 * invented values.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = '0190f0e2-1111-7000-8000-000000000001'

/** A made-up uuid in a family (`uid('4701', 3)`). */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`

/** A made-up instant in October 2026 (UTC). */
export const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = at(29, 9, 42)

/** The office permissions of a role template (factory-domain), with its money grains as `money.<grain>`. */
function templatePermissions(key: string): string[] {
  const template = templateOf(key)
  return [...(template?.permissions ?? []), ...(template?.grains ?? []).map((grain) => `money.${grain}`), 'home.view']
}

/**
 * The role cases of the review: the Owner (every permission and grain), a product developer (the production manager's
 * template: makes materials, routings and styles, sees no money), quality (the quality inspector's template: reads the
 * libraries, keeps certificates and labels) and sales (reads materials and styles, no routing, no cost).
 */
export const ROLE_PERMISSIONS = {
  owner: [...FACTORY_PERMISSIONS.assignable.map((definition) => definition.name), 'money.cost', 'money.price', 'money.margin'],
  developer: templatePermissions('production_manager'),
  quality: templatePermissions('quality_inspector'),
  sales: templatePermissions('sales'),
} as const

export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): LibraryCan => libraryCan(ROLE_PERMISSIONS[role])
