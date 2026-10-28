import { PrismaClient } from '@prisma/client'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditedPool } from './runtime-role'
import { TenantScopeError, type ScopeDefinition } from './scope'
import { TenantPg } from './tenant-adapter'
import { throwawayDatabase, type ThrowawayDatabase } from './testing/throwaway-database'

/**
 * The tenant adapter on real PostgreSQL 17 (the local factory stack) through a real Prisma 7 client, ported from
 * Commerce's workspace-adapter-postgres.vitest.test.ts plus the fail-closed cases. The client is the repository's
 * default generated `@prisma/client`; these tests use only raw SQL and transactions, so its models never matter.
 */
describe('TenantPg on real PostgreSQL', () => {
  let db: ThrowawayDatabase
  let runtime = ''
  let login = ''
  let outsider = ''
  let office: ScopeDefinition<'tenantId' | 'actorId' | 'siteId'>
  const pools: pg.Pool[] = []
  const clients: PrismaClient[] = []

  type Seen = { login: string; role: string; tenant: string | null; actor: string | null; site: string | null }
  const WHO = `SELECT session_user::text AS login, current_user::text AS role,
    NULLIF(current_setting('dbkit.tenant_id', true), '') AS tenant, NULLIF(current_setting('dbkit.actor_id', true), '') AS actor,
    NULLIF(current_setting('dbkit.site_id', true), '') AS site`
  const pool = (user = login, max = 1): pg.Pool => {
    const created = new pg.Pool(db.config(user, { max }))
    pools.push(created)
    return created
  }
  const prisma = (adapter: TenantPg): PrismaClient => {
    const client = new PrismaClient({ adapter, log: [] })
    clients.push(client)
    return client
  }
  const scoped = (p: pg.Pool, tenantId: string, actorId = 'user_1', siteId?: string): PrismaClient =>
    prisma(new TenantPg(p, office, { tenantId, actorId, ...(siteId ? { siteId } : {}) }))
  const count = async (value: string): Promise<number> =>
    (await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM public."AdapterProbe" WHERE value = $1', [value])).rows[0]!.n

  /** What the pg driver sends: one `Client.query` call is one round trip. */
  async function sent<T>(work: () => Promise<T>): Promise<{ value: T; texts: string[] }> {
    const original = pg.Client.prototype.query
    const texts: string[] = []
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as { text?: string } | string
      texts.push(typeof first === 'string' ? first : (first?.text ?? '?'))
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof original
    try {
      return { value: await work(), texts }
    } finally {
      pg.Client.prototype.query = original
    }
  }

  beforeAll(async () => {
    db = await throwawayDatabase('adapter')
    runtime = db.role('runtime')
    login = db.role('login')
    outsider = db.role('outsider')
    office = {
      role: runtime,
      settings: {
        tenantId: { setting: 'dbkit.tenant_id', required: true },
        actorId: { setting: 'dbkit.actor_id', required: true },
        siteId: { setting: 'dbkit.site_id', required: false },
      },
    }
    await db.admin.query(`
      CREATE ROLE ${runtime} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      GRANT ${runtime} TO ${login} WITH INHERIT FALSE, SET TRUE;
      CREATE ROLE ${outsider} LOGIN NOSUPERUSER NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${runtime}, ${outsider};
      CREATE TABLE public."AdapterProbe" (id serial PRIMARY KEY, "tenantId" text NOT NULL, value text NOT NULL UNIQUE);
      INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ('tenant_a', 'A'), ('tenant_b', 'B');
      ALTER TABLE public."AdapterProbe" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public."AdapterProbe" FORCE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public."AdapterProbe" TO ${runtime}, ${outsider};
      GRANT USAGE ON SEQUENCE public."AdapterProbe_id_seq" TO ${runtime}, ${outsider};
      CREATE POLICY tenant_scope ON public."AdapterProbe" TO ${runtime}
        USING ("tenantId" = NULLIF(current_setting('dbkit.tenant_id', true), ''))
        WITH CHECK ("tenantId" = NULLIF(current_setting('dbkit.tenant_id', true), ''));
      CREATE POLICY outsider_everything ON public."AdapterProbe" TO ${outsider} USING (true) WITH CHECK (true);
    `)
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.$disconnect()))
    await Promise.allSettled(pools.map((p) => p.end()))
    await db?.close()
  }, 60_000)

  it('runs a statement outside a transaction as the runtime role with its settings, in its own transaction', async () => {
    const client = scoped(pool(), 'tenant_a', 'user_1', 'site_1')
    const { value, texts } = await sent(() => client.$queryRawUnsafe<Seen[]>(WHO))
    expect(value).toEqual([{ login, role: runtime, tenant: 'tenant_a', actor: 'user_1', site: 'site_1' }])
    // BEGIN, the ONE scope statement (role and every setting), the statement, COMMIT.
    expect(texts.map((text) => text.split(/\s/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT'])
    expect(texts[1]).toBe('SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true)')
  })

  it('ends the scope with the statement: the next borrower of the same connection sees the plain login', async () => {
    const shared = pool()
    expect(await scoped(shared, 'tenant_a').$queryRawUnsafe<Seen[]>(WHO)).toEqual([
      { login, role: runtime, tenant: 'tenant_a', actor: 'user_1', site: null },
    ])
    // max 1: this is the very connection the scoped statement ran on.
    expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, tenant: null, actor: null, site: null }])
    expect((await shared.query<{ idle: boolean }>('SELECT now() = statement_timestamp() AS idle')).rows[0]!.idle).toBe(true)
  })

  it('binds the values: a value that looks like SQL is only a value', async () => {
    const client = scoped(pool(), "tenant_a'; SET ROLE postgres; --")
    expect(await client.$queryRawUnsafe('SELECT value FROM public."AdapterProbe"')).toEqual([])
    expect((await client.$queryRawUnsafe<Seen[]>(WHO))[0]!.tenant).toBe("tenant_a'; SET ROLE postgres; --")
  })

  it('applies row-level security to reads and writes, and commits a write before it returns', async () => {
    const a = scoped(pool(), 'tenant_a')
    expect(await a.$queryRawUnsafe('SELECT value FROM public."AdapterProbe" ORDER BY id')).toEqual([{ value: 'A' }])
    expect(await a.$executeRawUnsafe('UPDATE public."AdapterProbe" SET value = value WHERE "tenantId" = $1', 'tenant_b')).toBe(0)
    await expect(a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_b', 'forged')).rejects.toThrow(
      /row-level security/,
    )
    expect(await a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_a', 'A2')).toBe(1)
    expect(await count('A2')).toBe(1)
    expect(await count('forged')).toBe(0)
    await db.admin.query('DELETE FROM public."AdapterProbe" WHERE value = $1', ['A2'])
  })

  it('a failing statement rolls back alone and leaves the connection clean and usable', async () => {
    const shared = pool()
    const a = scoped(shared, 'tenant_a')
    const backend = async () => (await shared.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const before = await backend()
    await expect(a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_a', 'A')).rejects.toThrow()
    await expect(a.$queryRawUnsafe('SELECT 1 / (SELECT count(*) FROM public."AdapterProbe" WHERE false)')).rejects.toThrow()
    expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, tenant: null, actor: null, site: null }])
    expect(await a.$queryRawUnsafe<Seen[]>(WHO)).toEqual([{ login, role: runtime, tenant: 'tenant_a', actor: 'user_1', site: null }])
    expect(await backend()).toBe(before)
  })

  it('never runs a statement unscoped: when the scope statement fails, the statement does not run', async () => {
    // The outsider may not enter the runtime role, and its own policy would let the insert through.
    const outside = pool(outsider)
    const client = scoped(outside, 'tenant_a')
    await expect(
      client.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_b', 'unscoped'),
    ).rejects.toThrow(/permission denied to set role/)
    await expect(client.$transaction(async (tx) => tx.$executeRawUnsafe('DELETE FROM public."AdapterProbe"'))).rejects.toThrow(
      /permission denied to set role/,
    )
    expect(await count('unscoped')).toBe(0)
    expect(await count('A')).toBe(1)
    expect((await outside.query<{ role: string; open: boolean }>('SELECT current_user::text AS role, now() = statement_timestamp() AS open')).rows).toEqual([
      { role: outsider, open: true },
    ])
  })

  it('keeps concurrent tenants apart on shared connections', async () => {
    const shared = pool(login, 2)
    const a = scoped(shared, 'tenant_a', 'user_a')
    const b = scoped(shared, 'tenant_b', 'user_b')
    const reads = Array.from({ length: 60 }, (_, i) =>
      (i % 2 ? b : a)
        .$queryRawUnsafe<Array<Seen & { value: string }>>(`SELECT w.*, (SELECT string_agg(value, ',') FROM public."AdapterProbe") AS value FROM (${WHO}) w`)
        .then((rows) => [i % 2 ? 'b' : 'a', rows[0]] as const),
    )
    for (const [who, row] of await Promise.all(reads)) {
      expect(row).toEqual(
        who === 'a'
          ? { login, role: runtime, tenant: 'tenant_a', actor: 'user_a', site: null, value: 'A' }
          : { login, role: runtime, tenant: 'tenant_b', actor: 'user_b', site: null, value: 'B' },
      )
    }
  })

  it('scopes an interactive transaction with ONE statement after BEGIN, and the scope ends at COMMIT', async () => {
    const shared = pool()
    const client = scoped(shared, 'tenant_b', 'user_b')
    const { value, texts } = await sent(() =>
      client.$transaction(
        async (tx) => ({
          first: await tx.$queryRawUnsafe<Seen[]>(WHO),
          rows: await tx.$queryRawUnsafe('SELECT value FROM public."AdapterProbe" ORDER BY id'),
        }),
        { isolationLevel: 'Serializable' },
      ),
    )
    expect(value).toEqual({ first: [{ login, role: runtime, tenant: 'tenant_b', actor: 'user_b', site: null }], rows: [{ value: 'B' }] })
    expect(texts.map((text) => text.split(/\s/)[0])).toEqual(['BEGIN', 'SET', 'SELECT', 'SELECT', 'SELECT', 'COMMIT'])
    expect(texts[2]).toContain('set_config($1, $2, true)')
    expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, tenant: null, actor: null, site: null }])
  })

  it('scopes a batch transaction and rolls the whole batch back when one statement fails', async () => {
    const client = scoped(pool(), 'tenant_a')
    await expect(
      client.$transaction([
        client.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_a', 'batch_1'),
        client.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_b', 'batch_2'),
      ]),
    ).rejects.toThrow(/row-level security/)
    expect(await count('batch_1')).toBe(0)
    const [rows] = await client.$transaction([client.$queryRawUnsafe<Seen[]>(WHO)])
    expect(rows).toEqual([{ login, role: runtime, tenant: 'tenant_a', actor: 'user_1', site: null }])
  })

  describe('refuses SQL that could change or escape the scope, before it reaches the server', () => {
    it.each([
      ["set_config of a scope setting", "SELECT set_config('dbkit.tenant_id', 'tenant_b', true)"],
      ['SET ROLE', 'SET ROLE postgres'],
      ['SET LOCAL of a scope setting', "SET LOCAL dbkit.tenant_id = 'tenant_b'"],
      ['RESET', 'RESET ROLE'],
      ['a second statement', "SELECT 1; SELECT set_config('dbkit.tenant_id', 'tenant_b', false)"],
      ['a query run from a string', "SELECT query_to_xml('SELECT set_config(''dbkit.tenant_id'', ''tenant_b'', true)', true, true, '')"],
      ['BEGIN outside a transaction', 'BEGIN'],
      ['COMMIT outside a transaction', 'COMMIT'],
    ])('%s', async (_label, sql) => {
      const client = scoped(pool(), 'tenant_a')
      const { value, texts } = await sent(() => client.$executeRawUnsafe(sql).catch((error: unknown) => error))
      expect(String(value)).toMatch(/Statement refused by the tenant scope/)
      expect(texts).toEqual([])
    })

    it('inside an interactive transaction too, and the transaction rolls back', async () => {
      const client = scoped(pool(), 'tenant_a')
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_a', 'tx_refused')
          await tx.$executeRawUnsafe("SELECT set_config('dbkit.tenant_id', 'tenant_b', true)")
        }),
      ).rejects.toThrow(/Statement refused by the tenant scope/)
      expect(await count('tx_refused')).toBe(0)
    })

    it('after a raw COMMIT inside a transaction, nothing else runs on it', async () => {
      const shared = pool()
      const client = scoped(shared, 'tenant_a')
      await expect(
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('COMMIT')
          // Without the tripwire this would run outside any transaction, as the plain login.
          await tx.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("tenantId", value) VALUES ($1, $2)', 'tenant_a', 'after_commit')
        }),
      ).rejects.toThrow(/already ended/)
      expect(await count('after_commit')).toBe(0)
      expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, tenant: null, actor: null, site: null }])
    })
  })

  it('does not run scripts (migrations go through the owner login)', async () => {
    const adapter = await new TenantPg(pool(), office, { tenantId: 'tenant_a', actorId: 'user_1' }).connect()
    await expect(adapter.executeScript('SELECT 1')).rejects.toThrow(TenantScopeError)
    await adapter.dispose()
  })

  it('works over an AuditedPool, and an unsafe login never runs a statement', async () => {
    const safe = new AuditedPool(db.config(login, { max: 1 }), { roles: [runtime], inherit: false })
    pools.push(safe)
    expect(await prisma(new TenantPg(safe, office, { tenantId: 'tenant_b', actorId: 'user_1' })).$queryRawUnsafe('SELECT value FROM public."AdapterProbe"')).toEqual([
      { value: 'B' },
    ])
    const unsafe = new AuditedPool(db.config(outsider, { max: 1 }), { roles: [runtime] })
    pools.push(unsafe)
    await expect(prisma(new TenantPg(unsafe, office, { tenantId: 'tenant_b', actorId: 'user_1' })).$queryRawUnsafe('SELECT 1')).rejects.toThrow(
      /Unsafe database runtime login/,
    )
  })
})
