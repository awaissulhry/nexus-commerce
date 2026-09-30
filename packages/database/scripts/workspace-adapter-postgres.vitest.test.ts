import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { WorkspacePg } from '../workspace-adapter.ts'
import type { WorkspaceContext } from '../workspace-context.ts'

/**
 * The workspace adapter on a real PostgreSQL 17 (P2, 2026-09-30): every statement outside a transaction carries its
 * role and business in ONE round trip, the scope ends with the statement, and nothing reaches the next borrower of the
 * connection. Owns a disposable server (roles are cluster-wide), like runtime-role-postgres.vitest.test.ts; needs
 * Docker and the local postgres:17-alpine image.
 */
describe('workspace adapter on real PostgreSQL', () => {
  const container = `nexus-workspace-adapter-${process.pid}-${randomBytes(4).toString('hex')}`
  const login = `adapter_login_${randomBytes(4).toString('hex')}`
  let started = false
  let port = 0
  let admin: pg.Client | undefined
  const pools: pg.Pool[] = []
  const clients: PrismaClient[] = []

  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const scope = (workspaceId: string, actorUserId: string | null = null): WorkspaceContext => ({ workspaceId, actorUserId, membershipId: null, roleKeys: [] })
  const pool = (user = login, max = 1) => { const p = new pg.Pool({ host: '127.0.0.1', port, user, database: 'postgres', max, connectionTimeoutMillis: 5_000 }); pools.push(p); return p }
  const prisma = (p: pg.Pool, s?: WorkspaceContext) => { const c = new PrismaClient({ adapter: new WorkspacePg(p, s), log: [] }); clients.push(c); return c }
  type Seen = { login: string; role: string; workspace: string | null; actor: string | null }
  const WHO = `SELECT session_user::text AS login, current_user::text AS role,
    NULLIF(current_setting('nexus.workspace_id', true), '') AS workspace, NULLIF(current_setting('nexus.actor_id', true), '') AS actor`

  /** Count what the pg driver sends: one `Client.query` call is one round trip to the server. */
  async function roundTrips<T>(work: () => Promise<T>): Promise<{ value: T; calls: number; texts: string[] }> {
    const original = pg.Client.prototype.query
    const texts: string[] = []
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as { text?: string } | string
      texts.push(typeof first === 'string' ? first : first?.text ?? '?')
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof original
    try { const value = await work(); return { value, calls: texts.length, texts } }
    finally { pg.Client.prototype.query = original }
  }

  beforeAll(async () => {
    docker('image', 'inspect', 'postgres:17-alpine')
    docker('run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data', 'postgres:17-alpine')
    started = true
    port = Number(docker('port', container, '5432/tcp').split('\n')[0].split(':').pop())
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 500 })
      try { await candidate.connect(); admin = candidate; break }
      catch (error) {
        await candidate.end()
        if (attempt === 99) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await admin!.query(`
      CREATE ROLE nexus_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      GRANT nexus_workspace_runtime TO ${login} WITH INHERIT TRUE, SET TRUE;
      CREATE ROLE adapter_outsider LOGIN NOSUPERUSER NOBYPASSRLS;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO nexus_workspace_runtime, adapter_outsider;
      CREATE TABLE public."AdapterProbe" (id serial PRIMARY KEY, "workspaceId" text NOT NULL, value text NOT NULL UNIQUE);
      INSERT INTO public."AdapterProbe" ("workspaceId", value) VALUES ('business_a', 'A'), ('business_b', 'B');
      ALTER TABLE public."AdapterProbe" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public."AdapterProbe" FORCE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public."AdapterProbe" TO nexus_workspace_runtime, adapter_outsider;
      GRANT USAGE ON SEQUENCE public."AdapterProbe_id_seq" TO nexus_workspace_runtime, adapter_outsider;
      CREATE POLICY workspace_scope ON public."AdapterProbe" TO nexus_workspace_runtime
        USING ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''))
        WITH CHECK ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''));
      CREATE POLICY outsider_everything ON public."AdapterProbe" TO adapter_outsider USING (true) WITH CHECK (true);
    `)
  }, 60_000)

  afterAll(async () => {
    try {
      await Promise.allSettled(clients.map(client => client.$disconnect()))
      await Promise.allSettled(pools.map(p => p.end()))
      await admin?.end()
    } finally { if (started) docker('stop', container) }
  }, 40_000)

  it('runs a statement outside a transaction as the runtime role with its business, in ONE round trip', async () => {
    const db = prisma(pool(), scope('business_a', 'user_1'))
    const { value, calls } = await roundTrips(() => db.$queryRawUnsafe<Seen[]>(WHO))
    expect(value).toEqual([{ login, role: 'nexus_workspace_runtime', workspace: 'business_a', actor: 'user_1' }])
    // Before P2: BEGIN, SET LOCAL ROLE, set_config, the statement, COMMIT — five round trips.
    expect(calls).toBe(1)
  })

  it('ends the scope with the statement: the next borrower of the same connection sees the plain login', async () => {
    const shared = pool()
    const db = prisma(shared, scope('business_a', 'user_1'))
    expect(await db.$queryRawUnsafe<Seen[]>(WHO)).toEqual([{ login, role: 'nexus_workspace_runtime', workspace: 'business_a', actor: 'user_1' }])
    // max 1: this is the very connection the scoped statement ran on.
    const plain = await shared.query<Seen>(WHO)
    expect(plain.rows).toEqual([{ login, role: login, workspace: null, actor: null }])
    expect((await shared.query<{ open: boolean }>('SELECT now() = statement_timestamp() AS open')).rows[0].open).toBe(true)
  })

  it('applies row-level security to reads and writes, and commits a write before it returns', async () => {
    const shared = pool()
    const a = prisma(shared, scope('business_a'))
    expect(await a.$queryRawUnsafe('SELECT value FROM public."AdapterProbe" ORDER BY id')).toEqual([{ value: 'A' }])
    expect(await a.$executeRawUnsafe('UPDATE public."AdapterProbe" SET value = value WHERE "workspaceId" = $1', 'business_b')).toBe(0)
    await expect(a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("workspaceId", value) VALUES ($1, $2)', 'business_b', 'forged')).rejects.toThrow()
    expect(await a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("workspaceId", value) VALUES ($1, $2)', 'business_a', 'A2')).toBe(1)
    // Another session sees the row at once: the Sync committed it.
    expect((await admin!.query('SELECT "workspaceId" FROM public."AdapterProbe" WHERE value = $1', ['A2'])).rows).toEqual([{ workspaceId: 'business_a' }])
    expect((await admin!.query('SELECT count(*)::int AS n FROM public."AdapterProbe" WHERE value = $1', ['forged'])).rows[0].n).toBe(0)
    await admin!.query('DELETE FROM public."AdapterProbe" WHERE value = $1', ['A2'])
  })

  it('a failing statement rolls back alone and leaves the connection clean and usable', async () => {
    const shared = pool()
    const a = prisma(shared, scope('business_a', 'user_1'))
    const backend = async () => (await shared.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const before = await backend()
    await expect(a.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("workspaceId", value) VALUES ($1, $2)', 'business_a', 'A')).rejects.toThrow()
    await expect(a.$queryRawUnsafe('SELECT 1 / (SELECT count(*) FROM public."AdapterProbe" WHERE false)')).rejects.toThrow()
    expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, workspace: null, actor: null }])
    expect(await a.$queryRawUnsafe<Seen[]>(WHO)).toEqual([{ login, role: 'nexus_workspace_runtime', workspace: 'business_a', actor: 'user_1' }])
    // The server's refusal ended the batch cleanly: the connection was kept, not replaced.
    expect(await backend()).toBe(before)
  })

  it('never runs a statement unscoped: when the scope statement fails, the statement is skipped', async () => {
    // adapter_outsider may not enter nexus_workspace_runtime, and its own policy would let the insert through.
    const outsider = pool('adapter_outsider')
    const db = prisma(outsider, scope('business_a'))
    await expect(db.$executeRawUnsafe('INSERT INTO public."AdapterProbe" ("workspaceId", value) VALUES ($1, $2)', 'business_b', 'unscoped')).rejects.toThrow(/permission denied to set role/)
    expect((await admin!.query('SELECT count(*)::int AS n FROM public."AdapterProbe" WHERE value = $1', ['unscoped'])).rows[0].n).toBe(0)
    expect((await outsider.query<{ role: string }>('SELECT current_user::text AS role')).rows).toEqual([{ role: 'adapter_outsider' }])
  })

  it('keeps concurrent businesses apart on shared connections', async () => {
    const shared = pool(login, 2)
    const a = prisma(shared, scope('business_a', 'user_a'))
    const b = prisma(shared, scope('business_b', 'user_b'))
    const reads = Array.from({ length: 60 }, (_, i) => (i % 2 ? b : a).$queryRawUnsafe<Array<Seen & { value: string }>>(
      `SELECT w.*, (SELECT string_agg(value, ',') FROM public."AdapterProbe") AS value FROM (${WHO}) w`,
    ).then(rows => [i % 2 ? 'b' : 'a', rows[0]] as const))
    for (const [who, row] of await Promise.all(reads)) {
      expect(row).toEqual(who === 'a'
        ? { login, role: 'nexus_workspace_runtime', workspace: 'business_a', actor: 'user_a', value: 'A' }
        : { login, role: 'nexus_workspace_runtime', workspace: 'business_b', actor: 'user_b', value: 'B' })
    }
  })

  it('scopes an interactive transaction with ONE statement after BEGIN, and the scope ends at COMMIT', async () => {
    const shared = pool()
    const db = prisma(shared, scope('business_b', 'user_b'))
    const { value, texts } = await roundTrips(() => db.$transaction(async tx => {
      const first = await tx.$queryRawUnsafe<Seen[]>(WHO)
      const rows = await tx.$queryRawUnsafe('SELECT value FROM public."AdapterProbe" ORDER BY id')
      return { first, rows }
    }, { isolationLevel: 'Serializable' }))
    expect(value).toEqual({ first: [{ login, role: 'nexus_workspace_runtime', workspace: 'business_b', actor: 'user_b' }], rows: [{ value: 'B' }] })
    // BEGIN, isolation, ONE scope statement (before P2: SET LOCAL ROLE and set_config, two), the two reads, COMMIT.
    expect(texts.map(text => text.split(' ')[0])).toEqual(['BEGIN', 'SET', 'SELECT', 'SELECT', 'SELECT', 'COMMIT'])
    expect(texts[2]).toContain("set_config('role', 'nexus_workspace_runtime', true)")
    expect((await shared.query<Seen>(WHO)).rows).toEqual([{ login, role: login, workspace: null, actor: null }])
  })

  it('discards a connection a statement left inside a transaction instead of pooling it', async () => {
    const shared = pool()
    const db = prisma(shared, scope('business_a', 'user_1'))
    // The router refuses this SQL (workspace-sql.ts); the adapter's own tripwire must hold without it.
    await expect(db.$executeRawUnsafe('BEGIN')).rejects.toThrow(/cannot be changed/)
    expect((await shared.query<Seen & { idle: boolean }>(`${WHO}, now() = statement_timestamp() AS idle`)).rows)
      .toEqual([{ login, role: login, workspace: null, actor: null, idle: true }])
  })
})
