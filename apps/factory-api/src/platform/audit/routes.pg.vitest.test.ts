import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { fixedClock } from '@nexus/factory-domain/core/time'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { buildApp } from '../../core/app'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'

/**
 * GET /audit/:recordType/:recordId on the local stack, with the app's real routes (src/platform, src/modules): audit
 * rows written by command() are read back through factory_app, inside the tenant and the caller's grants.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const user = newId()
const recordId = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  reader: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'])] },
  'reader-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'], [companyOne])] },
  'reader-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(['audit.read'])] },
  'no-permission': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['sites.view'])] },
  floor: { audience: 'floor', tenantId: tenantA, actorId: user, siteId: newId(), deviceId: newId(), grants: [grant(['audit.read'])] },
}

const history = (session: string | undefined, url = `/audit/Site/${recordId}`) =>
  app.inject({ method: 'GET', url, headers: session ? { 'x-test-session': session } : {} })

/** One audited write on the record, at a given time, for a company (or none). */
async function write(at: string, companyId: string | null, tenantId = tenantA, action = 'sites.rename') {
  const context: RequestContext = { audience: 'office', tenantId, actorId: user, grants: [], requestId: newId() }
  await runCommand(callerFor(database, context), { name: action as 'sites.rename', input: { at } }, async ({ audit }) => {
    audit({ recordType: 'Site', recordId, companyId, before: { name: 'old' }, after: { name: at } })
    return null
  }, { ...COMMAND_SETTINGS, clock: fixedClock(at) })
}

beforeAll(async () => {
  db = await migratedDatabase('audit_route')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await write('2026-10-28T09:00:00.000Z', companyOne)
  await write('2026-10-28T10:00:00.000Z', companyTwo)
  await write('2026-10-28T11:00:00.000Z', null, tenantA, 'sites.archive')
  await write('2026-10-28T12:00:00.000Z', null, tenantB)
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

describe('GET /audit/:recordType/:recordId', () => {
  it('lists the record\'s audit rows of the caller\'s tenant, newest first, with who, when and what', async () => {
    const response = await history('reader')
    expect(response.statusCode).toBe(200)
    const { entries } = response.json() as { entries: Record<string, unknown>[] }
    expect(entries.map((entry) => entry.at)).toEqual(['2026-10-28T11:00:00.000Z', '2026-10-28T10:00:00.000Z', '2026-10-28T09:00:00.000Z'])
    expect(entries[0]).toEqual({
      id: expect.any(String),
      at: '2026-10-28T11:00:00.000Z',
      audience: 'OFFICE',
      actorId: user,
      deviceId: null,
      deviceTime: null,
      companyId: null,
      siteId: null,
      partyId: null,
      action: 'sites.archive',
      recordType: 'Site',
      recordId,
      before: { name: 'old' },
      after: { name: '2026-10-28T11:00:00.000Z' },
      reason: null,
      requestId: expect.any(String),
    })
    const other = (await history('reader-b')).json() as { entries: unknown[] }
    expect(other.entries).toHaveLength(1)
  })

  it('keeps to the companies the caller\'s grant reaches (rows without a company stay visible)', async () => {
    const { entries } = (await history('reader-one')).json() as { entries: { companyId: string | null }[] }
    expect(entries.map((entry) => entry.companyId)).toEqual([null, companyOne])
  })

  it('takes a limit', async () => {
    const { entries } = (await history('reader', `/audit/Site/${recordId}?limit=1`)).json() as { entries: unknown[] }
    expect(entries).toHaveLength(1)
    expect((await history('reader', `/audit/Site/${recordId}?limit=0`)).statusCode).toBe(400)
  })

  it('refuses without audit.read, to the floor and without a session, and checks its parameters', async () => {
    expect((await history('no-permission')).statusCode).toBe(403)
    expect((await history('floor')).statusCode).toBe(403)
    expect((await history(undefined)).statusCode).toBe(401)
    expect((await history('reader', '/audit/site/not-a-uuid')).statusCode).toBe(400)
  })
})
