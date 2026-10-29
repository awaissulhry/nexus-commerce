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
 * Companies, sites and a site's structure in the Office (SCR-008, SCR-009), with the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login, so row-level security is real). Every name and code
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs admin/org`.
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
const user = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const ALL = ['companies.view', 'companies.manage', 'sites.view', 'sites.manage'] as const
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL)] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['companies.view', 'sites.view'])] },
  companiesOnly: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['companies.view'])] },
  // Manages companyA only: never a new company, never companyA2.
  scoped: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL, [companyA])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(ALL)] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = method === 'POST' ? 201 : 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

beforeAll(async () => {
  db = await migratedDatabase('admin_org')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const [tenantId, slug] of [
    [tenantA, 'org-a'],
    [tenantB, 'org-b'],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
  }
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'ORGA', 'Officina Prova S.r.l.'), ($3, $2, 'ORGA2', 'Seconda Prova S.r.l.')`, [companyA, tenantA, companyA2])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'ORGB', 'Altra Prova S.r.l.')`, [companyB, tenantB])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'PA1', 'Stabilimento Prova', 'PLANT')`, [siteA, tenantA, companyA])
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

describe('the companies and sites tree (SCR-008)', () => {
  it('lists the companies the caller sees, each with its sites and their active counts; never another tenant', async () => {
    const { companies } = await ok('viewer', 'GET', '/org/companies')
    expect(companies.map((company: Json) => company.code)).toEqual(['ORGA', 'ORGA2'])
    const a = companies.find((company: Json) => company.code === 'ORGA')
    expect(a.sites.map((site: Json) => [site.code, site.counts])).toEqual([['PA1', { lines: 0, stations: 0, workCentres: 0, devices: 0, printers: 0 }]])
    // Not ready to invoice: no VAT number, tax regime, address, PEC or SDI code.
    expect(a.invoicing.ready).toBe(false)
    expect(a.invoicing.issues.map((issue: Json) => issue.path).sort()).toEqual(['company/address', 'company/pec', 'company/regimeFiscale', 'company/vatNumber'])
    const other = await ok('admin-b', 'GET', '/org/companies')
    expect(other.companies.map((company: Json) => company.code)).toEqual(['ORGB'])
  })

  it('without sites.view the companies come without sites; a company-scoped grant sees its company only', async () => {
    const { companies } = await ok('companiesOnly', 'GET', '/org/companies')
    expect(companies.every((company: Json) => company.sites.length === 0)).toBe(true)
    const scoped = await ok('scoped', 'GET', '/org/companies')
    expect(scoped.companies.map((company: Json) => company.code)).toEqual(['ORGA'])
    expect((await call('scoped', 'GET', `/org/companies/${companyA2}`)).statusCode).toBe(404)
    expect((await call('admin', 'GET', `/org/companies/${companyB}`)).statusCode).toBe(404)
  })

  it('a new company needs companies.manage over every company and a free code', async () => {
    expect((await call('scoped', 'POST', '/org/companies', { code: 'NEWCO', legalName: 'Nuova Prova S.r.l.' })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/org/companies', { code: 'NEWCO', legalName: 'Nuova Prova S.r.l.' })).statusCode).toBe(403)
    const { company } = await ok('admin', 'POST', '/org/companies', { code: 'newco', legalName: 'Nuova Prova S.r.l.', vatNumber: 'IT12345670009' })
    expect([company.code, company.country, company.currency, company.status, company.version]).toEqual(['NEWCO', 'IT', 'EUR', 'ACTIVE', 1])
    expect((await call('admin', 'POST', '/org/companies', { code: 'NEWCO', legalName: 'Doppia' })).statusCode).toBe(409)
    const [row] = await admin('SELECT action, "recordType", after FROM "AuditLog" WHERE "recordId" = $1', [company.id])
    expect([row!.action, row!.recordType, row!.after.legalName]).toEqual(['org.createCompany', 'Company', 'Nuova Prova S.r.l.'])
  })
})

describe('a company record: legal & tax, e-invoicing, defaults (SCR-008)', () => {
  it('edits with the version read; the readiness follows the data; a stale version is a conflict', async () => {
    const { company } = await ok('admin', 'GET', `/org/companies/${companyA}`)
    const body = {
      version: company.version,
      vatNumber: 'IT12345670009',
      regimeFiscale: 'RF01',
      address: { line1: 'Via Prova 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'it' },
      sdiReceiverCode: 'abc1234',
      shareCapital: '10000.00',
      soleShareholder: true,
      fiscalYearStartMonth: 4,
    }
    const edited = (await ok('admin', 'PATCH', `/org/companies/${companyA}`, body)).company
    expect(edited.invoicing).toEqual({ ready: true, issues: [] })
    expect([edited.sdiReceiverCode, edited.address.country, edited.shareCapital, edited.fiscalYearStartMonth, edited.version]).toEqual(['ABC1234', 'IT', '10000.00', 4, company.version + 1])
    expect((await call('admin', 'PATCH', `/org/companies/${companyA}`, { version: company.version, tradeName: 'Vecchia' })).statusCode).toBe(409)
    const cleared = (await ok('admin', 'PATCH', `/org/companies/${companyA}`, { version: edited.version, address: null })).company
    expect(cleared.address).toBeNull()
    expect(cleared.invoicing.issues.map((issue: Json) => issue.path)).toEqual(['company/address'])
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'org.editCompany' ORDER BY at ASC LIMIT 1`, [companyA])
    expect([audit!.before.vatNumber, audit!.after.vatNumber]).toEqual([null, 'IT12345670009'])
  })

  it('refuses a change outside the caller scope and an archive while an active site remains', async () => {
    const { company } = await ok('admin', 'GET', `/org/companies/${companyA2}`)
    expect((await call('scoped', 'PATCH', `/org/companies/${companyA2}`, { version: company.version, tradeName: 'X' })).statusCode).toBe(404)
    const a = (await ok('admin', 'GET', `/org/companies/${companyA}`)).company
    const held = await call('admin', 'PATCH', `/org/companies/${companyA}`, { version: a.version, status: 'ARCHIVED' })
    expect(held.statusCode).toBe(409)
    expect(held.json().error.issues).toEqual([{ path: 'uses/sites', message: '1' }])
  })
})

describe("a site's structure: lines, work centres, stations (SCR-009)", () => {
  it('builds a line, a work centre and stations on it; the counts follow; codes are unique on the site', async () => {
    const { site } = await ok('scoped', 'POST', '/org/sites', { companyId: companyA, code: 'pa2', name: 'Magazzino Prova', kind: 'WAREHOUSE' })
    expect([site.code, site.timezone, site.counts.stations]).toEqual(['PA2', 'Europe/Rome', 0])
    expect((await call('scoped', 'POST', '/org/sites', { companyId: companyA2, code: 'PX', name: 'Fuori', kind: 'PLANT' })).statusCode).toBe(404)

    const { line } = await ok('admin', 'POST', `/org/sites/${siteA}/lines`, { code: 'L1', name: 'Linea cucito 1' })
    const { workCentre } = await ok('admin', 'POST', `/org/sites/${siteA}/work-centres`, { code: 'SEW', name: 'Cucito', kind: 'SEWING' })
    const { station } = await ok('admin', 'POST', `/org/sites/${siteA}/stations`, { code: 'SEW-01', name: 'Postazione 1', workCentreId: workCentre.id, lineId: line.id })
    await ok('admin', 'POST', `/org/sites/${siteA}/stations`, { code: 'BENCH-01', name: 'Banco 1', workCentreId: workCentre.id })
    expect((await call('admin', 'POST', `/org/sites/${siteA}/lines`, { code: 'L1', name: 'Doppia' })).statusCode).toBe(409)
    // A line of another site is refused.
    const otherLine = (await ok('admin', 'POST', `/org/sites/${site.id}/lines`, { code: 'L9', name: 'Altrove' })).line
    const wrong = await call('admin', 'POST', `/org/sites/${siteA}/stations`, { code: 'X-01', name: 'X', workCentreId: workCentre.id, lineId: otherLine.id })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues).toEqual([{ path: 'body/lineId', message: 'Expected an active line of this site.' }])

    const read = await ok('viewer', 'GET', `/org/sites/${siteA}`)
    expect(read.company.code).toBe('ORGA')
    expect(read.site.counts).toEqual({ lines: 1, stations: 2, workCentres: 1, devices: 0, printers: 0 })
    expect(read.stations.map((row: Json) => [row.code, row.lineId === line.id, row.devices])).toEqual([
      ['BENCH-01', false, 0],
      ['SEW-01', true, 0],
    ])

    // Archive is held while active stations use the line; move the station off it first.
    const heldLine = await call('admin', 'PATCH', `/org/lines/${line.id}`, { version: line.version, status: 'ARCHIVED' })
    expect([heldLine.statusCode, heldLine.json().error.issues]).toEqual([409, [{ path: 'uses/stations', message: '1' }]])
    const moved = (await ok('admin', 'PATCH', `/org/stations/${station.id}`, { version: station.version, lineId: null, name: 'Postazione uno' })).station
    expect([moved.lineId, moved.name]).toEqual([null, 'Postazione uno'])
    const archived = (await ok('admin', 'PATCH', `/org/lines/${line.id}`, { version: line.version, status: 'ARCHIVED' })).line
    expect(archived.status).toBe('ARCHIVED')
    const heldSite = await call('admin', 'PATCH', `/org/sites/${siteA}`, { version: read.site.version, status: 'ARCHIVED' })
    expect(heldSite.json().error.issues).toEqual([{ path: 'uses/stations', message: '2' }])

    expect((await call('viewer', 'POST', `/org/sites/${siteA}/lines`, { code: 'L2', name: 'Vietata' })).statusCode).toBe(403)
    expect((await call('admin-b', 'GET', `/org/sites/${siteA}`)).statusCode).toBe(404)
  })
})
