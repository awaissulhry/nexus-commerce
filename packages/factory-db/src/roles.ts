import type { PolicyKey, ScopeDefinition } from '@nexus/db-kit'

/**
 * The factory's database walls (plan A1 §2.2): the runtime roles, the login that enters them, the settings the
 * policies read and the scope of each audience. The policy SQL (src/policies.ts), the client (src/client.ts) and the
 * ownership check (src/ownership.ts) all read them from here.
 *
 *   role                       settings in every transaction               used by
 *   factory_runtime            tenant                                      office sessions, worker, scheduler
 *   factory_floor_runtime      tenant, site                                floor sessions on an enrolled device
 *   factory_partner_runtime    tenant, party                               portal and one-off link sessions
 *   factory_platform           none                                        sign-in lookups before a tenant is known
 *
 * Only what the policies and guards read is a setting: the client keeps one Prisma client per role and settings
 * (client.ts), and each costs about 90 MB of heap. The actor (who acts) is named by every app scope but is not a
 * setting: no policy or guard reads it (B-W2b-F9; client.vitest.test.ts fails when the SQL starts to). A guard that
 * needs the actor adds it back here, and the cache goes back to one client per person.
 *
 * The runtime roles are NOLOGIN. The API, worker and scheduler log in as `factory_app`, a member of every runtime role
 * WITH INHERIT FALSE, SET TRUE: it can enter each role, and outside one it can read no table at all. The migrations
 * run as the database owner (`factory_owner` on Railway, made by the staging step); it is never the runtime login.
 */

export const OFFICE_ROLE = 'factory_runtime'
export const FLOOR_ROLE = 'factory_floor_runtime'
export const PARTNER_ROLE = 'factory_partner_runtime'
export const PLATFORM_ROLE = 'factory_platform'

/** Every runtime role, in a fixed order. */
export const RUNTIME_ROLES = [OFFICE_ROLE, FLOOR_ROLE, PARTNER_ROLE, PLATFORM_ROLE] as const
export type RuntimeRole = (typeof RUNTIME_ROLES)[number]

/** The login the API, worker and scheduler connect as. */
export const RUNTIME_LOGIN = 'factory_app'

/** The keys the policies read: a setting, and the SQL type of the columns that hold it. */
export const POLICY_KEYS = {
  tenant: { setting: 'factory.tenant_id', type: 'uuid' },
  site: { setting: 'factory.site_id', type: 'uuid' },
  party: { setting: 'factory.party_id', type: 'uuid' },
} as const satisfies Record<string, PolicyKey>
export type PolicyKeyName = keyof typeof POLICY_KEYS

/** The wall: every policy of a runtime role checks it. */
export const WALL: readonly PolicyKeyName[] = ['tenant']

/**
 * The default of every `tenantId` column: the tenant of the transaction, or NULL (and so a refused insert) without one.
 * Written as PostgreSQL prints it back (`'…'::text`), so `prisma migrate diff` sees no change after a replay.
 */
export const TENANT_ID_DEFAULT = "(NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid"

const tenantId = { setting: POLICY_KEYS.tenant.setting, required: true } as const

/** The scope of each audience: the role its transactions enter and the settings they carry (never the actor). */
export const SCOPE_DEFINITIONS = {
  office: { role: OFFICE_ROLE, settings: { tenantId } },
  floor: { role: FLOOR_ROLE, settings: { tenantId, siteId: { setting: POLICY_KEYS.site.setting, required: true } } },
  partner: { role: PARTNER_ROLE, settings: { tenantId, partyId: { setting: POLICY_KEYS.party.setting, required: true } } },
  platform: { role: PLATFORM_ROLE, settings: {} },
} as const satisfies Record<string, ScopeDefinition>
export type Audience = keyof typeof SCOPE_DEFINITIONS

/** The policy keys a role's transactions set; a role may only be scoped by these. */
export function keysSetBy(role: string): PolicyKeyName[] {
  const definition = Object.values(SCOPE_DEFINITIONS).find((entry) => entry.role === role)
  if (!definition) return []
  const settings = new Set(Object.values<{ setting: string }>(definition.settings).map((entry) => entry.setting))
  return (Object.keys(POLICY_KEYS) as PolicyKeyName[]).filter((key) => settings.has(POLICY_KEYS[key].setting))
}
