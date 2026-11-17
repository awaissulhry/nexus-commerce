import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { SUPERVISOR_TAG_WORDS } from '@nexus/factory-domain/production-brand/supervisor'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { peopleTagsOf, registerPeopleTagger, taggedFirst, tagLanguageOf } from '../../../platform/threads/people-tags'
import { productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../testing/two-brands'
import { SUPERVISOR_TAGGER } from './threads-hooks'

/**
 * T7 / T8 (threads agreements 2026-11-17; production plan §3 "Supervisor"; review fix R-62): the production supervisor through the
 * threads' own hooks, registered by this module when its routes load (./threads-hooks) — and the wall (PW-14: a person is tagged
 * only where the list already holds him, a reader of that record). The Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations, the core, files, production and numbering seeds, the production
 * two-brand harness and its supervisor people (REAL users: supervisorA limited to A, backupA over every customer, officeB limited
 * to B); A's default supervisor is supervisorA, B's officeB (B-PR-42a's route).
 *
 *   - T7: a note's @ list (GET /threads/<type>/<id>/people) puts the record's production supervisor first, tagged in the reader's
 *     language ("Supervisore", "Supervisor" for an English reader), on a sales order and its work order; an order's own supervisor
 *     over the default; nobody tagged on a work order of no customer; another customer's supervisor never listed, never tagged;
 *     a writer limited to the other customer reads no list of A's records at all;
 *   - T8: a sales order's conversation is answered by its production supervisor after the thread's own owner (never on a work
 *     order: T8 is the sales order's);
 *   - the seam itself: tagged first in the list's order, a failing tagger skipped, the first tagger naming a person wins.
 *
 * The tests run in order on one database. Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/supervisor/threads-hooks`.
 */

const ns = 'pr2l-threads-hooks'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const PERMISSIONS: Permission[] = ['workorders.view', 'production.brand.manage', 'threads.read', 'threads.post']
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // backupA at his own screen (his session's id is his user's): the list's words in his language.
  'backup.self': { audience: 'office', tenantId: ids.tenantId, actorId: people.backupA, grants: [grant(PERMISSIONS, 'all')] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands

type Json = Record<string, any>
async function call(session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const settingsVersion = async (partyId: string) => (await admin<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))[0]?.version ?? 0

/** The @ list of a record, as the composer reads it. */
const peopleOf = async (session: string, type: string, id: string) => (await ok(session, 'GET', `/threads/${type}/${id}/people`)).people as Json[]
const tagged = (list: readonly Json[]) => list.filter((person) => person.tag !== undefined)
const headOf = async (type: string, id: string) => (await ok('office.all', 'GET', `/threads/${type}/${id}`)).head as Json

beforeAll(async () => {
  db = await migratedDatabase('pr2l_threads_hooks')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  await ok('office.all', 'PUT', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) })
  await ok('office.all', 'PUT', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the people-tag seam (T7)', () => {
  it('tagged people first, each group in the list’s order; a person without a tag carries none; the reader’s language', () => {
    const list = [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bea' }, { id: 'c', name: 'Cleo' }, { id: 'd', name: 'Dora' }]
    const tags = new Map([['c', SUPERVISOR_TAG_WORDS], ['b', { it: 'Altro', en: 'Other' }]])
    expect(taggedFirst(list, tags, 'it')).toEqual([{ id: 'b', name: 'Bea', tag: 'Altro' }, { id: 'c', name: 'Cleo', tag: 'Supervisore' }, { id: 'a', name: 'Ada' }, { id: 'd', name: 'Dora' }])
    expect(taggedFirst(list, tags, 'en')[1]).toEqual({ id: 'c', name: 'Cleo', tag: 'Supervisor' })
    expect(taggedFirst(list, new Map(), 'it')).toEqual(list)
    expect(tagLanguageOf('en-GB')).toBe('en')
    expect(tagLanguageOf('it')).toBe('it')
    expect(tagLanguageOf(null)).toBe('it')
    expect(SUPERVISOR_TAG_WORDS.it).toBeTruthy()
    expect(SUPERVISOR_TAG_WORDS.en).toBeTruthy()
  })

  it('a failing tagger is skipped; the first tagger that names a person wins; a removed tagger tags nobody', async () => {
    const record = { type: 'T7TestRecord', id: newId() }
    const removeBroken = registerPeopleTagger(record.type, 'broken', async () => {
      throw new Error('made-up failure')
    })
    const removeFirst = registerPeopleTagger(record.type, 'first', async () => new Map([['p1', { it: 'Primo', en: 'First' }]]))
    const removeSecond = registerPeopleTagger(record.type, 'second', async () => new Map([['p1', { it: 'Secondo', en: 'Second' }], ['p2', { it: 'Secondo', en: 'Second' }]]))
    try {
      const tags = await peopleTagsOf({} as never, record)
      expect(Object.fromEntries([...tags].map(([userId, words]) => [userId, words.en]))).toEqual({ p1: 'First', p2: 'Second' })
    } finally {
      removeBroken()
      removeFirst()
      removeSecond()
    }
    expect((await peopleTagsOf({} as never, record)).size).toBe(0)
    expect(SUPERVISOR_TAGGER).toBe('production.supervisor')
  })
})

describe('T7 the supervisor first in a note’s @ list', { timeout: 120_000 }, () => {
  it('A’s order and its work order: supervisorA first, tagged; nobody else tagged; B’s supervisor not listed', async () => {
    for (const [type, id] of [['SalesOrder', w.a.salesOrderId], ['WorkOrder', w.a.workOrderId]] as const) {
      const list = await peopleOf('office.all', type, id)
      expect(list[0], type).toEqual({ id: people.supervisorA, name: 'T Supervisor Alpha', tag: SUPERVISOR_TAG_WORDS.it })
      expect(tagged(list), type).toHaveLength(1)
      expect(list.map((person) => person.id), type).not.toContain(people.officeB)
    }
  })

  it('B’s order: officeB first, tagged; A’s supervisor never listed; a work order of no customer tags nobody', async () => {
    const list = await peopleOf('office.all', 'SalesOrder', w.b.salesOrderId)
    expect(list[0]).toEqual({ id: people.officeB, name: 'T Office Beta', tag: SUPERVISOR_TAG_WORDS.it })
    expect(list.map((person) => person.id)).not.toContain(people.supervisorA)
    expect(tagged(await peopleOf('office.all', 'WorkOrder', w.mixed.workOrderId))).toEqual([])
  })

  it('an order’s own supervisor over the customer’s default; back to the default', async () => {
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    try {
      const list = await peopleOf('office.all', 'SalesOrder', w.a.salesOrderId)
      expect(tagged(list)).toEqual([{ id: people.backupA, name: 'T Backup Alpha', tag: SUPERVISOR_TAG_WORDS.it }])
      expect(list[0]!.id).toBe(people.backupA)
    } finally {
      await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    }
    expect(tagged(await peopleOf('office.all', 'SalesOrder', w.a.salesOrderId)).map((person) => person.id)).toEqual([people.supervisorA])
  })

  it('the reader’s language: an English reader reads "Supervisor"', async () => {
    await admin(`UPDATE "User" SET locale = 'en' WHERE id = $1`, [people.backupA])
    try {
      expect((await peopleOf('backup.self', 'SalesOrder', w.a.salesOrderId))[0]).toEqual({ id: people.supervisorA, name: 'T Supervisor Alpha', tag: SUPERVISOR_TAG_WORDS.en })
    } finally {
      await admin(`UPDATE "User" SET locale = 'it' WHERE id = $1`, [people.backupA])
    }
  })

  it('PW-14: a writer limited to B reads no @ list of A’s records (not found), so no tag of A ever reaches him', async () => {
    for (const [type, id] of [['SalesOrder', w.a.salesOrderId], ['WorkOrder', w.a.workOrderId]] as const) {
      const refused = await call('office.p2', 'GET', `/threads/${type}/${id}/people`)
      expect(refused.status, `${type}: ${refused.raw}`).toBe(404)
      expect(refused.raw).not.toContain(people.supervisorA)
    }
    // B's own: its supervisor, tagged.
    expect((await peopleOf('office.p2', 'SalesOrder', w.b.salesOrderId))[0]).toMatchObject({ id: people.officeB, tag: SUPERVISOR_TAG_WORDS.it })
  })
})

describe('T8 a sales order’s owner: its production supervisor after the thread’s own', { timeout: 120_000 }, () => {
  it('the customer’s default, then an order’s own; the thread’s own owner first; never on a work order', async () => {
    expect((await headOf('SalesOrder', w.a.salesOrderId)).owner).toMatchObject({ id: people.supervisorA, source: 'SUPERVISOR' })
    expect((await headOf('SalesOrder', w.b.salesOrderId)).owner).toMatchObject({ id: people.officeB, source: 'SUPERVISOR' })
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: people.backupA })
    expect((await headOf('SalesOrder', w.a.salesOrderId)).owner).toMatchObject({ id: people.backupA, source: 'SUPERVISOR' })
    await ok('office.all', 'POST', '/production/orders/supervisor', { orderIds: [w.a.salesOrderId], supervisorId: null })
    // The thread's own owner comes first.
    expect((await ok('office.all', 'PUT', `/threads/SalesOrder/${w.a.salesOrderId}/owner`, { ownerId: people.backupA })).owner).toMatchObject({ id: people.backupA, source: 'SET' })
    expect((await ok('office.all', 'PUT', `/threads/SalesOrder/${w.a.salesOrderId}/owner`, { ownerId: null })).owner).toMatchObject({ id: people.supervisorA, source: 'SUPERVISOR' })
    // T8 is the sales order's: a work order's conversation keeps its own chain.
    expect((await headOf('WorkOrder', w.a.workOrderId)).owner?.source ?? null).not.toBe('SUPERVISOR')
  })
})
