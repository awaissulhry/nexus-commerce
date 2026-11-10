import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { keysOf, partnerForbiddenKey } from '@nexus/factory-domain/product/techpack/rules'
import { readTechPackCode } from '@nexus/factory-domain/product/techpack/scan'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seed as seedTechfiles } from '../../../../../../packages/factory-db/seed/techfiles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'

/**
 * The tech pack (B-W2b-230; PRD-130, PRD-131, PRD-133, PRD-134, PRD-136, PRD-138, PRD-147) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the generated documents'
 * guard are real), the harness's FAKE file store, on the seeds of the styles in depth, the measurement specs and protectors,
 * the work instructions and the technical files: SEED-JKT-01 (every company's, the brand SEED-C1's private label) revision 1
 * (DRAFT: pictures, a page with callouts, a pattern file, a draft spec, protectors per pocket) and SEED-JKT-02 (released, its
 * certificate and production control tests). Every code and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/techpack`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b230-techpack'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')

const MANAGER = ['product.bom.view', 'product.routing.view', 'product.styles.view', 'compliance.certificates.view', 'product.techpacks.make', 'money.cost', 'audit.read'] as Permission[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(MANAGER),
  // Reads the BOM only: no routing, no certificates, no cost grain, makes no PDF.
  viewer: office(['product.bom.view', 'product.styles.view'] as Permission[]),
  // Sees styles, not their BOM.
  sales: office(['product.styles.view'] as Permission[]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async <Row = Json>(sql: string, values: unknown[]): Promise<Row> => (await admin<Row>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `tp-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}

let jacket = ''
let rev1 = ''
let jacket2 = ''
let jacket2Rev = ''
let workshop = ''
let otherCustomer = ''
let brand = ''
const base = () => `/product/styles/${jacket}/revisions/${rev1}/tech-pack`

beforeAll(async () => {
  h = await startHarness('techpack')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedStylesDepth({ db: h.database, namespace: NS })
  await seedSizesDepth({ db: h.database, namespace: NS })
  await seedInstructions({ db: h.database, namespace: NS })
  await seedTechfiles({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  jacket = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
  rev1 = (await one<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jacket])).id
  jacket2 = (await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])).id
  jacket2Rev = (await one<{ id: string }>(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND status = 'RELEASED'`, [jacket2])).id
  workshop = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'SUBCONTRACTOR' = ANY(roles) AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [T])).id
  brand = (await one<{ id: string }>('SELECT "brandPartyId" AS id FROM "Style" WHERE id = $1', [jacket])).id
  otherCustomer = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'CUSTOMER' = ANY(roles) AND id <> $2 ORDER BY code LIMIT 1`, [T, brand])).id
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the live tech pack (PRD-130, PRD-134, PRD-136, PRD-147)', () => {
  it('shows the revision section by section for the office, with the costs of the cost grain', async () => {
    const { techPack } = await ok('manager', 'GET', `${base()}?companyId=${companyA}&language=en`)
    expect(techPack).toMatchObject({ audience: 'INTERNAL', language: 'en', style: { code: 'SEED-JKT-01', privateLabel: true, brand: { code: 'SEED-C1' } }, revision: { revision: 1, status: 'DRAFT' }, leftOut: [] })
    expect(techPack.banner).toMatch(/draft/)
    expect(techPack.sections.every((entry: Json) => entry.allowed && entry.included)).toBe(true)
    // Sketches: the style's pictures (not the pages); the page with its callouts is construction's.
    expect(techPack.sketches.length).toBeGreaterThan(0)
    expect(techPack.construction.pages[0].callouts.length).toBe(2)
    expect(techPack.construction.patterns.map((entry: Json) => entry.kind)).toContain('PATTERN')
    // The routing with its machine settings and the work instruction in force (company A's).
    expect(techPack.construction.steps.length).toBeGreaterThan(0)
    expect(techPack.construction.steps.some((step: Json) => step.instruction !== null)).toBe(true)
    expect(techPack.construction.steps[0]).toHaveProperty('standardMinutes')
    // The BOM by section; a cost on the lines whose material has a standard cost.
    expect(techPack.bom.lines).toBeGreaterThan(0)
    const lines = techPack.bom.sections.flatMap((section: Json) => section.lines)
    expect(lines.some((line: Json) => typeof line.unitCost === 'string')).toBe(true)
    expect(techPack.sizeSpec).toMatchObject({ status: 'DRAFT', approved: false, baseSize: '52' })
    expect(techPack.protection.placements.map((entry: Json) => entry.pocket)).toEqual(['SHOULDER', 'ELBOW', 'BACK'])
    expect(techPack.protection.classification.category).toBe('CATEGORY_II')
    expect(techPack.compliance.scope).toBe('every colourway and size')
    expect(techPack.revisionLog.map((entry: Json) => entry.revision)).toContain(1)
    expect(techPack.labels).toBeDefined()
  })

  it('leaves money, minutes, suppliers, alternates, approvals and names out of a partner copy, on the server', async () => {
    for (const audience of ['SUBCONTRACTOR', 'BRAND']) {
      const { techPack } = await ok('manager', 'GET', `${base()}?companyId=${companyA}&audience=${audience}`)
      expect([...keysOf(techPack)].filter(partnerForbiddenKey)).toEqual([])
      expect(techPack.leftOut.map((entry: Json) => entry.kind)).toEqual(expect.arrayContaining(['MONEY', 'MINUTES', 'SUPPLIERS']))
      expect(techPack.versions).toEqual([])
    }
  })

  it('shows a section the caller may not see as not allowed, and no cost without the grain', async () => {
    const { techPack } = await ok('viewer', 'GET', `${base()}?companyId=${companyA}`)
    expect(techPack.construction).toBeNull()
    expect(techPack.sections.find((entry: Json) => entry.section === 'CONSTRUCTION')).toMatchObject({ allowed: false, why: expect.stringMatching(/product\.routing\.view/) })
    expect([techPack.protection, techPack.compliance]).toEqual([null, null])
    expect(techPack.bom.sections.flatMap((section: Json) => section.lines).some((line: Json) => 'unitCost' in line)).toBe(false)
    // Who may not read the BOM does not read the tech pack.
    await no('sales', 'GET', base(), undefined, 403)
  })

  it('reads a released revision with its certificates and production control tests', async () => {
    const { techPack } = await ok('manager', 'GET', `/product/styles/${jacket2}/revisions/${jacket2Rev}/tech-pack?sections=PROTECTION,COMPLIANCE`)
    expect(techPack.revision.status).toBe('RELEASED')
    expect(techPack.banner).toBeNull()
    expect(techPack.protection.tests.length).toBeGreaterThan(0)
    expect(techPack.sections.filter((entry: Json) => entry.included).map((entry: Json) => entry.section)).toEqual(['PROTECTION', 'COMPLIANCE'])
    expect(techPack.bom).toBeNull()
  })
})

describe('the tech pack PDF (PRD-131, PRD-133) and its QR (PRD-138)', () => {
  let firstCode = ''
  let firstId = ''

  it('keeps a subcontractor copy as a generated document, with the QR code on every page and no money or supplier', async () => {
    const answer = await ok('manager', 'POST', `${base()}/pdf`, { audience: 'SUBCONTRACTOR', language: 'it', partyId: workshop, companyId: companyA }, 201)
    expect(answer.pdf).toMatchObject({ made: true, version: { version: 1, audience: 'SUBCONTRACTOR', language: 'it' } })
    expect(answer.pdf.address).toMatch(/\/tech-pack\/[0-9A-Z]{10}$/)
    firstCode = readTechPackCode(answer.pdf.address)!
    firstId = answer.pdf.version.id
    expect(answer.pdf.version.code).toBe(firstCode)
    const row = await one<Json>('SELECT kind::text AS kind, "recordType", layout, language, number, "siteId", "companyId", version FROM "GeneratedDocument" WHERE id = $1', [firstId])
    expect(row).toMatchObject({ kind: 'TECH_PACK', recordType: 'StyleRevision', layout: 'TECH_PACK_SUBCONTRACTOR/1', language: 'it', siteId: null, companyId: companyA, version: 1 })
    expect(row.number).toBe(`TP ${firstCode.slice(0, 5)}-${firstCode.slice(5)}`)
    // The PDF: one QR code per page (its printed code on each), the workshop's copy words, no supplier name, no cost.
    const response = await call('manager', 'GET', `${base()}/versions/${firstId}/pdf`)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/application\/pdf/)
    const text = pdfFlatText(response.rawPayload)
    const pages = (response.rawPayload.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
    expect(pages).toBeGreaterThan(1)
    expect(text.split(row.number).length - 1).toBe(pages)
    expect(text).toMatch(/Copia per il terzista/)
    const suppliers = await admin<{ name: string }>(`SELECT DISTINCT p."legalName" AS name FROM "BomLine" l JOIN "Party" p ON p.id = l."supplierId" WHERE l."revisionId" = $1`, [rev1])
    for (const supplier of suppliers) expect(text).not.toContain(supplier.name)
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'style.tech_pack_made' AND subject = $1`, [jacket])
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ generatedDocumentId: firstId, version: 1, audience: 'SUBCONTRACTOR', language: 'it', revision: 1 })])
    const audit = await one<Json>(`SELECT after FROM "AuditLog" WHERE action = 'product.techpack.make' AND "recordId" = $1`, [rev1])
    expect(audit.after).toMatchObject({ generatedDocumentId: firstId, audience: 'SUBCONTRACTOR', partyId: workshop })
  })

  it('makes no new version when nothing it says changed; another audience is its own version', async () => {
    const again = await ok('manager', 'POST', `${base()}/pdf`, { audience: 'SUBCONTRACTOR', language: 'it', partyId: workshop, companyId: companyA }, 200)
    expect(again.pdf).toMatchObject({ made: false, version: { id: firstId, version: 1 } })
    const internal = await ok('manager', 'POST', `${base()}/pdf`, { audience: 'INTERNAL', language: 'en', companyId: companyA }, 201)
    expect(internal.pdf.version).toMatchObject({ version: 2, audience: 'INTERNAL', language: 'en' })
    const { versions } = await ok('viewer', 'GET', `${base()}/versions`)
    expect(versions.map((entry: Json) => [entry.version, entry.audience])).toEqual([
      [2, 'INTERNAL'],
      [1, 'SUBCONTRACTOR'],
    ])
  })

  it('refuses a brand copy of a private-label style for another brand or without one, a section not the caller’s, and a maker without the right', async () => {
    const other = await no('manager', 'POST', `${base()}/pdf`, { audience: 'BRAND', language: 'en', partyId: otherCustomer, companyId: companyA }, 400)
    expect(other.issues).toEqual([{ path: 'body/partyId', message: expect.stringMatching(/another brand's private-label style/) }])
    const none = await no('manager', 'POST', `${base()}/pdf`, { audience: 'BRAND', language: 'en', companyId: companyA }, 400)
    expect(none.issues[0].message).toMatch(/say the brand/)
    const tenantWide = await no('manager', 'POST', `${base()}/pdf`, { audience: 'INTERNAL' }, 400)
    expect(tenantWide.issues).toEqual([{ path: 'body/companyId', message: expect.stringMatching(/every company's/) }])
    await no('viewer', 'POST', `${base()}/pdf`, { audience: 'INTERNAL', companyId: companyA }, 403)
    const brandCopy = await ok('manager', 'POST', `${base()}/pdf`, { audience: 'BRAND', language: 'en', partyId: brand, companyId: companyA, sections: ['COVER', 'BOM', 'SIZE_SPEC'] }, 201)
    expect(brandCopy.pdf.version).toMatchObject({ version: 3, audience: 'BRAND' })
  })

  it('says a scanned page is the newest of a draft, and that a newer version exists once the revision changed', async () => {
    const first = await ok('sales', 'GET', `/product/tech-packs/scan/${encodeURIComponent(`https://factory.example/tech-pack/${firstCode}`)}`)
    expect(first.scan).toMatchObject({ state: 'DRAFT', printed: { version: 1, revision: 1, audience: 'SUBCONTRACTOR', styleCode: 'SEED-JKT-01' }, newer: null })
    // The draft changes (a BOM line's placement), and the workshop gets a new copy: the old page says so.
    await admin(`UPDATE "BomLine" SET placement = 'Body (changed)' WHERE "revisionId" = $1 AND seq = (SELECT min(seq) FROM "BomLine" WHERE "revisionId" = $1)`, [rev1])
    const second = await ok('manager', 'POST', `${base()}/pdf`, { audience: 'SUBCONTRACTOR', language: 'it', partyId: workshop, companyId: companyA }, 201)
    expect(second.pdf.version.version).toBe(4)
    const scanned = await ok('sales', 'GET', `/product/tech-packs/scan/${firstCode.toLowerCase()}`)
    expect(scanned.scan).toMatchObject({ state: 'NEWER_VERSION', newer: { version: 4, revision: 1 } })
    expect(scanned.scan.words).toMatch(/version 4/)
    // An unknown code, or no code at all, is not found.
    await no('sales', 'GET', '/product/tech-packs/scan/0000000000', undefined, 404)
    await no('sales', 'GET', '/product/tech-packs/scan/not-a-code', undefined, 404)
  })
})
