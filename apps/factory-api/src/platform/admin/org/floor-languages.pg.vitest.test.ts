import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The floor languages of the sites (B-W2a-41; PLT-128), with the app's real routes on a throwaway database: every site
 * the reader sees with its languages, its active workers per language (only with workers.view) and its company's worker
 * notice in force; a language added only when that notice has it (text or PDF), removed only when no active worker
 * reads it; the site's version, the audit row from → to. Run: `node scripts/factory/run-pg-tests.mjs admin/org`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyA2 = newId()
const companyB = newId()
const siteA = newId()
const siteA2 = newId()
const siteB = newId()
const user = newId()
const notice = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['sites.view', 'sites.manage', 'workers.view'])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['sites.view'])] },
  scoped: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['sites.view', 'sites.manage'], [companyA2]), grant(['sites.view'], [companyA])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['companies.view'])] },
}

type Site = { id: string; code: string; locales: string[]; version: number; workers: Record<string, number> | null; notice: { label: string; locales: string[] } | null; canManage: boolean }
const admin = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows
const call = (session: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

beforeAll(async () => {
  db = await migratedDatabase('floor_languages')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  for (const [tenantId, slug] of [[tenantA, 'fl-a'], [tenantB, 'fl-b']] as const) await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'FLA', 'Officina Prova S.r.l.'), ($3, $2, 'FLA2', 'Seconda Prova S.r.l.')`, [companyA, tenantA, companyA2])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'FLB', 'Altra S.r.l.')`, [companyB, tenantB])
  for (const [id, tenantId, companyId, code] of [[siteA, tenantA, companyA, 'A1'], [siteA2, tenantA, companyA2, 'A2'], [siteB, tenantB, companyB, 'B1']] as const) {
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [id, tenantId, companyId, code])
  }
  // Company A's worker notice in force: Italian and English texts, a Romanian PDF-only language as a text here.
  await admin(`INSERT INTO "PrivacyNotice" (id, "tenantId", "companyId", kind, "versionNo", label) VALUES ($1, $2, $3, 'WORKER_FLOOR', 1, '2026-10')`, [notice, tenantA, companyA])
  for (const [locale, body] of [['it', 'Informativa di prova.'], ['en', 'A made-up notice.'], ['ro', 'O notă de probă.']] as const) {
    await admin(`INSERT INTO "PrivacyNoticeText" (id, "tenantId", "noticeId", locale, body, sha256) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), tenantA, notice, locale, body, sha(body)])
  }
  await admin(`UPDATE "PrivacyNotice" SET status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $2 WHERE id = $1`, [notice, user])
  for (const [locale, status] of [['it', 'ACTIVE'], ['it', 'ACTIVE'], ['en', 'ACTIVE'], ['en', 'INACTIVE']] as const) {
    await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", locale, status) VALUES ($1, $2, $3, $4, 'Worker', $5, $6)`, [newId(), tenantA, companyA, siteA, locale, status])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('GET /org/floor-languages', () => {
  it('lists the sites with their languages, the active workers per language and the worker notice in force', async () => {
    const response = await call('admin', 'GET', '/org/floor-languages')
    expect(response.statusCode).toBe(200)
    const sites = (response.json() as { sites: Site[] }).sites
    expect(sites.map((site) => site.code)).toEqual(['A1', 'A2'])
    expect(sites[0]).toMatchObject({ locales: ['it', 'en'], version: 1, workers: { it: 2, en: 1 }, notice: { label: '2026-10', locales: ['en', 'it', 'ro'] }, canManage: true })
    expect(sites[1]).toMatchObject({ locales: ['it', 'en'], workers: {}, notice: null })
  })

  it('shows workers only with workers.view, manage only where the grant reaches; another tenant never', async () => {
    const viewer = (await call('viewer', 'GET', '/org/floor-languages')).json() as { sites: Site[] }
    expect(viewer.sites.map((site) => [site.code, site.workers, site.canManage])).toEqual([['A1', null, false], ['A2', null, false]])
    const scoped = (await call('scoped', 'GET', '/org/floor-languages')).json() as { sites: Site[] }
    expect(scoped.sites.map((site) => [site.code, site.canManage])).toEqual([['A1', false], ['A2', true]])
    expect((await call('nobody', 'GET', '/org/floor-languages')).statusCode).toBe(403)
    expect((await call('admin', 'PUT', `/org/sites/${siteB}/floor-languages`, { version: 1, locales: ['it'] })).statusCode).toBe(404)
  })
})

describe('PUT /org/sites/:siteId/floor-languages', () => {
  it('adds a language the worker notice has; refuses one it lacks, and any while no notice is in force', async () => {
    const missing = await call('admin', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 1, locales: ['it', 'en', 'ur'] })
    expect(missing.statusCode).toBe(409)
    expect(missing.json().error.issues).toEqual([{ path: 'body/locales/2', message: expect.stringMatching(/no ur text or PDF/) }])
    const none = await call('admin', 'PUT', `/org/sites/${siteA2}/floor-languages`, { version: 1, locales: ['it', 'en', 'ro'] })
    expect(none.statusCode).toBe(409)
    expect(none.json().error.issues[0].message).toMatch(/No worker notice is in force/)

    const added = await call('admin', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 1, locales: ['it', 'en', 'ro'], reason: 'Romanian speakers on line 2' })
    expect(added.statusCode, added.body).toBe(200)
    expect((added.json() as { site: Site }).site).toMatchObject({ locales: ['it', 'en', 'ro'], version: 2 })
    const [audit] = await admin(`SELECT action, before, after, reason FROM "AuditLog" WHERE "recordType" = 'Site' AND "recordId" = $1`, [siteA])
    expect(audit).toEqual({ action: 'org.setFloorLanguages', before: { floorLocales: ['it', 'en'] }, after: { floorLocales: ['it', 'en', 'ro'], added: ['ro'], removed: [], notice: '2026-10' }, reason: 'Romanian speakers on line 2' })
    expect((await admin(`SELECT "floorLocales" FROM "Site" WHERE id = $1`, [siteA]))[0]).toEqual({ floorLocales: ['it', 'en', 'ro'] })
  })

  it('refuses to remove a language active workers read, a stale version, and a site out of the grant', async () => {
    const removing = await call('admin', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 2, locales: ['it', 'ro'] })
    expect(removing.statusCode).toBe(409)
    expect(removing.json().error.issues).toEqual([{ path: 'remove/en', message: expect.stringMatching(/^1 active worker of the site reads en/) }])
    expect((await call('admin', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 1, locales: ['it', 'en'] })).statusCode).toBe(409)
    expect((await call('scoped', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 2, locales: ['it', 'en'] })).statusCode).toBe(403)
    // The Romanian language nobody reads goes; the inactive English worker does not count.
    const removed = await call('admin', 'PUT', `/org/sites/${siteA}/floor-languages`, { version: 2, locales: ['it', 'en'] })
    expect(removed.statusCode).toBe(200)
    expect((removed.json() as { site: Site }).site).toMatchObject({ locales: ['it', 'en'], version: 3 })
  })

  it('refuses an empty list, a repeat and a code that is not ISO 639', async () => {
    expect((await call('admin', 'PUT', `/org/sites/${siteA2}/floor-languages`, { version: 1, locales: [] })).statusCode).toBe(400)
    const bad = await call('admin', 'PUT', `/org/sites/${siteA2}/floor-languages`, { version: 1, locales: ['it', 'it', 'english'] })
    expect(bad.statusCode).toBe(409)
    expect(bad.json().error.issues.map((issue: { path: string }) => issue.path)).toEqual(['body/locales/1', 'body/locales/2'])
  })
})
