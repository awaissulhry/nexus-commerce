import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { scopeForContext, SYSTEM_ACTOR_ID, type SystemContext } from '../../core/context'

/**
 * The worker's and scheduler's way into the database (plan A1 §2.2: "factory_runtime — office sessions, worker,
 * scheduler"). There is no cross-tenant role: a job lists the active tenants in the platform scope, then works on ONE
 * tenant per transaction in that tenant's system context (the office role factory_runtime with the tenant setting), so
 * row-level security stays forced for background work exactly as for a request.
 */

/** The system context of one tenant: the worker or scheduler acting for it. */
export function systemContext(tenantId: string, requestId: string): SystemContext {
  return Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
}

/** The ids of the active tenants, in id order (the platform scope reads only the Tenant table). */
export async function activeTenants(database: FactoryDatabase): Promise<string[]> {
  const rows = await database.withScope({ audience: 'platform' }, (client) =>
    client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } }),
  )
  return rows.map((row) => row.id)
}

/** Runs `work` with the client of the tenant's system scope. */
export function asSystem<T>(database: FactoryDatabase, tenantId: string, requestId: string, work: (client: FactoryClient) => Promise<T>): Promise<T> {
  return database.withScope(scopeForContext(systemContext(tenantId, requestId)), work)
}
