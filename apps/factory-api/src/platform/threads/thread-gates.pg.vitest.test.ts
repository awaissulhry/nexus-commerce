import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFloorAuth } from '../../../../../packages/factory-db/seed/floor-auth'
import { seed as seedIntegration } from '../../../../../packages/factory-db/seed/integration'
import { seed as seedParties } from '../../../../../packages/factory-db/seed/parties'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addUser, startHarness, type Harness } from '../auth/sessions/testing/harness'
import { THREAD_GATES } from './records'

/**
 * B-TH-005 (threads plan TH-0, thread-G02; GDPR art. 4 inside the office): notes about a person stay with whoever may view the
 * person's record. A User's, Role's, Device's, Worker's, Team's and IntegrationAccount's thread asks the record's own view
 * permission beside threads.read (THREAD_GATES): a role that reads threads but not people (the sales office's) neither reads nor
 * writes there (not found: it learns nothing), while a party's thread stays open to it; the person who holds the view
 * permission reads and writes. With the app's real routes on a throwaway PostgreSQL 17 database. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads/thread-gates`.
 */

let h: Harness
let app: FastifyInstance
const NS = 'thread-gates'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const siteA1 = seedUuid(NS, 'site:A1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const actor = newId()
const THREADS: Permission[] = ['threads.read', 'threads.post']
const PEOPLE: Permission[] = ['users.view', 'roles.view', 'devices.view', 'workers.view', 'people.view', 'integrations.view']
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => ({ audience: 'office', tenantId: T, actorId: actor, grants: [grant(THREADS)] }),
  hr: () => ({ audience: 'office', tenantId: T, actorId: actor, grants: [grant([...THREADS, ...PEOPLE])] }),
}
let counter = 0
const call = (session: string, method: 'GET' | 'POST', url: string, body?: Json) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `gates-${++counter}-${newId()}` } : {}) }, ...(body === undefined ? {} : { payload: body }) })
/** One record of each gated type, and a party for the control. */
const records: Record<string, string> = {}

beforeAll(async () => {
  h = await startHarness('thread_gates')
  for (const seed of [seedCore, seedParties, seedFloorAuth, seedIntegration]) await seed({ db: h.database, namespace: NS })
  const first = async (sql: string) => (await admin<{ id: string }>(sql, [T]))[0]!.id
  records.User = (await addUser(h, { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }, { email: 'colleague@thread-gates.example' })).id
  records.Device = await first(`SELECT id::text AS id FROM "Device" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`)
  records.Worker = await first(`SELECT id::text AS id FROM "Worker" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`)
  records.IntegrationAccount = await first(`SELECT id::text AS id FROM "IntegrationAccount" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`)
  records.Team = newId()
  records.Role = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: actor }, async (client) => {
    await client.team.create({ data: { id: records.Team!, companyId: companyA, siteId: siteA1, code: 'GATE-T1', name: 'Made-up line team' }, select: { id: true } })
    await client.role.create({ data: { id: records.Role!, key: 'custom.gate_role', name: 'Made-up role', permissions: [] }, select: { id: true } })
  })
  records.Party = seedUuid(NS, 'party:P1')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const GATED = ['User', 'Role', 'Device', 'Worker', 'Team', 'IntegrationAccount'] as const

describe('B-TH-005 people records keep their notes private', () => {
  it('each people record type asks its own view permission beside threads.read', () => {
    expect(Object.fromEntries(GATED.map((type) => [type, THREAD_GATES[type]]))).toEqual({
      User: 'users.view',
      Role: 'roles.view',
      Device: 'devices.view',
      Worker: 'workers.view',
      Team: 'people.view',
      IntegrationAccount: 'integrations.view',
    })
  })

  it.each([...GATED])('%s: a person who may view the record writes and reads its notes; a role that reads threads but not the record reads nothing (not found) and writes nothing', async (type) => {
    const id = records[type]!
    const words = `A made-up note about this ${type}.`
    const posted = await call('hr', 'POST', `/threads/${type}/${id}/notes`, { body: words })
    expect(posted.statusCode, posted.body).toBe(201)
    const read = await call('hr', 'GET', `/threads/${type}/${id}`)
    expect(read.statusCode, read.body).toBe(200)
    expect(read.body).toContain(words)
    const hidden = await call('sales', 'GET', `/threads/${type}/${id}`)
    expect(hidden.statusCode, hidden.body).toBe(404)
    expect(hidden.body).not.toContain(words)
    expect((await call('sales', 'POST', `/threads/${type}/${id}/notes`, { body: 'Not mine to write.' })).statusCode).toBe(404)
    expect((await call('sales', 'GET', `/threads/${type}/${id}/timeline`)).statusCode).not.toBe(200)
  })

  it('a party’s thread stays open to a role that reads threads (the gate is for people records only)', async () => {
    const posted = await call('sales', 'POST', `/threads/Party/${records.Party}/notes`, { body: 'A made-up note about the customer.' })
    expect(posted.statusCode, posted.body).toBe(201)
    expect((await call('sales', 'GET', `/threads/Party/${records.Party}`)).statusCode).toBe(200)
  })
})
