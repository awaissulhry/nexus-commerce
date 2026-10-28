import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockSetConfigSql } from './policy-sql'
import { AuditedPool, auditRuntimeRole, UnsafeRuntimeLoginError, type RuntimeRoleAudit } from './runtime-role'
import { throwawayDatabase, type ThrowawayDatabase } from './testing/throwaway-database'

/**
 * The runtime-login audit on real PostgreSQL 17 (the local factory stack), ported from Commerce's
 * runtime-role-postgres.vitest.test.ts. Commerce owns a whole disposable server because roles are cluster-wide; here
 * the server is shared with other worktrees, so every role is a throwaway with a random name, and no test alters a
 * role it did not make.
 */
describe('auditRuntimeRole on real PostgreSQL', () => {
  let db: ThrowawayDatabase
  let runtime = ''
  let floor = ''
  let audit: RuntimeRoleAudit
  const clients: pg.Client[] = []
  const pools: pg.Pool[] = []
  const sql = (text: string) => db.admin.query(text)
  let logins = 0

  beforeAll(async () => {
    db = await throwawayDatabase('role')
    runtime = db.role('runtime')
    floor = db.role('floor')
    audit = { roles: [runtime, floor] }
    await sql(`
      CREATE ROLE ${runtime} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      CREATE ROLE ${floor} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${runtime}, ${floor};
      CREATE TABLE public."RuntimeRoleProbe" (id integer PRIMARY KEY, "tenantId" text NOT NULL, value text NOT NULL);
      INSERT INTO public."RuntimeRoleProbe" VALUES (1, 'tenant_a', 'A'), (2, 'tenant_b', 'B');
      ALTER TABLE public."RuntimeRoleProbe" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public."RuntimeRoleProbe" FORCE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public."RuntimeRoleProbe" TO ${runtime};
      CREATE POLICY tenant_scope ON public."RuntimeRoleProbe" TO ${runtime}
        USING ("tenantId" = NULLIF(current_setting('dbkit.tenant_id', true), ''))
        WITH CHECK ("tenantId" = NULLIF(current_setting('dbkit.tenant_id', true), ''));
    `)
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.end()))
    await Promise.allSettled(pools.map((pool) => pool.end()))
    await db?.close()
  }, 60_000)

  /** A login granted both runtime roles (by default WITH INHERIT TRUE, SET TRUE, Commerce's production shape). */
  async function login(options: { attribute?: string; membership?: boolean; inherit?: boolean } = {}) {
    const user = db.role(`login${++logins}`)
    await sql(`CREATE ROLE ${user} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
    if (options.attribute) await sql(`ALTER ROLE ${user} ${options.attribute}`)
    if (options.membership !== false) {
      await sql(`GRANT ${runtime}, ${floor} TO ${user} WITH INHERIT ${options.inherit === false ? 'FALSE' : 'TRUE'}, SET TRUE`)
    }
    const client = new pg.Client(db.config(user))
    await client.connect()
    clients.push(client)
    return { user, client }
  }

  /** The regression Commerce guards: after SET LOCAL ROLE, current_user looks safe, but the LOGIN is what counts. */
  async function auditAfterDownscope(client: pg.Client, options: RuntimeRoleAudit = audit) {
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL ROLE ${runtime}`)
      expect((await client.query('SELECT current_user::text AS role')).rows[0].role).toBe(runtime)
      await auditRuntimeRole(client, options)
    } finally {
      await client.query('ROLLBACK')
    }
  }

  it('accepts a restricted login and keeps ordinary scoped reads and writes', async () => {
    const { client } = await login()
    await expect(auditRuntimeRole(client, audit)).resolves.toBeUndefined()
    await expect(auditAfterDownscope(client)).resolves.toBeUndefined()
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${runtime}`)
    await client.query("SELECT set_config('dbkit.tenant_id', $1, true)", ['tenant_a'])
    expect((await client.query('SELECT value FROM public."RuntimeRoleProbe" ORDER BY id')).rows).toEqual([{ value: 'A' }])
    expect((await client.query('UPDATE public."RuntimeRoleProbe" SET value = $1 WHERE id = 2', ['foreign'])).rowCount).toBe(0)
    await client.query('ROLLBACK')
  })

  it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB', 'REPLICATION'])('refuses a %s login even after SET LOCAL ROLE', async (attribute) => {
    const { client } = await login({ attribute })
    await expect(auditAfterDownscope(client)).rejects.toThrow(/superuser, has BYPASSRLS/)
  })

  it('refuses a login that belongs to a predefined pg_* role (pg_read_all_data ignores grants)', async () => {
    const { client, user } = await login()
    await sql(`GRANT pg_read_all_data TO ${user}`)
    await expect(auditRuntimeRole(client, audit)).rejects.toThrow(/pg_\* role/)
  })

  it.each([
    ['table', 'owns an application table'],
    ['schema', 'owns an application schema'],
    ['function', 'owns an application function'],
    ['type', 'owns an application type'],
  ])('refuses a login that owns an application %s', async (kind, message) => {
    const { client, user } = await login()
    const object = `owned_${kind}_${logins}`
    if (kind === 'table') await sql(`CREATE TABLE public.${object} (id integer); ALTER TABLE public.${object} OWNER TO ${user}`)
    if (kind === 'schema') await sql(`CREATE SCHEMA ${object} AUTHORIZATION ${user}`)
    if (kind === 'function') await sql(`CREATE FUNCTION public.${object}() RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION public.${object}() OWNER TO ${user}`)
    if (kind === 'type') await sql(`CREATE TYPE public.${object} AS ENUM ('a', 'b'); ALTER TYPE public.${object} OWNER TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow(message)
  })

  it('refuses a SET-only membership in a privileged role (no inherited privileges needed to use it)', async () => {
    const { client, user } = await login()
    const privileged = db.role(`bypass${logins}`)
    await sql(`CREATE ROLE ${privileged} NOLOGIN BYPASSRLS; GRANT ${privileged} TO ${user} WITH INHERIT FALSE, SET TRUE`)
    await expect(auditAfterDownscope(client)).rejects.toThrow(UnsafeRuntimeLoginError)
  })

  it('refuses an administrative role reached through an intermediate NOINHERIT role', async () => {
    const { client, user } = await login()
    const intermediate = db.role(`middle${logins}`)
    const privileged = db.role(`admin${logins}`)
    await sql(`CREATE ROLE ${privileged} NOLOGIN CREATEROLE; CREATE ROLE ${intermediate} NOLOGIN NOINHERIT;
      GRANT ${privileged} TO ${intermediate}; GRANT ${intermediate} TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow(UnsafeRuntimeLoginError)
  })

  it('refuses membership in a role that owns a table, without any special attribute', async () => {
    const { client, user } = await login()
    const owner = db.role(`owner${logins}`)
    await sql(`CREATE ROLE ${owner} NOLOGIN; CREATE TABLE public.owner_probe_${logins} (id integer);
      ALTER TABLE public.owner_probe_${logins} OWNER TO ${owner}; GRANT ${owner} TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow('owns an application table')
  })

  it('refuses CREATE on an application schema', async () => {
    const { client, user } = await login()
    await sql(`GRANT CREATE ON SCHEMA public TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow('may CREATE in an application schema')
  })

  it('refuses CREATE on the database', async () => {
    const { client, user } = await login()
    await sql(`GRANT CREATE ON DATABASE "${db.name}" TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow('may CREATE in the database')
  })

  it('refuses TRUNCATE on an application table (TRUNCATE ignores row-level security)', async () => {
    const { client, user } = await login()
    await sql(`GRANT TRUNCATE ON public."RuntimeRoleProbe" TO ${user}`)
    await expect(auditAfterDownscope(client)).rejects.toThrow('TRUNCATE, REFERENCES or TRIGGER')
  })

  it('refuses a runtime membership WITH ADMIN OPTION', async () => {
    const { client, user } = await login()
    await sql(`GRANT ${runtime} TO ${user} WITH ADMIN OPTION`)
    await expect(auditAfterDownscope(client)).rejects.toThrow('WITH ADMIN OPTION')
  })

  it('refuses a login that is not a member of every runtime role', async () => {
    const { client, user } = await login({ membership: false })
    await sql(`GRANT ${runtime} TO ${user} WITH INHERIT TRUE, SET TRUE`)
    await expect(auditRuntimeRole(client, audit)).rejects.toThrow('not a member of every runtime role')
  })

  it('refuses a membership without SET (the adapter could not enter the role)', async () => {
    const { client, user } = await login({ membership: false })
    await sql(`GRANT ${runtime}, ${floor} TO ${user} WITH INHERIT TRUE, SET FALSE`)
    await expect(auditRuntimeRole(client, audit)).rejects.toThrow(`cannot enter ${runtime}`)
  })

  it('refuses a runtime role that does not exist', async () => {
    const { client } = await login()
    await expect(auditRuntimeRole(client, { roles: [runtime, db.role('missing')] })).rejects.toThrow('does not exist')
  })

  it('refuses an audit that names no role or a malformed one', async () => {
    const { client } = await login()
    await expect(auditRuntimeRole(client, { roles: [] })).rejects.toThrow(UnsafeRuntimeLoginError)
    await expect(auditRuntimeRole(client, { roles: ['Bad Role'] })).rejects.toThrow(UnsafeRuntimeLoginError)
  })

  it('checks the INHERIT shape when asked, both ways', async () => {
    const inheriting = await login()
    const strict = await login({ inherit: false })
    await expect(auditRuntimeRole(inheriting.client, { ...audit, inherit: true })).resolves.toBeUndefined()
    await expect(auditRuntimeRole(inheriting.client, { ...audit, inherit: false })).rejects.toThrow('WITH INHERIT FALSE')
    await expect(auditRuntimeRole(strict.client, { ...audit, inherit: false })).resolves.toBeUndefined()
    await expect(auditRuntimeRole(strict.client, { ...audit, inherit: true })).rejects.toThrow('WITH INHERIT TRUE')
    // The failure Commerce's check prevents: without SET ROLE, a non-inheriting login has no table access at all.
    await expect(strict.client.query('SELECT value FROM public."RuntimeRoleProbe"')).rejects.toThrow('permission denied')
  })

  it('an inheriting login that never sets the runtime role is still held by row-level security', async () => {
    const { client } = await login()
    expect((await client.query('SELECT value FROM public."RuntimeRoleProbe"')).rows).toEqual([])
    await client.query('BEGIN')
    await client.query("SELECT set_config('dbkit.tenant_id', $1, true)", ['tenant_b'])
    expect((await client.query('SELECT value FROM public."RuntimeRoleProbe"')).rows).toEqual([{ value: 'B' }])
    await client.query('ROLLBACK')
  })

  it('refuses a privileged runtime role even when the login itself is restricted', async () => {
    const { client } = await login()
    const risky = db.role(`riskyruntime${logins}`)
    await sql(`CREATE ROLE ${risky} NOLOGIN BYPASSRLS; GRANT ${risky} TO ${(await client.query('SELECT session_user::text AS u')).rows[0].u}`)
    await expect(auditRuntimeRole(client, { roles: [runtime, risky] })).rejects.toThrow(/BYPASSRLS/)
  })

  it('names every failed check at once', async () => {
    const { client, user } = await login({ attribute: 'CREATEDB' })
    await sql(`GRANT TRUNCATE ON public."RuntimeRoleProbe" TO ${user}`)
    const error = await auditRuntimeRole(client, audit).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnsafeRuntimeLoginError)
    expect((error as UnsafeRuntimeLoginError).failures).toEqual([
      'the login or a role it reaches is a superuser, has BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION, or is a pg_* role',
      'the login or a role it reaches holds TRUNCATE, REFERENCES or TRIGGER on an application table',
    ])
  })

  it('checks that set_config is locked when asked (lockSetConfigSql)', async () => {
    const { client, user } = await login()
    await expect(auditRuntimeRole(client, { ...audit, setConfigLocked: true })).rejects.toThrow(`${runtime} may execute set_config`)
    await sql(lockSetConfigSql([user], [runtime, floor]))
    try {
      await expect(auditRuntimeRole(client, { ...audit, setConfigLocked: true })).resolves.toBeUndefined()
    } finally {
      // Back to the default for the other tests of this database.
      await sql('GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC')
    }
  })

  describe('AuditedPool', () => {
    it('refuses an unsafe login in every borrow form, and destroys the connection', async () => {
      const { user } = await login({ attribute: 'BYPASSRLS' })
      const pool = new AuditedPool(db.config(user, { max: 1 }), audit)
      pools.push(pool)
      await expect(pool.connect()).rejects.toThrow('Unsafe database runtime login')
      await expect(
        new Promise<void>((resolve, reject) => {
          pool.connect((error, _client, release) => {
            if (error) return reject(error)
            release()
            resolve()
          })
        }),
      ).rejects.toThrow('Unsafe database runtime login')
      await expect(pool.query('SELECT 1')).rejects.toThrow('Unsafe database runtime login')
      await expect(
        new Promise((resolve, reject) => {
          pool.query('SELECT 1', (error, result) => (error ? reject(error) : resolve(result)))
        }),
      ).rejects.toThrow('Unsafe database runtime login')
      expect(pool.totalCount).toBe(0)
    })

    it('accepts a safe login in every borrow form and audits each connection once', async () => {
      const { user } = await login()
      const pool = new AuditedPool(db.config(user, { max: 1 }), audit)
      pools.push(pool)
      const original = pg.Client.prototype.query
      const texts: string[] = []
      pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
        const first = args[0] as { text?: string } | string
        texts.push(typeof first === 'string' ? first : (first?.text ?? '?'))
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      try {
        const connection = await pool.connect()
        connection.release()
        expect((await pool.query('SELECT 2 AS value')).rows).toEqual([{ value: 2 }])
        const rows = await new Promise((resolve, reject) => {
          pool.query('SELECT 3 AS value', (error, result) => (error ? reject(error) : resolve(result.rows)))
        })
        expect(rows).toEqual([{ value: 3 }])
      } finally {
        pg.Client.prototype.query = original
      }
      // One physical connection: the two audit queries ran once, before its first borrow.
      expect(texts.filter((text) => text.includes('WITH RECURSIVE reachable'))).toHaveLength(1)
      expect(texts.filter((text) => text.includes('pg_has_role'))).toHaveLength(1)
    })
  })
})
