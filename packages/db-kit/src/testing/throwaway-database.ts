import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { describeUrlHost, isLoopbackUrl } from '../url-guard'

/**
 * Test support (not exported by the package): a throwaway database `factory_test_dbkit_<label>_<hex>` on the local
 * factory PostgreSQL, and throwaway roles with a random prefix. Roles are cluster-wide and other worktrees share the
 * server, so a test never names a fixed role, never alters a role it did not create, and drops all of them.
 *
 * The server is FACTORY_DB_KIT_TEST_SERVER_URL (set in the shell, never read from a `.env`), else the local stack at
 * 127.0.0.1:5442. It must be loopback; anything else stops the test before it connects.
 */
const SERVER_URL = process.env.FACTORY_DB_KIT_TEST_SERVER_URL ?? 'postgresql://postgres@127.0.0.1:5442/postgres'

export interface ThrowawayDatabase {
  readonly name: string
  /** Connected to the throwaway database as the server's admin login. */
  readonly admin: pg.Client
  /** A new role name, unique on the server, dropped by `close()`. */
  role(label: string): string
  /** pg connection settings for a login on the throwaway database. */
  config(user: string, extra?: pg.PoolConfig): pg.PoolConfig
  /** Drops the database (forcing out any connection left open) and then every role made through `role()`. */
  close(): Promise<void>
}

function serverUrl(): URL {
  if (!isLoopbackUrl(SERVER_URL)) {
    throw new Error(`db-kit tests refused to start: ${describeUrlHost(SERVER_URL)} is not a database on this machine (loopback only).`)
  }
  return new URL(SERVER_URL)
}

export async function throwawayDatabase(label: string): Promise<ThrowawayDatabase> {
  const server = serverUrl()
  const id = randomBytes(4).toString('hex')
  const name = `factory_test_dbkit_${label}_${id}`
  if (!/^factory_test_[a-z0-9_]+$/.test(name)) throw new Error(`Bad throwaway database name: ${name}`)
  const roles: string[] = []
  const root = new pg.Client({ connectionString: server.href })
  await root.connect()
  await root.query(`CREATE DATABASE "${name}"`)
  const at = (user: string): URL => {
    const url = new URL(server.href)
    url.username = user
    url.password = ''
    url.pathname = `/${name}`
    return url
  }
  const admin = new pg.Client({ connectionString: at(decodeURIComponent(server.username) || 'postgres').href })
  try {
    await admin.connect()
  } catch (error) {
    await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await root.end()
    throw error
  }
  return {
    name,
    admin,
    role(roleLabel: string): string {
      const role = `dbkit_${id}_${roleLabel}`
      if (!/^[a-z0-9_]{1,63}$/.test(role)) throw new Error(`Bad throwaway role name: ${role}`)
      roles.push(role)
      return role
    },
    config: (user, extra = {}) => ({ connectionString: at(user).href, connectionTimeoutMillis: 5_000, ...extra }),
    async close(): Promise<void> {
      try {
        await admin.end().catch(() => {})
        await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        for (const role of [...roles].reverse()) await root.query(`DROP ROLE IF EXISTS "${role}"`)
      } finally {
        await root.end()
      }
    },
  }
}
