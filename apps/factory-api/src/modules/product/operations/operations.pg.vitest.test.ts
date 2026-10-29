import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The operation library on the local stack (B-W1-14; features PRD-109, PRD-111), with the app's real routes, the product
 * seed's operations (cut 14, sew 96.5, inspect 8, pack 3.5 standard minutes) and its jacket's draft routing, and sessions
 * from the test authenticator. Every code and name is made up. Run with `node scripts/factory/run-pg-tests.mjs operations`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'operations-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const CUT = seedId('product:operation:CUT')
const SEW = seedId('product:operation:SEW')
const otherTenant = newId()

const VIEW = 'product.routing.view'
const MANAGE = 'product.routing.manage'
const LIBRARY = 'product.operations.manage'

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  engineer: { tenantId: tenant, permissions: [VIEW, MANAGE, LIBRARY, 'audit.read'], companies: 'all' },
  developer: { tenantId: tenant, permissions: [VIEW, MANAGE], companies: 'all' },
  companyA: { tenantId: tenant, permissions: [VIEW, LIBRARY], companies: [companyA] },
  companyB: { tenantId: tenant, permissions: [VIEW, LIBRARY], companies: [companyB] },
  stylesOnly: { tenantId: tenant, permissions: ['product.styles.view'], companies: 'all' },
  otherTenant: { tenantId: otherTenant, permissions: [VIEW, LIBRARY], companies: 'all' },
}
const ACTORS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: ACTORS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const historyOf = async (id: string): Promise<any[]> => (await ok('engineer', 'GET', `/audit/Operation/${id}`)).entries
const list = async (query: string, session = 'engineer'): Promise<Json> => ok(session, 'GET', `/product/operations${query}`)
const codesOf = (page: Json): string[] => page.operations.map((operation: Json) => operation.code)

let press: Json
let pressB: Json

beforeAll(async () => {
  db = await migratedDatabase('operations')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'operations-other'])
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
}, 60_000)

describe('the operation library (PRD-109, PRD-111)', () => {
  it('lists the seed operations by code with where each is used', async () => {
    const page = await list('')
    expect(page).toMatchObject({ count: 4, nextCursor: null })
    expect(codesOf(page)).toEqual(['SEED-CUT-LEA', 'SEED-FIN-QC', 'SEED-PACK', 'SEED-SEW-ASM'])
    expect(page.operations[3]).toMatchObject({ id: SEW, companyId: null, workCentreKind: 'SEWING', machineType: 'post-bed', skill: 'machinist', standardMinutes: '96.5', status: 'ACTIVE', usedIn: 1, differing: 0, version: 1 })
    const record = (await ok('developer', 'GET', `/product/operations/${CUT}`)).operation
    expect(record).toMatchObject({ code: 'SEED-CUT-LEA', nameI18n: { it: 'Taglio pelle', en: 'Cut leather panels' }, instructions: null, usedIn: 1 })
    expect(record.whereUsed).toEqual([
      {
        style: { id: jacket, code: 'SEED-JKT-01', name: 'Seed leather jacket' },
        revision: { id: revision1, revision: 1, status: 'DRAFT' },
        stepId: seedId('product:routing:JKT-01:1:SEED-CUT-LEA'),
        seq: 10,
        standardMinutes: '14',
        difference: '0',
      },
    ])
  })

  it('creates an operation with its code in capitals and its minutes rounded half up to 3 decimals, audited, with its event', async () => {
    press = (
      await ok(
        'engineer',
        'POST',
        '/product/operations',
        { code: ' op-press-1 ', name: 'Press the seams', nameI18n: { it: 'Stiratura cuciture', en: 'Press the seams' }, workCentreKind: 'FINISHING', machineType: 'press', skill: 'presser', standardMinutes: '2.34567', instructions: 'Medium heat, no steam on leather.' },
        201,
      )
    ).operation
    expect(press).toMatchObject({ code: 'OP-PRESS-1', companyId: null, standardMinutes: '2.346', status: 'ACTIVE', usedIn: 0, differing: 0, whereUsed: [], version: 1, createdById: ACTORS.engineer })
    expect((await historyOf(press.id))[0]).toMatchObject({ action: 'product.operations.create', after: { code: 'OP-PRESS-1', standardMinutes: '2.346', workCentreKind: 'FINISHING', status: 'ACTIVE' } })
    expect(await eventsOf(press.id)).toEqual([{ type: 'operation.created', payload: { operationId: press.id, code: 'OP-PRESS-1' } }])

    pressB = (await ok('companyB', 'POST', '/product/operations', { companyId: companyB, code: 'OP-B-PRESS', name: 'Company B press', workCentreKind: 'FINISHING', standardMinutes: '1.5' }, 201)).operation
    expect(pressB.companyId).toBe(companyB)
  })

  it('refuses a taken code, a bad one, minutes that round to 0, a foreign language and a kind outside the list', async () => {
    expect((await refused('engineer', 'POST', '/product/operations', { code: 'op-press-1', name: 'Again', workCentreKind: 'FINISHING', standardMinutes: '1' }, 409)).message).toBe('The operation code OP-PRESS-1 is taken.')
    expect((await refused('engineer', 'POST', '/product/operations', { code: 'OP-ZERO', name: 'Zero', workCentreKind: 'SEWING', standardMinutes: '0.0004' }, 400)).issues).toEqual([{ path: 'body/standardMinutes', message: 'Standard minutes are above 0 (at 3 decimals).' }])
    expect((await refused('engineer', 'POST', '/product/operations', { code: '-BAD', name: 'Bad', workCentreKind: 'SEWING', standardMinutes: '1' }, 400)).code).toBe('validation_failed')
    expect((await refused('engineer', 'POST', '/product/operations', { code: 'OP-DE', name: 'German', nameI18n: { de: 'Nähen' }, workCentreKind: 'SEWING', standardMinutes: '1' }, 400)).code).toBe('validation_failed')
    expect((await refused('engineer', 'POST', '/product/operations', { code: 'OP-WELD', name: 'Weld', workCentreKind: 'WELDING', standardMinutes: '1' }, 400)).code).toBe('validation_failed')
    expect((await list('?status=ALL')).count).toBe(6)
  })

  it('changes what is sent (versioned), keeps the code of a used operation, and leaves the routings with their copy', async () => {
    let sew = (await ok('engineer', 'GET', `/product/operations/${SEW}`)).operation
    sew = (await ok('engineer', 'PATCH', `/product/operations/${SEW}`, { version: sew.version, standardMinutes: '90.0', skill: null, nameI18n: null })).operation
    expect(sew).toMatchObject({ standardMinutes: '90', skill: null, nameI18n: null, version: 2, differing: 1, usedIn: 1 })
    expect(sew.whereUsed).toEqual([expect.objectContaining({ standardMinutes: '96.5', difference: '6.5', revision: expect.objectContaining({ status: 'DRAFT' }) })])
    expect((await historyOf(SEW))[0]).toMatchObject({
      action: 'product.operations.update',
      before: { standardMinutes: '96.5', skill: 'machinist', nameI18n: { it: 'Cucitura e montaggio', en: 'Sew and assemble the body' } },
      after: { standardMinutes: '90', skill: null, nameI18n: null },
    })
    expect((await eventsOf(SEW)).at(-1)).toEqual({ type: 'operation.updated', payload: { operationId: SEW, code: 'SEED-SEW-ASM', fields: ['nameI18n', 'skill', 'standardMinutes'] } })
    // The routing step keeps its copy and shows the difference.
    const routing = (await ok('developer', 'GET', `/product/styles/${jacket}/revisions/${revision1}/routing`)).routing
    expect(routing.steps[1]).toMatchObject({ code: 'SEED-SEW-ASM', standardMinutes: '96.5', differsFromLibrary: true, operation: { standardMinutes: '90', skill: null } })

    expect((await refused('engineer', 'PATCH', `/product/operations/${SEW}`, { version: sew.version, code: 'SEED-SEW-2' }, 400)).issues).toEqual([
      { path: 'body/code', message: 'Routings copied the code SEED-SEW-ASM: it no longer changes. Make a new operation instead.' },
    ])
    expect(await refused('engineer', 'PATCH', `/product/operations/${SEW}`, { version: 1, skill: 'x' }, 409)).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: 'The current version is 2.' }] })
    press = (await ok('engineer', 'PATCH', `/product/operations/${press.id}`, { version: press.version, code: 'op-press-2' })).operation
    expect(press).toMatchObject({ code: 'OP-PRESS-2', version: 2 })
    expect((await refused('engineer', 'PATCH', `/product/operations/${press.id}`, { version: 2, code: 'SEED-PACK' }, 409)).message).toBe('The operation code SEED-PACK is taken.')
  })

  it('archives (never deletes) and reactivates; an archived operation is read only and in no new routing step', async () => {
    press = (await ok('engineer', 'POST', `/product/operations/${press.id}/archive`, { version: press.version, reason: 'Replaced by the new press (made up).' })).operation
    expect(press).toMatchObject({ status: 'ARCHIVED', version: 3 })
    expect((await historyOf(press.id))[0]).toMatchObject({ action: 'product.operations.archive', before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }, reason: 'Replaced by the new press (made up).' })
    expect((await eventsOf(press.id)).at(-1)).toEqual({ type: 'operation.status_changed', payload: { operationId: press.id, code: 'OP-PRESS-2', status: 'ARCHIVED' } })
    expect((await refused('engineer', 'PATCH', `/product/operations/${press.id}`, { version: 3, skill: 'x' }, 409)).message).toBe('This operation is archived: reactivate it before changing it.')
    expect((await refused('engineer', 'POST', `/product/operations/${press.id}/archive`, { version: 3 }, 409)).code).toBe('invalid_state')
    const version = (await ok('developer', 'GET', `/product/styles/${jacket}/revisions/${revision1}/routing`)).routing.revision.version
    expect(
      (await refused('developer', 'POST', `/product/styles/${jacket}/revisions/${revision1}/routing/steps`, { version, operations: [{ operationId: press.id }] }, 400)).issues,
    ).toEqual([{ path: 'body/operations/0/operationId', message: 'Operation OP-PRESS-2 is archived: reactivate it, or choose another.' }])
    expect((await list('')).count).toBe(5)
    expect(codesOf(await list('?status=ARCHIVED'))).toEqual(['OP-PRESS-2'])
    press = (await ok('engineer', 'POST', `/product/operations/${press.id}/reactivate`, { version: 3 })).operation
    expect(press.status).toBe('ACTIVE')
    // No route deletes an operation, and the runtime role could not.
    expect((await call('engineer', 'DELETE', `/product/operations/${press.id}`)).statusCode).toBe(404)
    expect(await admin(`SELECT has_table_privilege('factory_runtime', 'public."Operation"', 'DELETE') AS office`)).toEqual([{ office: false }])
  })

  it('filters by search, kind, status, company and use; pages by code', async () => {
    expect(codesOf(await list('?q=press'))).toEqual(['OP-B-PRESS', 'OP-PRESS-2'])
    expect(codesOf(await list('?q=POST-BED'))).toEqual(['SEED-SEW-ASM'])
    expect(codesOf(await list('?kind=cutting,inspection'))).toEqual(['SEED-CUT-LEA', 'SEED-FIN-QC'])
    expect((await refused('engineer', 'GET', '/product/operations?kind=WELDING', undefined, 400)).code).toBe('validation_failed')
    expect(codesOf(await list('?usage=UNUSED'))).toEqual(['OP-B-PRESS', 'OP-PRESS-2'])
    expect(codesOf(await list('?usage=DIFFERS'))).toEqual(['SEED-SEW-ASM'])
    expect(codesOf(await list(`?companyId=${companyA}`))).toEqual(['OP-PRESS-2', 'SEED-CUT-LEA', 'SEED-FIN-QC', 'SEED-PACK', 'SEED-SEW-ASM'])
    const first = await list('?limit=2')
    expect(codesOf(first)).toEqual(['OP-B-PRESS', 'OP-PRESS-2'])
    const second = await list(`?limit=2&cursor=${first.nextCursor}`)
    expect(codesOf(second)).toEqual(['SEED-CUT-LEA', 'SEED-FIN-QC'])
    expect(second.count).toBe(6)
    expect((await refused('engineer', 'GET', '/product/operations?cursor=nonsense', undefined, 400)).issues).toEqual([{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
  })
})

describe('the tenant and company walls', () => {
  it('shows an operation only inside the tenant and the companies a grant reaches; one for every company is changed only by a grant over every company', async () => {
    expect(codesOf(await list('', 'companyA'))).not.toContain('OP-B-PRESS')
    expect((await call('companyA', 'GET', `/product/operations/${pressB.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/product/operations/${SEW}`)).statusCode).toBe(404)
    expect((await list('', 'otherTenant')).count).toBe(0)
    const tenantWide = await call('companyA', 'PATCH', `/product/operations/${CUT}`, { version: 1, skill: 'x' })
    expect(tenantWide.statusCode, tenantWide.body).toBe(403)
    expect(tenantWide.json().error.message).toBe('An operation for every company is changed only by a role over every company.')
    expect((await call('companyA', 'POST', '/product/operations', { code: 'OP-A-ALL', name: 'For all', workCentreKind: 'SEWING', standardMinutes: '1' })).statusCode).toBe(403)
    expect((await call('companyA', 'POST', '/product/operations', { companyId: companyB, code: 'OP-A-B', name: 'For B', workCentreKind: 'SEWING', standardMinutes: '1' })).statusCode).toBe(403)
    expect((await ok('companyA', 'POST', '/product/operations', { companyId: companyA, code: 'OP-A-ONLY', name: 'For A', workCentreKind: 'SEWING', standardMinutes: '1' }, 201)).operation.companyId).toBe(companyA)
    // Reading needs the routing permission, writing the library's.
    expect((await call('stylesOnly', 'GET', '/product/operations')).statusCode).toBe(403)
    expect((await call('developer', 'POST', '/product/operations', { code: 'OP-DEV', name: 'Dev', workCentreKind: 'SEWING', standardMinutes: '1' })).statusCode).toBe(403)
    expect((await call('developer', 'POST', `/product/operations/${CUT}/archive`, { version: 1 })).statusCode).toBe(403)
  })
})
