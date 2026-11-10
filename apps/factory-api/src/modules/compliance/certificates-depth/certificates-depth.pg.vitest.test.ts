import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useCertificatesClock } from '../certificates/certificates'

/**
 * Certificates in depth (B-W2b-255) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login, so row-level security and B-W2b-216's guards are real), seeded with the core and the
 * compliance rules seeds (notified bodies 0000 — clothing and gloves — and 9999 — gloves only — plus an archived earlier
 * 0000; SEED-CERT-2161 the factory's base certificate, SEED-CERT-2162 the brand P1's own-brand certificate on it, the DRAFT
 * glove certificate SEED-CERT-2163 with levels 2 KP under body 9999; SEED-CERT-0002's protector coverage naming supplier P2
 * and "P2-SHD-L2"). Every name, code and person is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/compliance/certificates-depth`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'certificates-depth-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const lastId = (key: string): string => `ffffffff${seedId(key).slice(8)}`
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const partyP1 = seedId('party:P1')
const partyP2 = seedId('party:P2')
const partyP3 = seedId('party:P3')
const jacket = seedId('product:style:JKT-01')
const black = seedId('product:colourway:JKT-01:BLK')
const protector = seedId('product:item:protector')
const lining = seedId('product:item:lining')
const certJacket = seedId('compliance:certificate:JKT-01')
const certProtector = seedId('compliance:certificate:PRO-300')
const base = lastId('compliance-rules:certificate:SEED-CERT-2161')
const ownBrand = lastId('compliance-rules:certificate:SEED-CERT-2162')
const glove = lastId('compliance-rules:certificate:SEED-CERT-2163')
const body0000 = seedId('compliance-rules:body:0000')
const body9999 = seedId('compliance-rules:body:9999')

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.certificates.manage'
const clock: Clock = { now: () => new Date('2026-11-10T09:00:00.000Z') }
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant([VIEW, MANAGE, 'product.styles.view'])]),
  viewer: office([grant([VIEW])]),
  companyB: office([grant([VIEW, MANAGE], [companyB])]),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const depthOf = async (certificateId: string, session = 'manager'): Promise<Json> => (await ok(session, 'GET', `/compliance/certificates/${certificateId}/depth`)).depth

beforeAll(async () => {
  db = await migratedDatabase('certificates_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  useCertificatesClock(clock)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  useCertificatesClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the notified body directory (PRD-286)', () => {
  it('lists the active bodies with the clothing scope check and the certificates that name them', async () => {
    const { bodies, mayManage } = await ok('viewer', 'GET', '/compliance/notified-bodies')
    expect(mayManage).toBe(false)
    expect(bodies.map((body: Json) => [body.number, body.status, body.clothing.state])).toEqual([
      ['0000', 'ACTIVE', 'LISTED'],
      ['9999', 'ACTIVE', 'NOT_LISTED'],
    ])
    // 0000: the two typed W1 certificates and 2161, 2162 linked; 9999: the glove draft.
    expect(bodies[0]).toMatchObject({ nandoUrl: 'https://example.org/nando/0000', certificates: 4, linked: 2 })
    expect(bodies[1]).toMatchObject({ certificates: 1, linked: 1 })
    const all = await ok('manager', 'GET', '/compliance/notified-bodies?status=ALL')
    expect(all.mayManage).toBe(true)
    expect(all.bodies.map((body: Json) => body.status)).toEqual(['ACTIVE', 'ACTIVE', 'ARCHIVED'])
    const one = await ok('viewer', 'GET', `/compliance/notified-bodies/${body9999}`)
    expect(one.certificates.map((certificate: Json) => certificate.number)).toEqual(['SEED-CERT-2163'])
  })

  it('adds a body from its NANDO entry; refuses a twin number, bad fields, a viewer and a one-company manager, in words', async () => {
    const created = await ok('manager', 'POST', '/compliance/notified-bodies', { number: '1234', name: 'Demo Lab', address: 'Via Demo 1\n00100 Roma', country: 'it', nandoUrl: 'https://example.org/nando/1234', scopes: ['Regulation (EU) 2016/425 - equipment against mechanical impact', ''] }, 201)
    expect(created.body).toMatchObject({ number: '1234', country: 'IT', scopes: ['Regulation (EU) 2016/425 - equipment against mechanical impact'], clothing: { state: 'NOT_LISTED' }, version: 1 })
    expect((await refused('manager', 'POST', '/compliance/notified-bodies', { number: '0000', name: 'Twin', address: 'x', country: 'IT' }, 409)).message).toBe('Notified body 0000 is in the directory already (Seed Notified Body): edit that entry, or archive it first.')
    const invalid = await refused('manager', 'POST', '/compliance/notified-bodies', { number: '12', name: 'x', address: 'x', country: 'IT', nandoUrl: 'http://example.org' }, 400)
    expect(invalid.issues.map((issue: Json) => issue.path)).toEqual(['body/number', 'body/nandoUrl'])
    await refused('viewer', 'POST', '/compliance/notified-bodies', { number: '4321', name: 'x', address: 'x', country: 'IT' }, 403)
    expect((await refused('companyB', 'POST', '/compliance/notified-bodies', { number: '4321', name: 'x', address: 'x', country: 'IT' }, 403)).message).toBe('The notified body directory for every company is kept only by a role over every company.')
  })

  it('edits, archives and restores a body; never changes a linked number; a stale version is a 409, never a 500', async () => {
    const { bodies } = await ok('manager', 'GET', '/compliance/notified-bodies?q=1234')
    const demo = bodies[0]
    const edited = await ok('manager', 'PATCH', `/compliance/notified-bodies/${demo.id}`, { version: demo.version, scopes: ['Regulation (EU) 2016/425 - protective clothing'], contactEmail: 'lab@example.org' })
    expect(edited.body).toMatchObject({ clothing: { state: 'LISTED' }, contactEmail: 'lab@example.org', version: 2 })
    expect((await ok('manager', 'PATCH', `/compliance/notified-bodies/${demo.id}`, { version: 2, status: 'ARCHIVED' })).body.status).toBe('ARCHIVED')
    expect((await ok('manager', 'PATCH', `/compliance/notified-bodies/${demo.id}`, { version: 3, status: 'ACTIVE', number: '1235' })).body).toMatchObject({ status: 'ACTIVE', number: '1235' })
    await refused('manager', 'PATCH', `/compliance/notified-bodies/${demo.id}`, { version: 3, note: 'late' }, 409)
    const zero = (await ok('manager', 'GET', `/compliance/notified-bodies/${body0000}`)).body
    expect((await refused('manager', 'PATCH', `/compliance/notified-bodies/${body0000}`, { version: zero.version, number: '0001' }, 409)).message).toContain('its number never changes')
    // Restoring the archived 0000 entry while the active one exists: the twin rule in words.
    const archived = (await ok('manager', 'GET', '/compliance/notified-bodies?status=ARCHIVED')).bodies.find((body: Json) => body.number === '0000')
    expect((await refused('manager', 'PATCH', `/compliance/notified-bodies/${archived.id}`, { version: archived.version, status: 'ACTIVE' }, 409)).message).toContain('is in the directory already')
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'NotifiedBody' AND "recordId" = $1 ORDER BY at, id`, [demo.id])
    expect(audit.map((row) => row.action)).toEqual(['compliance.notifiedBodies.create', 'compliance.notifiedBodies.edit', 'compliance.notifiedBodies.edit', 'compliance.notifiedBodies.edit'])
  })
})

describe('a certificate in depth', () => {
  it('reads the glove draft: the five-year check, its body with the glove scope, its levels and marking', async () => {
    const depth = await depthOf(glove)
    expect(depth.certificate).toMatchObject({ number: 'SEED-CERT-2163', kind: 'GLOVE', status: 'DRAFT', registered: false })
    expect(depth.validity).toMatchObject({ state: 'OK', span: { years: 5, months: 0, days: 0 }, latest: '2031-03-01' })
    expect(depth.body.directory).toMatchObject({ id: body9999, number: '9999' })
    expect(depth.body.scope).toMatchObject({ state: 'LISTED', kind: 'GLOVE' })
    expect(depth.levels).toMatchObject({ family: 'EN13594', values: { level: '2', knuckle: 'KP' }, marking: '2KP', problems: [] })
    expect(depth.levels.properties.map((property: Json) => property.key)).toEqual(['level', 'knuckle'])
    expect(depth.mayManage).toBe(true)
    expect((await depthOf(glove, 'viewer')).mayManage).toBe(false)
  })

  it('sets glove levels in the vocabulary only (PRD-290)', async () => {
    const depth = await depthOf(glove)
    const bad = await refused('manager', 'PUT', `/compliance/certificates/${glove}/levels`, { version: depth.certificate.version, levels: { level: '3' } }, 400)
    expect(bad.issues).toEqual([{ path: 'body/levels/level', message: '"level" is 1 or 2 under EN 13594:2015, not "3".' }])
    const set = (await ok('manager', 'PUT', `/compliance/certificates/${glove}/levels`, { version: depth.certificate.version, levels: { level: '2', knuckle: '' } })).depth
    expect(set.levels).toMatchObject({ values: { level: '2' }, marking: '2' })
    expect(set.certificate.version).toBe(depth.certificate.version + 1)
    await refused('viewer', 'PUT', `/compliance/certificates/${glove}/levels`, { version: set.certificate.version, levels: null }, 403)
  })

  it("picks a draft's body from the directory (its number fills in); W1's edit of that typed number is refused in words, not a 500", async () => {
    const depth = await depthOf(glove)
    const picked = (await ok('manager', 'PUT', `/compliance/certificates/${glove}/notified-body`, { version: depth.certificate.version, notifiedBodyId: body0000 })).depth
    expect(picked.body.typed).toEqual({ name: 'Seed Notified Body', number: '0000' })
    expect(picked.body.directory.number).toBe('0000')
    // B-W1-12's PATCH of the typed number while the certificate names body 0000 (B-W2b-216's gap: it answered 500).
    const w1 = await refused('manager', 'PATCH', `/compliance/certificates/${glove}`, { version: picked.certificate.version, notifiedBodyNumber: '9999', notifiedBodyName: 'Seed Test Laboratory' }, 400)
    expect(w1.issues[0]).toMatchObject({ path: 'body/notifiedBodyNumber' })
    expect(w1.issues[0].message).toContain('names notified body 0000 from the directory')
    // An archived entry is not picked.
    const archived = (await ok('manager', 'GET', '/compliance/notified-bodies?status=ARCHIVED')).bodies.find((body: Json) => body.number === '0000')
    expect((await refused('manager', 'PUT', `/compliance/certificates/${glove}/notified-body`, { version: picked.certificate.version, notifiedBodyId: archived.id }, 409)).message).toBe('Notified body 0000 is archived: pick the active entry of the directory.')
    // Cleared (a draft), the typed number may change again.
    const cleared = (await ok('manager', 'PUT', `/compliance/certificates/${glove}/notified-body`, { version: picked.certificate.version, notifiedBodyId: null })).depth
    expect(cleared.body.directory).toBeNull()
    await ok('manager', 'PATCH', `/compliance/certificates/${glove}`, { version: cleared.certificate.version, notifiedBodyNumber: '9999', notifiedBodyName: 'Seed Test Laboratory' })
  })

  it('links a registered certificate to the body it was issued under, once', async () => {
    const depth = await depthOf(certJacket)
    expect(depth.certificate).toMatchObject({ number: 'SEED-CERT-0001', status: 'VALID', registered: true })
    expect(depth.body.directory).toBeNull()
    expect(depth.body.matching.map((body: Json) => body.id)).toEqual([body0000])
    expect((await refused('manager', 'PUT', `/compliance/certificates/${certJacket}/notified-body`, { version: depth.certificate.version, notifiedBodyId: body9999 }, 409)).message).toBe(
      "Certificate SEED-CERT-0001 was issued by notified body 0000 (as typed from it): the directory's body 9999 is another one.",
    )
    const linked = (await ok('manager', 'PUT', `/compliance/certificates/${certJacket}/notified-body`, { version: depth.certificate.version, notifiedBodyId: body0000 })).depth
    expect(linked.body).toMatchObject({ directory: { id: body0000 }, scope: { state: 'LISTED', kind: 'GARMENT' } })
    // The same body again: nothing changes, no command (and never a 500).
    expect((await ok('manager', 'PUT', `/compliance/certificates/${certJacket}/notified-body`, { version: linked.certificate.version, notifiedBodyId: body0000 })).depth.certificate.version).toBe(linked.certificate.version)
    expect((await refused('manager', 'PUT', `/compliance/certificates/${certJacket}/notified-body`, { version: linked.certificate.version, notifiedBodyId: null }, 409)).message).toContain('is filled in once and never changes after')
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY id`, [certJacket])
    expect(events.map((event) => event.type)).toContain('certificates_depth.certificate_detailed')
  })
})

describe('own-brand certificates (PRD-287)', () => {
  it("shows a brand's certificate on its base, and the brand certificates resting on the factory's", async () => {
    const own = await depthOf(ownBrand)
    expect(own.ownBrand).toMatchObject({ brandHeld: true, base: { id: base, number: 'SEED-CERT-2161' }, standing: { state: 'HOLDS' }, sameStandard: true, outlivesBaseDays: 0, candidates: [] })
    const factory = await depthOf(base)
    expect(factory.ownBrand).toMatchObject({ brandHeld: false, base: null })
    expect(factory.ownBrand.restingOnThis.map((certificate: Json) => certificate.number)).toEqual(['SEED-CERT-2162'])
  })

  it("rests a brand's draft on the factory's certificate; refuses a brand-held base and a company-held holder, in words", async () => {
    const { certificate } = await ok('manager', 'POST', '/compliance/certificates', { holderPartyId: partyP1, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'DEMO-OWN-0001', notifiedBodyName: 'Seed Notified Body', notifiedBodyNumber: '0000', validFrom: '2026-12-01', validTo: '2031-11-30' }, 201)
    const draft = await depthOf(certificate.id)
    expect(draft.ownBrand.brandHeld).toBe(true)
    expect(draft.ownBrand.candidates[0]).toMatchObject({ number: 'SEED-CERT-2161', standard: 'EN 17092-3:2020' })
    const onBrand = await refused('manager', 'PUT', `/compliance/certificates/${certificate.id}/base`, { version: draft.certificate.version, baseCertificateId: ownBrand }, 400)
    expect(onBrand.issues.map((issue: Json) => issue.path)).toEqual(['body/baseCertificateId', 'body/baseCertificateId'])
    const rested = (await ok('manager', 'PUT', `/compliance/certificates/${certificate.id}/base`, { version: draft.certificate.version, baseCertificateId: base })).depth
    expect(rested.ownBrand).toMatchObject({ base: { number: 'SEED-CERT-2161' }, standing: { state: 'HOLDS' } })
    const factory = await depthOf(base)
    expect((await refused('manager', 'PUT', `/compliance/certificates/${base}/base`, { version: factory.certificate.version, baseCertificateId: certJacket }, 400)).issues[0].message).toContain('Only an own-brand certificate, held by a brand')
  })

  it("makes the gate refuse what a brand's certificate covers while its base is suspended", async () => {
    const own = await depthOf(ownBrand)
    await ok('manager', 'POST', `/compliance/certificates/${ownBrand}/coverage`, { version: own.certificate.version, styleId: jacket }, 201)
    // SEED-CERT-0001 covers the jacket too: suspended, only the brand's certificate is left.
    const jacketCertificate = (await ok('manager', 'GET', `/compliance/certificates/${certJacket}`)).certificate
    await ok('manager', 'POST', `/compliance/certificates/${certJacket}/suspend`, { version: jacketCertificate.version, reason: 'Made up: suspended for the test.' })
    const ask = { styleId: jacket, colourwayId: black, size: '52', date: '2026-11-10' }
    expect((await ok('manager', 'POST', '/compliance/certificates/gate', ask)).certificate).toMatchObject({ number: 'SEED-CERT-2162' })
    const factory = (await ok('manager', 'GET', `/compliance/certificates/${base}`)).certificate
    await ok('manager', 'POST', `/compliance/certificates/${base}/suspend`, { version: factory.version, reason: 'Made up: the base is suspended.' })
    const answer = await ok('manager', 'POST', '/compliance/certificates/gate', ask)
    expect(answer).toMatchObject({ allowed: false, outcome: 'refused' })
    expect(answer.reasons.map((reason: Json) => reason.message)).toContain(
      "Certificate SEED-CERT-2162 (EN 17092-3:2020, notified body 0000) rests on the factory's certificate SEED-CERT-2161, which is suspended by the notified body.",
    )
    expect((await depthOf(ownBrand)).ownBrand.standing.state).toBe('SUSPENDED')
  })
})

describe('bought-in parts (QHS-106)', () => {
  it("shows the protector coverage's supplier and article code; answers the incoming check per supplier", async () => {
    const depth = await depthOf(certProtector)
    expect(depth.boughtIn).toEqual([expect.objectContaining({ item: expect.objectContaining({ id: protector }), supplier: { id: partyP2, name: expect.any(String) }, supplierArticleCode: 'P2-SHD-L2' })])
    expect(depth.levels).toMatchObject({ family: 'EN1621-1', values: null })
    const covered = await ok('viewer', 'GET', `/compliance/bought-in?itemId=${protector}&supplierPartyId=${partyP2}&on=2026-11-10`)
    expect(covered).toMatchObject({ state: 'COVERED', certificate: { number: 'SEED-CERT-0002' }, supplierArticleCode: 'P2-SHD-L2' })
    const other = await ok('viewer', 'GET', `/compliance/bought-in?itemId=${protector}&supplierPartyId=${partyP3}`)
    expect(other).toMatchObject({ state: 'OTHER_SUPPLIER', certificate: null, otherSuppliers: [{ id: partyP2 }] })
    expect((await ok('viewer', 'GET', `/compliance/bought-in?itemId=${lining}`)).state).toBe('NO_CERTIFICATE')
  })

  it('names a part\'s supplier once, only a supplier, only on a part', async () => {
    const depth = await depthOf(certProtector)
    const added = await ok('manager', 'POST', `/compliance/certificates/${certProtector}/coverage`, { version: depth.certificate.version, itemId: lining }, 201)
    const coverage = added.coverage
    const notSupplier = await refused('manager', 'PUT', `/compliance/certificates/${certProtector}/coverage/${coverage.id}/supplier`, { version: coverage.version, supplierPartyId: partyP3 }, 400)
    expect(notSupplier.issues).toEqual([{ path: 'body/supplierPartyId', message: 'The party is not one of our suppliers (it has no supplier role).' }])
    const named = (await ok('manager', 'PUT', `/compliance/certificates/${certProtector}/coverage/${coverage.id}/supplier`, { version: coverage.version, supplierPartyId: partyP2, supplierArticleCode: 'P2-LIN-01' })).depth
    expect(named.boughtIn.find((entry: Json) => entry.coverageId === coverage.id)).toMatchObject({ supplier: { id: partyP2 }, supplierArticleCode: 'P2-LIN-01', version: coverage.version + 1 })
    // The same supplier and code again: nothing changes (no command, never a 500).
    expect((await ok('manager', 'PUT', `/compliance/certificates/${certProtector}/coverage/${coverage.id}/supplier`, { version: coverage.version + 1, supplierPartyId: partyP2, supplierArticleCode: 'P2-LIN-01' })).depth.boughtIn.find((entry: Json) => entry.coverageId === coverage.id).version).toBe(coverage.version + 1)
    const again = await refused('manager', 'PUT', `/compliance/certificates/${certProtector}/coverage/${coverage.id}/supplier`, { version: coverage.version + 1, supplierPartyId: partyP1 }, 400)
    expect(again.issues[0].message).toContain('names its supplier once')
    expect((await ok('viewer', 'GET', `/compliance/bought-in?itemId=${lining}&supplierPartyId=${partyP2}`)).state).toBe('COVERED')
    // A style's coverage names no supplier.
    const jacketCoverage = (await admin<{ id: string; version: number }>(`SELECT id, version FROM "CertificateCoverage" WHERE "certificateId" = $1 AND "styleId" IS NOT NULL LIMIT 1`, [certJacket]))[0]!
    await refused('manager', 'PUT', `/compliance/certificates/${certJacket}/coverage/${jacketCoverage.id}/supplier`, { version: jacketCoverage.version, supplierPartyId: partyP2 }, 400)
  })

  it('keeps a company-B manager to company B (a certificate of company A is not theirs)', async () => {
    const depth = await depthOf(base)
    await refused('companyB', 'PUT', `/compliance/certificates/${base}/levels`, { version: depth.certificate.version, levels: null }, 404)
    expect(companyA).not.toBe(companyB)
  })
})
