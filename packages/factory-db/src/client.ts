import {
  AuditedPool,
  makeScope,
  TenantPg,
  TenantScopeError,
  type RuntimeRoleAudit,
  type ScopeDefinition,
  type ScopeValues,
} from '@nexus/db-kit'
import type { Pool, PoolConfig } from 'pg'
import { PrismaClient } from './generated/prisma/client'
import { RUNTIME_ROLES, SCOPE_DEFINITIONS, type Audience } from './roles'

/**
 * The factory's database client: one shared pg pool for the runtime login, audited per connection, and one Prisma
 * client per scope on top of it, each behind db-kit's fail-closed TenantPg adapter.
 *
 * Why one client per scope: Prisma batches some reads of one client into one statement, so a client that switched
 * scope per query could answer one tenant's read with another's rows. A client is made for a scope the first time it
 * is used and kept; at most `clientCapacity` clients live at once, and the least recently used idle one is closed to
 * make room (a busy one never is: a lease waits instead).
 *
 * What a client costs (B-W2b-F9, measured with Prisma 7.10): about 86 MB of heap and 95 ms the moment it is made,
 * before any query — Prisma's engine decodes the generated parameterization graph into objects of its own for every
 * client, with no supported way to share them — plus 10-25 MB of query-compiler memory at its first query. So the
 * cache is keyed by exactly what the database walls read, the role and its settings (tenant; site; party), and never
 * by the actor: every actor of one tenant (site, party) shares one client, which is safe because their statements run
 * with the same role and settings. Two tenants, sites or parties never share one.
 *
 * Use a client only inside the `withScope` callback that lent it.
 */

export type FactoryClient = PrismaClient

/**
 * A database scope. `actorId` names who acts and is required wherever a person or a link acts, but it is not sent to
 * the database and does not choose the client (no policy or guard reads it, see roles.ts).
 */
export type FactoryScope =
  | { readonly audience: 'office'; readonly tenantId: string; readonly actorId: string }
  | { readonly audience: 'floor'; readonly tenantId: string; readonly actorId: string; readonly siteId: string }
  | { readonly audience: 'partner'; readonly tenantId: string; readonly actorId: string; readonly partyId: string }
  | { readonly audience: 'platform' }

/** What the runtime login must look like (db-kit's auditRuntimeRole): checked once per physical connection. */
export const RUNTIME_LOGIN_AUDIT: RuntimeRoleAudit = { roles: RUNTIME_ROLES, inherit: false, setConfigLocked: true }

export interface FactoryDatabaseOptions {
  /** The runtime login's URL (`factory_app`), never the owner's. The caller's env loader checks the host. */
  readonly connectionString: string
  /** Other pg pool settings (size, timeouts). */
  readonly pool?: Omit<PoolConfig, 'connectionString'>
  /** Most Prisma clients kept at once, one per role and settings. Default DEFAULT_CLIENT_CAPACITY. */
  readonly clientCapacity?: number
}

/**
 * The default number of clients kept: 16 × about 90 MB of heap (plus 10-25 MB each outside it) stays well under the
 * default ~4 GB heap. One tenant with a few sites and the parties signed in to the portal needs fewer.
 */
export const DEFAULT_CLIENT_CAPACITY = 16

export interface FactoryDatabase {
  /** Runs `work` with the client of this scope. The scope is checked first; a missing tenant, site or party throws. */
  withScope<T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T>
  /** Closes every client and the pool. */
  close(): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_KEYS = new Set(['tenantId', 'siteId', 'partyId'])
/** The audiences whose scope names an actor; the platform scope names none. */
const ACTOR_AUDIENCES: ReadonlySet<Audience> = new Set(['office', 'floor', 'partner'])

/**
 * The scope as db-kit values, checked: only the audience's keys, ids are UUIDs (the policies cast them), an actor
 * wherever one acts. The actor is checked and then left out: it is not a database setting.
 */
function scopeValues(scope: FactoryScope): { audience: Audience; values: ScopeValues } {
  if (scope === null || typeof scope !== 'object' || !Object.hasOwn(SCOPE_DEFINITIONS, scope.audience)) {
    throw new TenantScopeError('scope_required', 'A database scope with an audience (office, floor, partner, platform) is required.')
  }
  const { audience, ...rest } = scope as FactoryScope & Record<string, unknown>
  let values: Record<string, unknown> = rest
  if (ACTOR_AUDIENCES.has(audience)) {
    const { actorId, ...settings } = rest
    if (actorId === undefined || actorId === null || actorId === '') throw new TenantScopeError('scope_required', 'The database scope needs actorId.')
    if (typeof actorId !== 'string') throw new TenantScopeError('scope_invalid', 'Scope value actorId must be a string.')
    values = settings
  }
  for (const [key, value] of Object.entries(values)) {
    if (UUID_KEYS.has(key) && typeof value === 'string' && value !== '' && !UUID.test(value)) {
      throw new TenantScopeError('scope_invalid', `Scope value ${key} must be a UUID.`)
    }
  }
  return { audience, values: values as ScopeValues }
}

/** A scope's definition, values and cache key, checked by makeScope (required values, unknown keys) before anything else. */
function resolveScope(scope: FactoryScope): { definition: ScopeDefinition; values: ScopeValues; key: string } {
  const { audience, values } = scopeValues(scope)
  const definition = SCOPE_DEFINITIONS[audience]
  // The role and every setting its statements carry (TenantPg makes the same scope): exactly what the SQL can read.
  return { definition, values, key: JSON.stringify(makeScope(definition, values)) }
}

/** The key that chooses a scope's client: its role and settings, never the actor. Exported for tests. */
export const clientKey = (scope: FactoryScope): string => resolveScope(scope).key

interface Entry {
  readonly client: FactoryClient
  active: number
  used: number
}

/** The per-scope cache over an existing pool (the pool's owner closes it). Exported for tests; use openFactoryDatabase. */
export function scopedClients(pool: Pool, clientCapacity = DEFAULT_CLIENT_CAPACITY): FactoryDatabase {
  if (!Number.isInteger(clientCapacity) || clientCapacity < 1) throw new Error('clientCapacity must be a positive integer.')
  const entries = new Map<string, Entry>()
  const waiting = new Set<() => void>()
  let closed = false
  // Each Prisma client adds one error listener to the shared pool (removed when it disconnects).
  if (pool.getMaxListeners() !== 0) pool.setMaxListeners(Math.max(pool.getMaxListeners(), clientCapacity + 10))

  const wake = (): void => {
    const pending = [...waiting]
    waiting.clear()
    for (const resume of pending) resume()
  }

  async function acquire(scope: FactoryScope): Promise<Entry> {
    const { definition, values, key } = resolveScope(scope)
    for (;;) {
      if (closed) throw new TenantScopeError('scope_closed', 'The factory database is closed.')
      const found = entries.get(key)
      if (found) {
        found.active++
        found.used = Date.now()
        return found
      }
      if (entries.size < clientCapacity) {
        const entry: Entry = { client: new PrismaClient({ adapter: new TenantPg(pool, definition, values) }), active: 1, used: Date.now() }
        entries.set(key, entry)
        return entry
      }
      const idle = [...entries].filter(([, entry]) => entry.active === 0).sort((a, b) => a[1].used - b[1].used)[0]
      if (idle) {
        entries.delete(idle[0])
        await idle[1].client.$disconnect()
      } else {
        await new Promise<void>((resolve) => waiting.add(resolve))
      }
    }
  }

  return {
    async withScope(scope, work) {
      const entry = await acquire(scope)
      try {
        return await work(entry.client)
      } finally {
        entry.active--
        entry.used = Date.now()
        wake()
      }
    },
    async close() {
      closed = true
      wake()
      const clients = [...entries.values()].map((entry) => entry.client)
      entries.clear()
      await Promise.allSettled(clients.map((client) => client.$disconnect()))
    },
  }
}

/**
 * Opens the factory database: an audited pool for the runtime login and the per-scope clients. The first connection is
 * made and audited here, so an unsafe login (superuser, BYPASSRLS, an owner, a login that inherits a runtime role, an
 * unlocked set_config …) stops the process at boot with every failed check listed.
 */
export async function openFactoryDatabase(options: FactoryDatabaseOptions): Promise<FactoryDatabase> {
  const pool = new AuditedPool({ ...options.pool, connectionString: options.connectionString }, RUNTIME_LOGIN_AUDIT)
  try {
    const connection = await pool.connect()
    connection.release()
  } catch (error) {
    await pool.end().catch(() => {})
    throw error
  }
  const clients = scopedClients(pool, options.clientCapacity)
  return {
    withScope: (scope, work) => clients.withScope(scope, work),
    async close() {
      await clients.close()
      await pool.end()
    },
  }
}
