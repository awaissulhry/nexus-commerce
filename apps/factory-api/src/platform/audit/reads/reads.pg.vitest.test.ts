import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, addUser, startHarness, type Harness, type TestTenant, type TestUser } from '../../auth/sessions/testing/harness'
import { READ_LOG_RECORD_TYPES, READ_ROUTES } from './registry'
import { useReadLog } from './switch'

/**
 * Who looked (B-W2b-399; PLT-074; Owner answer W2b-6 question 3 = A) on the real app: a sensitive record opened by an office
 * person is one ReadLog row written before the answer leaves, a refused or missing one none, a file of a sensitive record a
 * DOWNLOAD of its record, an export made an EXPORT (command()'s ledgers); the switch off writes none. Read only by
 * administrators and the Owner over every company: one record's reads by name, one person's only with a reason that is itself
 * audited first. Rows, never a figure. Every route of the list is served; the list of record types is the database's.
 */

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let admin: TestUser
let clerk: TestUser
let certificateId: string

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const sessions = (): Record<string, SessionContext> => ({
  admin: { audience: 'office', tenantId: tenant.id, actorId: admin.id, grants: [grant(['audit.reads.view', 'compliance.certificates.view', 'compliance.certificates.manage'])] },
  clerk: { audience: 'office', tenantId: tenant.id, actorId: clerk.id, grants: [grant(['compliance.certificates.view'])] },
  'one-company': { audience: 'office', tenantId: tenant.id, actorId: admin.id, grants: [grant(['audit.reads.view'], [tenant.companies[0]!.id])] },
})
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload ? { payload } : {}) })
const reads = () =>
  h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: tenant.id }, (client) =>
    client.readLog.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { id: true, userId: true, recordType: true, recordId: true, action: true, surface: true } }),
  )

beforeAll(async () => {
  h = await startHarness('audit_reads')
  tenant = await addTenant(h, 'reads', 2)
  admin = await addUser(h, tenant, { email: 'admin.reads@example.com' })
  clerk = await addUser(h, tenant, { email: 'clerk.reads@example.com' })
  const all = sessions()
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => all[String(request.headers['x-test-session'])] ?? null) },
  )
  const made = await call('admin', 'POST', '/compliance/certificates', {
    companyId: tenant.companies[0]!.id,
    standard: 'EN 17092-4:2020',
    ppeClass: 'A',
    number: 'TEST-READS-0001',
    notifiedBodyName: 'Test Notified Body',
    notifiedBodyNumber: '0000',
    modelReference: 'TEST-JKT-01',
    validFrom: '2026-01-15',
    validTo: '2030-12-31',
  })
  expect(made.statusCode, made.body).toBe(201)
  certificateId = made.json().certificate.id
}, 120_000)

afterEach(() => useReadLog(undefined))

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the list of sensitive routes', () => {
  it('every route of the list is served by the app, and its record types are exactly the database’s list', async () => {
    const served = new Set(app.factoryRouteManifest.routes().map(([key]) => key))
    for (const key of Object.keys(READ_ROUTES)) expect(served.has(key), key).toBe(true)
    const source = (await h.db.admin.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc WHERE proname = 'factory_read_log_record_type_ok'`)).rows[0]!.prosrc
    expect([...source.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]).sort()).toEqual([...READ_LOG_RECORD_TYPES].sort())
  })
})

describe('a sensitive record read is logged before the answer leaves', () => {
  it('a certificate opened: one VIEW row of the person; a refused, a missing one and its creation none', async () => {
    expect(await reads()).toEqual([])
    expect((await call('clerk', 'GET', `/compliance/certificates/${certificateId}`)).statusCode).toBe(200)
    expect(await reads()).toEqual([expect.objectContaining({ userId: clerk.id, recordType: 'Certificate', recordId: certificateId, action: 'VIEW', surface: 'OFFICE' })])
    expect((await call('one-company', 'GET', `/compliance/certificates/${certificateId}`)).statusCode).toBe(403)
    expect((await call('clerk', 'GET', `/compliance/certificates/${newId()}`)).statusCode).toBe(404)
    expect((await reads()).length).toBe(1)
  })

  it('the switch off: the read goes out, no row', async () => {
    useReadLog(false)
    expect((await call('clerk', 'GET', `/compliance/certificates/${certificateId}`)).statusCode).toBe(200)
    expect((await reads()).length).toBe(1)
  })

  it('a file of a sensitive record is a DOWNLOAD of its record; a file of another record is nobody’s read', async () => {
    const account = newId()
    await h.db.admin.query(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'r2-reads', 'Files (fake)', 'FAKE', 6000, 1000)`, [account, tenant.id])
    const file = (recordType: string, recordId: string) => {
      const id = newId()
      return h.db.admin
        .query(
          `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status)
           VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', 'test.pdf', 'application/pdf', 10, $8, $6, $7, 'PENDING_UPLOAD')`,
          [id, tenant.id, tenant.companies[0]!.id, recordType, recordId, account, `t/${tenant.id}/test/${id}`, '0'.repeat(64)],
        )
        .then(() => id)
    }
    const certificateFile = await file('Certificate', certificateId)
    const companyFile = await file('Company', tenant.companies[0]!.id)
    const targets = (fileId: string) => h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: clerk.id }, (client) => READ_ROUTES['GET /files/:fileId/download']!.targets({ fileId }, client))
    expect(await targets(certificateFile)).toEqual([{ recordType: 'Certificate', recordId: certificateId }])
    expect(await targets(companyFile)).toEqual([])
    expect(await targets(newId())).toEqual([])
  })

  it('an export made by an office person is an EXPORT read (and an EXPORT security event), in the export’s own command', async () => {
    const jobId = newId()
    const context = { audience: 'office' as const, tenantId: tenant.id, actorId: clerk.id, grants: [], requestId: 'test-export' }
    await command(callerFor(h.database, context), { name: 'exports.request', input: { listKey: 'admin.audit' } }, async (tools) => {
      tools.audit({ recordType: 'ExportJob', recordId: jobId, after: { listKey: 'admin.audit', format: 'CSV', status: 'QUEUED' } })
      return null
    })
    expect((await reads()).at(-1)).toMatchObject({ userId: clerk.id, recordType: 'ExportJob', recordId: jobId, action: 'EXPORT', surface: 'OFFICE' })
    const events = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: tenant.id }, (client) => client.securityEvent.findMany({ where: { kind: 'EXPORT' }, select: { actorId: true, recordType: true, recordId: true, details: true } }))
    expect(events).toEqual([{ actorId: clerk.id, recordType: 'ExportJob', recordId: jobId, details: { action: 'exports.request', listKey: 'admin.audit', format: 'CSV' } }])
  })
})

describe('who looked: administrators and the Owner only, rows never a figure', () => {
  it('one record’s reads, newest first, by name; paged; only over every company', async () => {
    expect((await call('clerk', 'GET', `/compliance/certificates/${certificateId}`)).statusCode).toBe(200)
    const answer = await call('admin', 'GET', `/audit/reads?recordType=Certificate&recordId=${certificateId}`)
    expect(answer.statusCode, answer.body).toBe(200)
    const body = answer.json()
    expect(Object.keys(body).sort()).toEqual(['nextBefore', 'reads'])
    expect(body.reads).toHaveLength(2)
    expect(body.reads[0]).toMatchObject({ action: 'VIEW', surface: 'OFFICE', reader: { id: clerk.id, name: 'clerk reads' } })
    const first = (await call('admin', 'GET', `/audit/reads?recordType=Certificate&recordId=${certificateId}&limit=1`)).json()
    const second = (await call('admin', 'GET', `/audit/reads?recordType=Certificate&recordId=${certificateId}&limit=1&before=${first.nextBefore}`)).json()
    expect([...first.reads, ...second.reads].map((read: { id: string }) => read.id)).toEqual(body.reads.map((read: { id: string }) => read.id))
    expect(second.nextBefore).toBeNull()
    expect((await call('one-company', 'GET', `/audit/reads?recordType=Certificate&recordId=${certificateId}`)).statusCode).toBe(403)
    expect((await call('clerk', 'GET', `/audit/reads?recordType=Certificate&recordId=${certificateId}`)).statusCode).toBe(403)
    // Only the record types of the list; a record is always named.
    expect((await call('admin', 'GET', `/audit/reads?recordType=Invoice&recordId=${certificateId}`)).statusCode).toBe(400)
    expect((await call('admin', 'GET', '/audit/reads?recordType=Certificate')).statusCode).toBe(400)
    // B-W2b-413: the switch as the screen says it, for the same people only.
    expect((await call('admin', 'GET', '/audit/reads/status')).json()).toEqual({ on: true })
    useReadLog(false)
    expect((await call('admin', 'GET', '/audit/reads/status')).json()).toEqual({ on: false })
    expect((await call('clerk', 'GET', '/audit/reads/status')).statusCode).toBe(403)
  })

  it('one person’s reads only with a reason, written first as an audit row on the person', async () => {
    expect((await call('admin', 'POST', '/audit/reads/person', { userId: clerk.id, reason: 'x' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/audit/reads/person', { userId: clerk.id })).statusCode).toBe(400)
    const answer = await call('admin', 'POST', '/audit/reads/person', { userId: clerk.id, reason: 'A complaint about a leaked certificate' })
    expect(answer.statusCode, answer.body).toBe(200)
    const body = answer.json()
    expect(Object.keys(body).sort()).toEqual(['nextBefore', 'person', 'reads'])
    expect(body.person).toEqual({ id: clerk.id, name: 'clerk reads' })
    expect(body.reads.map((read: { record: { type: string } }) => read.record.type).sort()).toEqual(['Certificate', 'Certificate', 'ExportJob'])
    const audited = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: tenant.id }, (client) => client.auditLog.findMany({ where: { action: 'audit.searchReadsOfPerson' }, select: { actorId: true, recordType: true, recordId: true, reason: true } }))
    expect(audited).toEqual([{ actorId: admin.id, recordType: 'User', recordId: clerk.id, reason: 'A complaint about a leaked certificate' }])
    expect((await call('admin', 'POST', '/audit/reads/person', { userId: newId(), reason: 'Nobody by this id' })).statusCode).toBe(404)
    expect((await call('one-company', 'POST', '/audit/reads/person', { userId: clerk.id, reason: 'Limited administrator' })).statusCode).toBe(403)
  })
})
