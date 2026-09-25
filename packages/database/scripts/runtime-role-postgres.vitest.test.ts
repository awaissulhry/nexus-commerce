import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { auditRuntimeRole, RuntimePool } from '../runtime-role.ts'

/**
 * This suite owns an entire disposable local PostgreSQL server: roles are cluster-wide,
 * so testing hostile memberships against a developer's existing server is unsafe.
 * It reads no database URL or .env file and never downloads an image. Docker and the
 * local postgres:17-alpine image are required; missing infrastructure is a failure.
 */
describe('runtime login privileges on real PostgreSQL', () => {
  const container = `nexus-runtime-role-${process.pid}-${randomBytes(4).toString('hex')}`
  let started = false
  let port = 0
  let admin: Client | undefined

  const docker = (...args: string[]) => execFileSync('docker', args, {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const name = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`
  const sql = (text: string) => admin!.query(text)

  beforeAll(async () => {
    docker('image', 'inspect', 'postgres:17-alpine')
    docker('run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data', 'postgres:17-alpine')
    started = true
    port = Number(docker('port', container, '5432/tcp').split('\n')[0].split(':').pop())
    if (!Number.isInteger(port) || port < 1) throw new Error('Disposable PostgreSQL has no loopback port')
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 500 })
      try { await candidate.connect(); admin = candidate; break }
      catch (error) {
        await candidate.end()
        if (attempt === 99) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await sql(`
      CREATE ROLE nexus_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO nexus_workspace_runtime;
      CREATE TABLE public."RuntimeRoleProbe" (id integer PRIMARY KEY, "workspaceId" text NOT NULL, value text NOT NULL);
      INSERT INTO public."RuntimeRoleProbe" VALUES (1, 'business_a', 'A'), (2, 'business_b', 'B');
      ALTER TABLE public."RuntimeRoleProbe" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public."RuntimeRoleProbe" FORCE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public."RuntimeRoleProbe" TO nexus_workspace_runtime;
      CREATE POLICY workspace_scope ON public."RuntimeRoleProbe" TO nexus_workspace_runtime
        USING ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''))
        WITH CHECK ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''));
    `)
  }, 60_000)

  afterAll(async () => {
    try { await admin?.end() }
    finally { if (started) docker('stop', container) }
  }, 40_000)

  async function login(options: { attribute?: string; runtimeMembership?: boolean } = {}) {
    const user = name('runtime_login')
    await sql(`CREATE ROLE ${user} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
    if (options.attribute) await sql(`ALTER ROLE ${user} ${options.attribute}`)
    if (options.runtimeMembership !== false) await sql(`GRANT nexus_workspace_runtime TO ${user}`)
    const client = new Client({ host: '127.0.0.1', port, user, database: 'postgres', connectionTimeoutMillis: 2_000 })
    await client.connect()
    return { user, client }
  }

  // An already-downscoped connection is the regression: current_user looks safe
  // although RESET ROLE can restore the original privileged session_user.
  async function auditAfterDownscope(client: Client) {
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL ROLE nexus_workspace_runtime')
      expect((await client.query('SELECT current_user::text AS role')).rows[0].role).toBe('nexus_workspace_runtime')
      await auditRuntimeRole(client)
    } finally { await client.query('ROLLBACK') }
  }

  it('accepts a restricted login and preserves ordinary scoped reads and writes', async () => {
    const { client } = await login()
    try {
      await expect(auditRuntimeRole(client)).resolves.toBeUndefined()
      await expect(auditAfterDownscope(client)).resolves.toBeUndefined()
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE nexus_workspace_runtime')
      await client.query("SELECT set_config('nexus.workspace_id', $1, true)", ['business_a'])
      expect((await client.query('SELECT value FROM public."RuntimeRoleProbe" ORDER BY id')).rows).toEqual([{ value: 'A' }])
      expect((await client.query('UPDATE public."RuntimeRoleProbe" SET value = $1 WHERE id = 1', ['changed'])).rowCount).toBe(1)
      expect((await client.query('UPDATE public."RuntimeRoleProbe" SET value = $1 WHERE id = 2', ['foreign'])).rowCount).toBe(0)
      await client.query('ROLLBACK')
      expect((await client.query('SELECT session_user::text AS login, current_user::text AS role')).rows[0].login)
        .toBe((await client.query('SELECT current_user::text AS role')).rows[0].role)
      expect((await client.query("SELECT NULLIF(current_setting('nexus.workspace_id', true), '') AS workspace")).rows[0].workspace).toBeNull()
      expect((await sql('SELECT value FROM public."RuntimeRoleProbe" ORDER BY id')).rows).toEqual([{ value: 'A' }, { value: 'B' }])
    } finally { await client.end() }
  })

  it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB', 'REPLICATION'])
    ('rejects a %s session even after SET LOCAL ROLE', async attribute => {
      const { client } = await login({ attribute })
      try { await expect(auditAfterDownscope(client)).rejects.toThrow() }
      finally { await client.end() }
    })

  it.each(['table', 'schema', 'function'])('rejects a login owning an application %s', async kind => {
    const { client, user } = await login()
    const object = name(`owned_${kind}`)
    try {
      if (kind === 'table') await sql(`CREATE TABLE public.${object} (id integer); ALTER TABLE public.${object} OWNER TO ${user}`)
      if (kind === 'schema') await sql(`CREATE SCHEMA ${object} AUTHORIZATION ${user}`)
      if (kind === 'function') await sql(`CREATE FUNCTION public.${object}() RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION public.${object}() OWNER TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects direct access to a privileged role even with NOINHERIT', async () => {
    const { client, user } = await login()
    const privileged = name('bypass_role')
    try {
      await sql(`CREATE ROLE ${privileged} NOLOGIN BYPASSRLS; GRANT ${privileged} TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects an indirect administrative membership reached through another NOINHERIT role', async () => {
    const { client, user } = await login()
    const intermediate = name('intermediate_role'), privileged = name('admin_role')
    try {
      await sql(`CREATE ROLE ${privileged} NOLOGIN CREATEROLE; CREATE ROLE ${intermediate} NOLOGIN NOINHERIT;
        GRANT ${privileged} TO ${intermediate}; GRANT ${intermediate} TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects membership in a table-owning role without special role attributes', async () => {
    const { client, user } = await login()
    const owner = name('table_owner'), table = name('owner_probe')
    try {
      await sql(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE TABLE public.${table} (id integer); ALTER TABLE public.${table} OWNER TO ${owner}; GRANT ${owner} TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects schema CREATE authority which would allow installing application functions', async () => {
    const { client, user } = await login()
    try {
      await sql(`GRANT CREATE ON SCHEMA public TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects database CREATE authority even without ownership or role creation attributes', async () => {
    const { client, user } = await login()
    try {
      await sql(`GRANT CREATE ON DATABASE postgres TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects TRUNCATE authority on an application table because it is not constrained by RLS', async () => {
    const { client, user } = await login()
    try {
      await sql(`GRANT TRUNCATE ON public."RuntimeRoleProbe" TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects ownership of an application enum type', async () => {
    const { client, user } = await login()
    const type = name('application_status')
    try {
      await sql(`CREATE TYPE public.${type} AS ENUM ('active', 'archived'); ALTER TYPE public.${type} OWNER TO ${user}`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects ADMIN OPTION on runtime membership which permits granting its authority to other roles', async () => {
    const { client, user } = await login()
    try {
      await sql(`GRANT nexus_workspace_runtime TO ${user} WITH ADMIN OPTION`)
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally { await client.end() }
  })

  it('rejects a login that cannot enter the required runtime role', async () => {
    const { client } = await login({ runtimeMembership: false })
    try { await expect(auditRuntimeRole(client)).rejects.toThrow() }
    finally { await client.end() }
  })

  it('rejects a privileged runtime role even when the login itself is restricted', async () => {
    const { client } = await login()
    try {
      await sql('ALTER ROLE nexus_workspace_runtime BYPASSRLS')
      await expect(auditAfterDownscope(client)).rejects.toThrow()
    } finally {
      await sql('ALTER ROLE nexus_workspace_runtime NOBYPASSRLS')
      await client.end()
    }
  })

  it('enforces the pool boundary for unsafe connect and query calls in both API forms', async () => {
    vi.stubEnv('NEXUS_ENFORCE_RUNTIME_ROLE', '1')
    const { user, client } = await login({ attribute: 'BYPASSRLS' })
    await client.end()
    const pool = new RuntimePool({ host: '127.0.0.1', port, user, database: 'postgres', max: 1, connectionTimeoutMillis: 2_000 })
    try {
      await expect(pool.connect()).rejects.toThrow('Unsafe database runtime login')
      await expect(new Promise<void>((resolve, reject) => {
        pool.connect((error, connection, release) => {
          if (error) { reject(error); return }
          release()
          resolve()
        })
      })).rejects.toThrow('Unsafe database runtime login')
      await expect(pool.query('SELECT 1')).rejects.toThrow('Unsafe database runtime login')
      await expect(new Promise((resolve, reject) => {
        pool.query('SELECT 1', (error, result) => error ? reject(error) : resolve(result))
      })).rejects.toThrow('Unsafe database runtime login')
    } finally {
      await pool.end()
      vi.unstubAllEnvs()
    }
  })

  it('accepts restricted pool connect and query calls in both API forms', async () => {
    vi.stubEnv('NEXUS_ENFORCE_RUNTIME_ROLE', '1')
    const { user, client } = await login()
    await client.end()
    const pool = new RuntimePool({ host: '127.0.0.1', port, user, database: 'postgres', max: 1, connectionTimeoutMillis: 2_000 })
    try {
      const connection = await pool.connect()
      try {
        await connection.query('BEGIN')
        await connection.query('SET LOCAL ROLE nexus_workspace_runtime')
        await connection.query("SELECT set_config('nexus.workspace_id', $1, true)", ['business_a'])
        expect((await connection.query('SELECT value FROM public."RuntimeRoleProbe"')).rows).toEqual([{ value: 'A' }])
      } finally {
        await connection.query('ROLLBACK')
        connection.release()
      }
      await new Promise<void>((resolve, reject) => {
        pool.connect((error, borrowed, release) => {
          if (error) { reject(error); return }
          borrowed!.query('SELECT 1 AS value', (queryError, result) => {
            release()
            if (queryError) { reject(queryError); return }
            try { expect(result.rows).toEqual([{ value: 1 }]); resolve() }
            catch (assertionError) { reject(assertionError) }
          })
        })
      })
      expect((await pool.query('SELECT 2 AS value')).rows).toEqual([{ value: 2 }])
      const result = await new Promise((resolve, reject) => {
        pool.query('SELECT 3 AS value', (error, rows) => error ? reject(error) : resolve(rows.rows))
      })
      expect(result).toEqual([{ value: 3 }])
    } finally {
      await pool.end()
      vi.unstubAllEnvs()
    }
  })

  it('enforces production connections even when the opt-in flag is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXUS_ENFORCE_RUNTIME_ROLE', undefined)
    const { user, client } = await login({ attribute: 'CREATEROLE' })
    await client.end()
    const pool = new RuntimePool({ host: '127.0.0.1', port, user, database: 'postgres', max: 1, connectionTimeoutMillis: 2_000 })
    try { await expect(pool.query('SELECT 1')).rejects.toThrow('Unsafe database runtime login') }
    finally {
      await pool.end()
      vi.unstubAllEnvs()
    }
  })
})
