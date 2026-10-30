import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'

/**
 * Saved views (B-W2a-23; PLT-163) through the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security is real). Made-up people, roles and lists. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/views`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const anna = newId()
const bruno = newId()
const carla = newId()
const dario = newId()
const otherTenantUser = newId()
const roleSales = newId()
const roleFinance = newId()

const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (tenantId: string, actorId: string, permissions: readonly Permission[]): SessionContext => ({ audience: 'office', tenantId, actorId, companyId: companyA, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  // Anna and Bruno hold Sales; Carla holds Finance; Dario is an administrator (views.manage) holding Sales.
  anna: office(tenantA, anna, ['views.save', 'views.export']),
  bruno: office(tenantA, bruno, ['views.save']),
  carla: office(tenantA, carla, ['views.save']),
  dario: office(tenantA, dario, ['views.save', 'views.manage']),
  reader: office(tenantA, carla, ['sites.view']),
  other: office(tenantB, otherTenantUser, ['views.save', 'views.manage']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const refused = async (session: string, method: Method, url: string, payload: unknown, status: number) => {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const listOf = (session: string, listKey = 'sales.orders') => ok(session, 'GET', `/views?listKey=${listKey}`)
const LATE = { query: 'late=true&q=demo', columns: { order: ['number', 'customer'], hidden: ['quote'], pinned: ['number'] }, density: 'compact' }

beforeAll(async () => {
  db = await migratedDatabase('platform_views')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2), ($3, $4, $4)', [tenantA, 'views-a', tenantB, 'views-b'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'VWA', 'Viste Prova S.r.l.')`, [companyA, tenantA])
  for (const [id, tenantId, email, name] of [
    [anna, tenantA, 'anna@example.com', 'Anna Demo'],
    [bruno, tenantA, 'bruno@example.com', 'Bruno Demo'],
    [carla, tenantA, 'carla@example.com', 'Carla Demo'],
    [dario, tenantA, 'dario@example.com', 'Dario Demo'],
    [otherTenantUser, tenantB, 'altro@example.com', 'Altro Demo'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, tenantId, email, name])
  }
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience) VALUES ($1, $3, 'custom.sales', 'Demo sales', 'OFFICE'), ($2, $3, 'custom.finance', 'Demo finance', 'OFFICE')`, [roleSales, roleFinance, tenantA])
  for (const [userId, roleId] of [
    [anna, roleSales],
    [bruno, roleSales],
    [carla, roleFinance],
    [dario, roleSales],
  ] as const) {
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), tenantA, userId, roleId])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

const ids: Record<string, string> = {}

describe('my own views (views.save)', () => {
  it('saves what the list keeps, normalised; lists it first; a repeated key answers the same view', async () => {
    const body = { listKey: 'sales.orders', name: 'Late Demo', state: { ...LATE, query: 'q=demo&late=true&open=0190f0e2-0000-7000-8000-000000000001' } }
    const { view } = await ok('anna', 'POST', '/views', body, 201, 'views-anna-late-0001')
    ids.late = view.id
    expect(view).toMatchObject({ listKey: 'sales.orders', name: 'Late Demo', mine: true, audience: 'ONLY_ME', roleId: null, roleDefault: false, ownerName: 'Anna Demo', changeHeld: null, state: { query: 'late=true&q=demo', columns: LATE.columns, density: 'compact' } })
    expect((await ok('anna', 'POST', '/views', body, 201, 'views-anna-late-0001')).view.id).toBe(view.id)
    const list = await listOf('anna')
    expect(list.views.map((entry: Json) => entry.name)).toEqual(['Late Demo'])
    expect(list).toMatchObject({ roleDefaultId: null, roles: [{ id: roleSales, name: 'Demo sales' }], allRoles: [], can: { save: true, manage: false, export: true } })
    // Nobody else sees an ONLY_ME view, not even an administrator; nor another tenant.
    expect((await listOf('bruno')).views).toEqual([])
    expect((await listOf('dario')).views).toEqual([])
    await refused('bruno', 'GET', `/views/${view.id}`, undefined, 404)
    await refused('other', 'GET', `/views/${view.id}`, undefined, 404)
    // Audited: the name, the sharing and the list terms, never a value of the list.
    const [audit] = await admin<{ action: string; after: Json }>('SELECT action, after FROM "AuditLog" WHERE "recordId" = $1', [view.id])
    expect(audit).toMatchObject({ action: 'views.create', after: { listKey: 'sales.orders', name: 'Late Demo', audience: 'ONLY_ME', query: 'late=true&q=demo' } })
  })

  it('refuses a second view of the same name (any case), a bad list key, an unknown part of the state', async () => {
    expect((await refused('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'late demo', state: { query: '' } }, 409)).error.message).toMatch(/already have a view/)
    await refused('anna', 'POST', '/views', { listKey: '/sales/orders', name: 'X', state: { query: '' } }, 400)
    await refused('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'X', state: { query: '', mode: 'board' } }, 400)
    await refused('reader', 'POST', '/views', { listKey: 'sales.orders', name: 'X', state: { query: '' } }, 403)
  })

  it('renames, changes what it keeps and removes it, each with the version read', async () => {
    const before = (await ok('anna', 'GET', `/views/${ids.late}`)).view
    const { view } = await ok('anna', 'PATCH', `/views/${ids.late}`, { version: before.version, name: 'Late, mine', state: { query: 'late=true' } })
    expect(view).toMatchObject({ name: 'Late, mine', version: before.version + 1, state: { query: 'late=true' } })
    await refused('anna', 'PATCH', `/views/${ids.late}`, { version: before.version, name: 'Stale' }, 409)
    const scratch = (await ok('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'Scratch', state: { query: 'rows=all' } }, 201)).view
    await ok('anna', 'DELETE', `/views/${scratch.id}?version=${scratch.version}`)
    await refused('anna', 'GET', `/views/${scratch.id}`, undefined, 404)
  })
})

describe('shared views (a role, everyone, a role default)', () => {
  it('shares with a role they hold; its holders see it now, others never; only the owner changes it', async () => {
    const { view } = await ok('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'Deposits', audience: 'ROLE', roleId: roleSales, state: { query: 'deposit=OPEN' } }, 201)
    ids.deposits = view.id
    expect(view).toMatchObject({ audience: 'ROLE', roleId: roleSales, roleName: 'Demo sales' })
    expect((await listOf('bruno')).views).toEqual([expect.objectContaining({ id: view.id, mine: false, ownerName: 'Anna Demo', changeHeld: expect.stringMatching(/Only its owner/) })])
    expect((await listOf('carla')).views).toEqual([])
    await refused('bruno', 'PATCH', `/views/${view.id}`, { version: view.version, name: 'Mine now' }, 403)
    await refused('bruno', 'DELETE', `/views/${view.id}?version=${view.version}`, undefined, 403)
    // A role Anna does not hold: refused in words; sharing with everyone needs views.manage.
    expect((await refused('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'For finance', audience: 'ROLE', roleId: roleFinance, state: { query: '' } }, 400)).error.issues).toEqual([expect.objectContaining({ path: 'body/roleId' })])
    expect((await refused('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'For all', audience: 'EVERYONE', state: { query: '' } }, 400)).error.issues).toEqual([expect.objectContaining({ path: 'body/audience' })])
    // A role that is not one of the tenant's.
    await refused('dario', 'POST', '/views', { listKey: 'sales.orders', name: 'Ghost', audience: 'ROLE', roleId: newId(), state: { query: '' } }, 400)
  })

  it('views.manage shares with everyone and sets a role default: the list opens on it for the role, one per list and role', async () => {
    const everyone = (await ok('dario', 'POST', '/views', { listKey: 'sales.orders', name: 'Everything', audience: 'EVERYONE', state: { query: 'rows=all' } }, 201)).view
    expect((await listOf('carla')).views.map((entry: Json) => entry.name)).toEqual(['Everything'])
    const first = (await ok('dario', 'POST', '/views', { listKey: 'sales.orders', name: 'Sales start', audience: 'ROLE', roleId: roleSales, roleDefault: true, state: { query: 'late=true' } }, 201)).view
    const anna1 = await listOf('anna')
    expect(anna1.roleDefaultId).toBe(first.id)
    expect((await listOf('carla')).roleDefaultId).toBeNull()
    expect((await listOf('dario')).allRoles.map((role: Json) => role.name)).toEqual(['Demo finance', 'Demo sales'])
    // A second default for the same role takes the mark off the first (it stays shared with the role).
    const second = (await ok('dario', 'POST', '/views', { listKey: 'sales.orders', name: 'Sales start 2', audience: 'ROLE', roleId: roleSales, roleDefault: true, state: { query: 'deposit=OPEN' } }, 201)).view
    const anna2 = await listOf('anna')
    expect(anna2.roleDefaultId).toBe(second.id)
    expect(anna2.views.find((entry: Json) => entry.id === first.id)).toMatchObject({ roleDefault: false, audience: 'ROLE' })
    // Only views.manage changes a role default, even its owner's own edits; dario changes Anna's shared view.
    expect((await refused('anna', 'POST', '/views', { listKey: 'sales.orders', name: 'My default', audience: 'ROLE', roleId: roleSales, roleDefault: true, state: { query: '' } }, 400)).error.issues).toEqual([expect.objectContaining({ path: 'body/roleDefault' })])
    const deposits = (await ok('dario', 'GET', `/views/${ids.deposits}`)).view
    expect(deposits.changeHeld).toBeNull()
    expect((await ok('dario', 'PATCH', `/views/${ids.deposits}`, { version: deposits.version, name: 'Deposits (team)' })).view.name).toBe('Deposits (team)')
    await ok('dario', 'DELETE', `/views/${everyone.id}?version=${everyone.version}`)
    expect((await listOf('carla')).views).toEqual([])
  })

  it('a view of one list is never in another list’s menu', async () => {
    expect((await listOf('anna', 'production.work-orders')).views).toEqual([])
    expect((await listOf('anna', 'production.work-orders')).exports).toEqual({ formats: ['CSV', 'XLSX'] })
    expect((await listOf('anna', 'admin.users')).exports).toBeNull()
    // Without views.export the list's export is not offered.
    expect((await listOf('bruno', 'production.work-orders')).exports).toBeNull()
  })
})
