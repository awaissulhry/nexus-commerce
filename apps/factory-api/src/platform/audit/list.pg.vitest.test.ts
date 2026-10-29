import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'

/**
 * GET /audit (B-W0-28, SCR-018): the log across records, newest first, scoped to the companies a grant reaches, with
 * its filters, its saved views and their counts, the office person's name and the floor device's name — never a floor
 * worker's (Owner answer W1) — and paging that neither repeats nor skips a row.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenant = newId()
const otherTenant = newId()
const companyOne = newId()
const companyTwo = newId()
const site = newId()
const person = newId()
const worker = newId()
const device = newId()
const series = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  auditor: { audience: 'office', tenantId: tenant, actorId: person, grants: [grant(['audit.read'])] },
  'auditor-two': { audience: 'office', tenantId: tenant, actorId: person, grants: [grant(['audit.read'], [companyTwo])] },
  other: { audience: 'office', tenantId: otherTenant, actorId: person, grants: [grant(['audit.read'])] },
  nobody: { audience: 'office', tenantId: tenant, actorId: person, grants: [grant(['numbering.view'])] },
}
const get = async (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
type Entry = { id: string; action: string; actorName: string | null; deviceName: string | null; audience: string; companyId: string | null; requestId: string; idempotencyKey: string | null }
type Page = { entries: Entry[]; nextBefore: string | null; counts: Record<string, number> | null }

async function row(minutesAgo: number, action: string, extra: Partial<{ audience: string; actorId: string; companyId: string | null; siteId: string | null; deviceId: string | null; recordType: string; recordId: string; requestId: string; tenantId: string; idempotencyKey: string }> = {}) {
  await db.admin.query(
    `INSERT INTO "AuditLog" (id, "tenantId", "companyId", "siteId", at, audience, "actorId", "deviceId", action, "recordType", "recordId", before, after, "requestId", "idempotencyKey")
     VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval, $6, $7, $8, $9, $10, $11, '{"status":"ACTIVE"}', '{"status":"CLOSED"}', $12, $13)`,
    [
      newId(),
      extra.tenantId ?? tenant,
      extra.companyId === undefined ? companyOne : extra.companyId,
      extra.siteId ?? null,
      String(minutesAgo),
      extra.audience ?? 'OFFICE',
      extra.actorId ?? person,
      extra.deviceId ?? null,
      action,
      extra.recordType ?? 'NumberSeries',
      extra.recordId ?? series,
      extra.requestId ?? `req-${minutesAgo}`,
      extra.idempotencyKey ?? null,
    ],
  )
}

beforeAll(async () => {
  db = await migratedDatabase('audit_list')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2), ($3, $4, $4)', [tenant, 'al-a', otherTenant, 'al-b'])
  for (const [index, companyId] of [companyOne, companyTwo].entries()) {
    await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenant, `al-${index}`])
  }
  await db.admin.query(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S1', 'Site one', 'PLANT')`, [site, tenant, companyOne])
  await db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName") VALUES ($1, $2, 'ada@example.com', 'Ada Demo')`, [person, tenant])
  await db.admin.query(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name) VALUES ($1, $2, $3, $4, 'Cutting tablet 2')`, [device, tenant, companyOne, site])
  await row(1, 'numbering.closeSeries', { requestId: 'req-close', idempotencyKey: 'key-1' })
  await row(2, 'numbering.createSeries', { requestId: 'req-close' })
  await row(3, 'roles.assign', { recordType: 'User', recordId: person, companyId: null })
  await row(4, 'auth.signIn', { recordType: 'User', recordId: person, companyId: null })
  await row(5, 'production.reportScan', { audience: 'FLOOR', actorId: worker, deviceId: device, siteId: site, recordType: 'Bundle', recordId: newId() })
  await row(6, 'org.editCompany', { companyId: companyTwo, recordType: 'Company', recordId: companyTwo })
  await row(7, 'files.delete', { recordType: 'StoredFile', recordId: newId() })
  await row(60 * 24 * 3, 'org.createCompany', { recordType: 'Company', recordId: companyOne })
  await row(2, 'org.editCompany', { tenantId: otherTenant, companyId: null, recordType: 'Company', recordId: newId() })
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

describe('GET /audit', () => {
  it('lists the tenant\'s writes newest first with the person\'s and the device\'s names, never a floor worker\'s', async () => {
    const response = await get('auditor', '/audit')
    expect(response.statusCode).toBe(200)
    const page = response.json() as Page
    expect(page.entries.map((entry) => entry.action)).toEqual(['numbering.closeSeries', 'numbering.createSeries', 'roles.assign', 'auth.signIn', 'production.reportScan', 'org.editCompany', 'files.delete', 'org.createCompany'])
    expect(page.entries[0]).toMatchObject({ actorName: 'Ada Demo', deviceName: null, requestId: 'req-close', idempotencyKey: 'key-1', before: { status: 'ACTIVE' }, after: { status: 'CLOSED' } })
    expect(page.entries[4]).toMatchObject({ audience: 'FLOOR', actorName: null, deviceName: 'Cutting tablet 2' })
    expect(page.nextBefore).toBeNull()
    expect(page.counts).toBeNull()
  })

  it('keeps to the companies a grant reaches (rows without a company stay); another tenant\'s never; the right is needed', async () => {
    const two = (await get('auditor-two', '/audit')).json() as Page
    expect(two.entries.map((entry) => entry.action)).toEqual(['roles.assign', 'auth.signIn', 'org.editCompany'])
    expect(((await get('other', '/audit')).json() as Page).entries).toHaveLength(1)
    expect((await get('nobody', '/audit')).statusCode).toBe(403)
  })

  it('filters by action, record, surface, company, request and time window', async () => {
    const actions = async (query: string) => ((await get('auditor', `/audit?${query}`)).json() as Page).entries.map((entry) => entry.action)
    expect(await actions('action=numbering.')).toEqual(['numbering.closeSeries', 'numbering.createSeries'])
    expect(await actions(`recordType=Company&recordId=${companyTwo}`)).toEqual(['org.editCompany'])
    expect(await actions('audience=FLOOR')).toEqual(['production.reportScan'])
    expect(await actions(`companyId=${companyTwo}`)).toEqual(['org.editCompany'])
    expect(await actions('requestId=req-close')).toEqual(['numbering.closeSeries', 'numbering.createSeries'])
    expect(await actions(`actorId=${worker}`)).toEqual(['production.reportScan'])
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString()
    expect(await actions(`from=${encodeURIComponent(from)}`)).not.toContain('org.createCompany')
    expect((await get('auditor', '/audit?action=Bad action')).statusCode).toBe(400)
  })

  it('answers the saved views and counts them over the same window', async () => {
    const view = async (name: string) => ((await get('auditor', `/audit?view=${name}`)).json() as Page).entries.map((entry) => entry.action)
    expect(await view('roles')).toEqual(['roles.assign'])
    expect(await view('access')).toEqual(['auth.signIn'])
    expect(await view('deletes')).toEqual(['numbering.closeSeries', 'files.delete'])
    expect(await view('settings')).toEqual(['numbering.closeSeries', 'numbering.createSeries', 'org.editCompany', 'org.createCompany'])
    const from = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const counted = (await get('auditor', `/audit?withCounts=true&from=${encodeURIComponent(from)}`)).json() as Page
    expect(counted.counts).toEqual({ roles: 1, access: 1, deletes: 2, settings: 3 })
  })

  it('pages newest first without repeating or skipping a row', async () => {
    const seen: string[] = []
    let before: string | null = null
    do {
      const query: string = before ? `limit=3&before=${before}` : 'limit=3'
      const page = (await get('auditor', `/audit?${query}`)).json() as Page
      seen.push(...page.entries.map((entry) => entry.id))
      before = page.nextBefore
    } while (before)
    expect(seen).toHaveLength(8)
    expect(new Set(seen).size).toBe(8)
    expect((await get('auditor', `/audit?before=${newId()}`)).statusCode).toBe(400)
  })
})
