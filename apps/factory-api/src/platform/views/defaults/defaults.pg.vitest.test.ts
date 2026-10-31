import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * My default view of a list (B-W2b-24, Z12:07; PLT-163) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the partial unique index are real). Made-up
 * people and lists. Run with `node scripts/factory/run-pg-tests.mjs platform/views/defaults`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const company = newId()
const anna = newId()
const bruno = newId()
const roleSales = newId()

const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (actorId: string, permissions: readonly Permission[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, companyId: company, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  anna: office(anna, ['views.save']),
  bruno: office(bruno, ['views.save', 'views.manage']),
  annaReader: office(anna, ['sites.view']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const listOf = (session: string, listKey = 'sales.orders') => ok(session, 'GET', `/views?listKey=${listKey}`)
const create = async (session: string, name: string, extra: Json = {}, listKey = 'sales.orders') => (await ok(session, 'POST', '/views', { listKey, name, state: { query: `q=${name.toLowerCase()}` }, ...extra }, 201)).view as Json

beforeAll(async () => {
  db = await migratedDatabase('views_defaults')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'views-defaults'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'VWD', 'Viste Default Prova S.r.l.')`, [company, tenant])
  for (const [id, email, name] of [
    [anna, 'anna.d@example.com', 'Anna Demo'],
    [bruno, 'bruno.d@example.com', 'Bruno Demo'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, tenant, email, name])
  }
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience) VALUES ($1, $2, 'custom.sales', 'Demo sales', 'OFFICE')`, [roleSales, tenant])
  for (const userId of [anna, bruno]) {
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), tenant, userId, roleSales])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('my default view of a list (Z12:07)', () => {
  it('marks my own view; the list says it opens on it before the role default; the mark is audited', async () => {
    const late = await create('anna', 'Late')
    const roleDefault = await create('bruno', 'Team start', { audience: 'ROLE', roleId: roleSales, roleDefault: true })
    expect((await listOf('anna')).personalDefaultId).toBeNull()
    expect((await listOf('anna')).roleDefaultId).toBe(roleDefault.id)

    const marked = await ok('anna', 'PUT', `/views/${late.id}/personal-default`, { version: late.version }, 200, 'defaults-anna-late-0001')
    expect(marked.personalDefaultId).toBe(late.id)
    expect(marked.view).toMatchObject({ id: late.id, personalDefault: true, version: late.version + 1 })
    // A repeated key answers the same.
    expect((await ok('anna', 'PUT', `/views/${late.id}/personal-default`, { version: late.version }, 200, 'defaults-anna-late-0001')).view.version).toBe(late.version + 1)

    const list = await listOf('anna')
    expect(list.personalDefaultId).toBe(late.id)
    expect(list.roleDefaultId).toBe(roleDefault.id)
    expect((list.views as Json[]).find((view) => view.id === late.id)?.personalDefault).toBe(true)
    expect((list.views as Json[]).find((view) => view.id === roleDefault.id)?.personalDefault).toBe(false)
    // Bruno sees nothing of Anna's mark (her view is hers alone).
    expect((await listOf('bruno')).personalDefaultId).toBeNull()

    const audit = await admin(`SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'views.setPersonalDefault'`, [late.id])
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ before: { isPersonalDefault: false }, after: { isPersonalDefault: true, name: 'Late', listKey: 'sales.orders' } })
  })

  it('a second default takes the mark off the first in the same command; another list keeps its own', async () => {
    const list = await listOf('anna')
    const first = (list.views as Json[]).find((view) => view.personalDefault)!
    const second = await create('anna', 'Open')
    const otherList = await create('anna', 'Moves', {}, 'warehouse.moves')
    await ok('anna', 'PUT', `/views/${otherList.id}/personal-default`, { version: otherList.version })

    const marked = await ok('anna', 'PUT', `/views/${second.id}/personal-default`, { version: second.version })
    expect(marked.personalDefaultId).toBe(second.id)
    const after = await listOf('anna')
    expect(after.personalDefaultId).toBe(second.id)
    const old = (after.views as Json[]).find((view) => view.id === first.id)!
    expect(old).toMatchObject({ personalDefault: false, version: first.version + 1 })
    expect((await listOf('anna', 'warehouse.moves')).personalDefaultId).toBe(otherList.id)
    const cleared = await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'views.clearPersonalDefault'`, [first.id])
    expect(cleared[0]?.after).toMatchObject({ isPersonalDefault: false, replacedBy: second.id })
    expect(await admin(`SELECT count(*)::int AS n FROM "SavedView" WHERE "tenantId" = $1 AND "ownerId" = $2 AND "listKey" = 'sales.orders' AND "isPersonalDefault"`, [tenant, anna])).toEqual([{ n: 1 }])
  })

  it('unmarks: the list opens on the role default again; unmarking again changes nothing', async () => {
    const current = (await listOf('anna')).views.find((view: Json) => view.personalDefault) as Json
    const cleared = await ok('anna', 'DELETE', `/views/${current.id}/personal-default?version=${current.version}`)
    expect(cleared).toMatchObject({ personalDefaultId: null, view: { id: current.id, personalDefault: false, version: current.version + 1 } })
    const list = await listOf('anna')
    expect(list.personalDefaultId).toBeNull()
    expect(list.roleDefaultId).not.toBeNull()
    const again = await ok('anna', 'DELETE', `/views/${current.id}/personal-default?version=${current.version + 1}`)
    expect(again.view.version).toBe(current.version + 1)
  })

  it('refuses: a view someone shared (in words), a stale version, another person’s private view, no views.save', async () => {
    const roleDefault = (await listOf('anna')).views.find((view: Json) => view.roleDefault) as Json
    const shared = await call('anna', 'PUT', `/views/${roleDefault.id}/personal-default`, { version: roleDefault.version })
    expect(shared.statusCode).toBe(403)
    expect(shared.json().error.message).toMatch(/save this one as your own/)

    const mine = await create('anna', 'Stale')
    const stale = await call('anna', 'PUT', `/views/${mine.id}/personal-default`, { version: mine.version + 3 })
    expect(stale.statusCode).toBe(409)

    const brunoOwn = await create('bruno', 'Private')
    expect((await call('anna', 'PUT', `/views/${brunoOwn.id}/personal-default`, { version: brunoOwn.version })).statusCode).toBe(404)
    expect((await call('annaReader', 'PUT', `/views/${mine.id}/personal-default`, { version: mine.version })).statusCode).toBe(403)
    expect(await admin(`SELECT count(*)::int AS n FROM "SavedView" WHERE "isPersonalDefault" AND "ownerId" = $1 AND "listKey" = 'sales.orders'`, [bruno])).toEqual([{ n: 0 }])
  })

  it('a removed default is simply gone: the list has no default of mine', async () => {
    const view = await create('anna', 'Short lived')
    const marked = await ok('anna', 'PUT', `/views/${view.id}/personal-default`, { version: view.version })
    await ok('anna', 'DELETE', `/views/${view.id}?version=${marked.view.version}`)
    expect((await listOf('anna')).personalDefaultId).toBeNull()
  })
})
