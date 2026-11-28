import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd1 1.3 on the local stack with the app's real routes: keeping the factory's departments — add (the next number for ever,
 * the first free tone, its ONE default library operation), rename (its default operation too), close and open again — and the
 * refusals in words: a blank name, a name taken (letter case aside), a floor department's name and close, a closed one's rename,
 * a stale version. The product seed's nine departments (1 Pattern … 6 Packing on the floor; 7 Design, 8 Molding, 9 Assembly) and
 * their DEPT-1 … DEPT-9 operations. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs production/departments`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'owb-pd1-departments'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const department = (number: number): string => seedId(`product:department:${number}`)

const KEEPER: Permission[] = ['production.departments.manage', 'workorders.view', 'product.routing.view']
const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: [...permissions], companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(KEEPER)] }),
  // The right over one company only: a department of the whole factory is not theirs to keep.
  oneCompany: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(KEEPER, [companyA])] }),
  reader: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['workorders.view'])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
/** A refusal: its status, and the code at `refusal/<code>` with its words. */
async function refused(session: string, method: 'POST' | 'PATCH', url: string, payload: unknown, status: number): Promise<{ code: string | null; message: string }> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  const error = response.json().error as Json
  const issue = (error.issues ?? []).find((entry: Json) => String(entry.path).startsWith('refusal/'))
  return { code: issue ? String(issue.path).slice('refusal/'.length) : null, message: error.message }
}
const departmentOf = async (id: string): Promise<Json> => (await ok('manager', 'GET', '/production/departments')).departments.find((row: Json) => row.id === id)
const defaultOperations = (departmentId: string) =>
  admin<{ code: string; name: string; status: string; workCentreKind: string; standardMinutes: string }>(
    `SELECT code, name, status::text AS status, "workCentreKind"::text AS "workCentreKind", "standardMinutes"::text AS "standardMinutes" FROM "Operation" WHERE "departmentId" = $1 AND "departmentDefault"`,
    [departmentId],
  )

beforeAll(async () => {
  db = await migratedDatabase('owb_pd1_departments')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('keeping the departments (owb-pd1 1.3)', () => {
  let embroidery: Json

  it('adds a department with the next number, the first free tone and the defaults, and its ONE default operation', async () => {
    embroidery = (await ok('manager', 'POST', '/production/departments', { name: '  Embroidery  ' }, 201)).department
    expect(embroidery).toMatchObject({ number: 10, name: 'Embroidery', shortName: 'Embroidery', tone: 'red', icon: 'circle-dot', workCentreKind: 'ASSEMBLY', floorReady: false, status: 'ACTIVE', version: 1 })
    expect(await defaultOperations(embroidery.id)).toEqual([{ code: 'DEPT-10', name: 'Embroidery', status: 'ACTIVE', workCentreKind: 'ASSEMBLY', standardMinutes: '0.000' }])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.department_changed' AND subject = $1`, [embroidery.id])
    expect(events.map((row) => row.payload)).toEqual([{ departmentId: embroidery.id, number: 10, change: 'CREATED' }])
    expect(await departmentOf(embroidery.id)).toMatchObject({ number: 10, status: 'ACTIVE' })
  })

  it('refuses a blank name (400) and a name another department answers to, letter case aside (409)', async () => {
    expect(await refused('manager', 'POST', '/production/departments', { name: '   ' }, 400)).toEqual({ code: 'NAME_EMPTY', message: 'A department needs a name.' })
    expect((await refused('manager', 'POST', '/production/departments', { name: 'EMBROIDERY' }, 409)).code).toBe('NAME_TAKEN')
    // A seeded one's short name ("Patch & print" of 3 Patchwork & printing) is taken too.
    expect(await refused('manager', 'POST', '/production/departments', { name: 'patch & print' }, 409)).toEqual({ code: 'NAME_TAKEN', message: 'This name is used by another department.' })
    // Nothing was made by a refusal: the default operation of the name taken is still made once.
    expect(await defaultOperations(embroidery.id)).toHaveLength(1)
  })

  it('never gives a number again: a closed department keeps its number, the next one takes a new one', async () => {
    const closed = (await ok('manager', 'POST', `/production/departments/${embroidery.id}/close`, { version: embroidery.version })).department
    expect(closed).toMatchObject({ number: 10, status: 'CLOSED', version: 2 })
    expect((await defaultOperations(embroidery.id))[0]).toMatchObject({ code: 'DEPT-10', status: 'ARCHIVED' })
    const laser = (await ok('manager', 'POST', '/production/departments', { name: 'Laser cutting', shortName: 'Laser' }, 201)).department
    expect(laser).toMatchObject({ number: 11, shortName: 'Laser' })
    // The closed one's name stays taken.
    expect((await refused('manager', 'POST', '/production/departments', { name: 'Embroidery' }, 409)).code).toBe('NAME_TAKEN')
    // A closed one keeps its names: open it again first.
    expect((await refused('manager', 'PATCH', `/production/departments/${embroidery.id}`, { version: closed.version, name: 'Embroidery hall' }, 409)).code).toBe('CLOSED')
    const opened = (await ok('manager', 'POST', `/production/departments/${embroidery.id}/open`, { version: closed.version })).department
    expect(opened).toMatchObject({ number: 10, status: 'ACTIVE', version: 3 })
    expect((await defaultOperations(embroidery.id))[0]).toMatchObject({ status: 'ACTIVE' })
    embroidery = opened
  })

  it('renames a department and its default operation with it; a stale version is refused', async () => {
    const renamed = (await ok('manager', 'PATCH', `/production/departments/${embroidery.id}`, { version: embroidery.version, name: 'Embroidery hall', shortName: 'Embroidery' })).department
    expect(renamed).toMatchObject({ name: 'Embroidery hall', shortName: 'Embroidery', version: embroidery.version + 1 })
    expect((await defaultOperations(embroidery.id))[0]).toMatchObject({ code: 'DEPT-10', name: 'Embroidery hall' })
    const stale = await call('manager', 'PATCH', `/production/departments/${embroidery.id}`, { version: embroidery.version, name: 'Embroidery room' })
    expect(stale.statusCode).toBe(409)
    expect((await departmentOf(embroidery.id)).name).toBe('Embroidery hall')
  })

  it('keeps a floor department’s name and never closes it (FLOOR_FIXED); its names per language may still be given', async () => {
    const pattern = await departmentOf(department(1))
    expect(pattern).toMatchObject({ number: 1, floorReady: true })
    expect(await refused('manager', 'PATCH', `/production/departments/${department(1)}`, { version: pattern.version, name: 'Patterns' }, 409)).toEqual({
      code: 'FLOOR_FIXED',
      message: 'This department has screens on the floor: its name stays and it cannot be closed.',
    })
    expect((await refused('manager', 'PATCH', `/production/departments/${department(1)}`, { version: pattern.version, shortName: 'Pat.' }, 409)).code).toBe('FLOOR_FIXED')
    expect((await refused('manager', 'POST', `/production/departments/${department(1)}/close`, { version: pattern.version }, 409)).code).toBe('FLOOR_FIXED')
    const worded = (await ok('manager', 'PATCH', `/production/departments/${department(1)}`, { version: pattern.version, nameI18n: { en: 'Pattern', it: 'Cartamodello', ur: 'پیٹرن' } })).department
    expect(worded).toMatchObject({ name: 'Pattern', status: 'ACTIVE', nameI18n: { en: 'Pattern', it: 'Cartamodello' } })
  })

  it('is kept only with the right over every company', async () => {
    expect((await call('oneCompany', 'POST', '/production/departments', { name: 'Assembly hall' })).statusCode).toBe(403)
    expect((await call('reader', 'POST', '/production/departments', { name: 'Assembly hall' })).statusCode).toBe(403)
    expect((await call('reader', 'POST', `/production/departments/${department(9)}/close`, { version: 1 })).statusCode).toBe(403)
    expect((await admin(`SELECT 1 FROM "Department" WHERE name = 'Assembly hall'`)).length).toBe(0)
  })
})
