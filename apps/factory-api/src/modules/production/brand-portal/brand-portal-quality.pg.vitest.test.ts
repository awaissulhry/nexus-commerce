import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { forbiddenKeysIn } from '@nexus/factory-domain/production-brand/portal-read'
import { NO_REPORT_YET, QUALITY_NOT_SHARED, REPORT_NOT_FOUND, SHARED_WORK_WORDS } from '@nexus/factory-domain/production-brand/quality-read'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { forgetProgress } from '../../sales/portal-orders/progress'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-19 — the quality of the customer's own goods (level QUALITY) and the inspection report PDF of a single-customer work order
 * (production plan §2 the brand wall, §4 "+ Quality & photos — single-brand work orders only"; 06-tree §0.5, P-ORD-quality; L8;
 * WALL-G02, WALL-G07; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as
 * the production unit, should be able to see it all. And manage it all as well.") on the local stack, through the real app, the
 * real portal sign-in by code and the real files routes (upload, Use on). The seeds up to shipping (brand A = the seeds' customer
 * P1), the production two-brand harness (brand B = the threads' second brand, SEED-SO-B001; a work order each; a legacy work order
 * mixing both), and here: B at + Quality & photos, A at + Gates & dates; final inspections on B's own work order (one passed with a
 * defect and an issued report, one still open), on the mixed one (failed, a report kept) and on A's (passed, a report kept); quality
 * releases on B's own cells, on B's and A's cells of the mixed work order, one taken back; in-process checks (first piece, end of
 * line, a roving check) on B's own and on the mixed work order; quality holds and production holds on B's, the mixed and A's work
 * orders with the office's notes; photos: one of B's work order carried to B's order and shared with B (Use on), one of A's carried
 * to A's order, one of the mixed work order refused onto B's order, a legacy copy of it on B's order anyway, one of B's order kept
 * for the office, and a shared document (no photo).
 *
 *   PW-P04  Quality & photos: results only of B's single-brand work order (never the mixed one's, never A's); per cell released and
 *           reversed pieces of B's own cells (the mixed work order's B cell counted, A's never); holds by reason code (never the
 *           office's note, never words meant for A, never A's hold); a photo is drawn only when shared with B AND its source is B's
 *           record or one of no customer; A's photo id → 404; the PDF route only for B's single-brand work order's decided
 *           inspection (the mixed one, A's, an open one, a wrong id: 404 as unknown); below QUALITY the section is not drawn (404)
 *   and     A (symmetric, once raised to QUALITY) reads its own work order's results and photo, never B's or the mixed one's; a role
 *           without production is refused; every answer B got holds no A marker, no office word and no forbidden key.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-portal/brand-portal-quality`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
const NS = 'pr19-brand-quality'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const SESSIONS = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Statements with the database's rules off, in one transaction (as the two-brand harness writes what the app would never make). */
async function replica(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query('SET LOCAL session_replication_role = replica')
    for (const statement of statements) await h.db.admin.query(statement.sql, statement.values ?? [])
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

const people = { alpha: 'anna.buyer@pr19-alpha.example.com', beta: 'bruno.production@pr19-beta.example.com', betaDesigner: 'dina.designer@pr19-beta.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

/** What B's portal people got: every answer, for the scans. */
const seenByB: { url: string; body: unknown }[] = []
let aMarkers: Marker[] = []
const OFFICE_WORDS = {
  inspectorName: 'Made-up Inspector Ilaria Fittizia',
  inspectorEmail: 'ilaria.inspector@pr19-office.example.com',
  inspectionNote: 'Made-up office note: inspected under the north window',
  defectNote: 'Made-up office note: operator seven again',
  reversalReason: 'Made-up office reason: the zip pull came loose',
  holdNote: 'Made-up office note: tannery Zeta lot 12',
  checkNote: 'Made-up office note: station 4 slow',
  alphaHoldWords: 'Made-up words meant for Alpha only',
  mixedDefect: 'T-PR19-MIX-DEFECT',
  alphaDefect: 'T-PR19-ALPHA-DEFECT',
  mixedInspection: 'T-PR19-INS-MIX',
  alphaInspection: 'T-PR19-INS-A1',
  alphaHoldCode: 'MISSING_CERTIFICATE',
}
const BETA_HOLD_WORDS = 'Made-up: we wait for the lining to arrive'
const office = { inspectorId: newId() }
const inspections = { beta: newId(), betaOpen: newId(), mixed: newId(), alpha: newId() }
const REPORT_BYTES = Buffer.from('%PDF-1.7 made-up inspection report of T-PR19-INS-B1 (the factory kept version 1)')
const photos = {} as Record<'betaSource' | 'betaCopy' | 'alphaSource' | 'alphaCopy' | 'mixedSource' | 'legacyCopy' | 'legacyCopyOfCopy' | 'officeOnly' | 'document', Json>

let counter = 0
/** A call of the office (every customer) through the office app. */
async function asOffice(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await officeApp.inject({ method, url, headers: { 'x-test-session': 'office.all', ...(method === 'GET' ? {} : { 'idempotency-key': `pr19-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** A file uploaded by the office through the real routes (announce, put in the local store, confirm). */
async function uploaded(name: string, record: { recordType: string; recordId: string }, kind: 'PHOTO' | 'DOCUMENT', bytes: Buffer, visibility?: string[]): Promise<Json> {
  const contentType = kind === 'PHOTO' ? 'image/jpeg' : 'application/pdf'
  const announced = await asOffice('POST', '/files', { companyId: w.companyId, kind, originalName: name, contentType, sizeBytes: bytes.length, sha256: sha(bytes), ...record, ...(visibility ? { visibility } : {}) })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await officeApp.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })).statusCode).toBe(200)
  const done = await asOffice('POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}
const jpeg = (text: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`made-up photo of the pr19 test: ${text}`)])

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

// fix-pr-2: a refusal's words without its own request id (every answer carries a fresh requestId): "the same words".
const refusalOf = (body: Json): Json => {
  const { requestId: _requestId, ...error } = (body.error ?? {}) as Json
  return error
}

async function get(who: keyof typeof people, url: string, status = 200): Promise<Json> {
  const answer = await browsers[who].get(url)
  if (who !== 'alpha') seenByB.push({ url, body: answer.response.headers['content-type']?.toString().includes('json') ? answer.body : answer.response.body })
  expect(answer.status, `${who} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(status)
  return answer.body as Json
}

const quality = (orderId: string) => `/portal/production/${orderId}/quality`
const reportOf = (orderId: string, inspectionId: string) => `/portal/production/${orderId}/quality/report/${inspectionId}`
const setLevel = (partyId: string, level: string) =>
  admin(`UPDATE "PortalSettings" SET "productionLevel" = $2::"ProductionShareLevel", "progressShared" = $3, version = version + 1 WHERE "partyId" = $1`, [partyId, level, level !== 'STATUS'])

beforeAll(async () => {
  h = await startHarness('pr19_brand_quality')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace: NS })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])

  // Both portals on; B at + Quality & photos, A at + Gates & dates (below QUALITY).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  await setLevel(ids.b, 'QUALITY')
  await setLevel(ids.a, 'GATES')

  // The office person who inspects, releases, takes back and holds (a name that must never reach a customer).
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, $5, $6)', [office.inspectorId, T, OFFICE_WORDS.inspectorEmail, OFFICE_WORDS.inspectorName, 'ACTIVE', 'OFFICE'])

  const cellsOf = async (workOrderId: string) => admin<{ id: string; size: string; partyId: string | null }>('SELECT id, size, "partyId" FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY size', [workOrderId])
  const betaCells = await cellsOf(w.b.workOrderId)
  const alphaCells = await cellsOf(w.a.workOrderId)
  const mixedCells = await cellsOf(w.mixed.workOrderId)
  const cell = (cells: readonly { id: string; size: string; partyId: string | null }[], size: string, partyId: string) => cells.find((row) => row.size === size && row.partyId === partyId)!.id
  const releases = { beta52: newId() }

  // Opened on `openedAt` (the read lists them in that order), decided on `decidedAt`.
  const inspection = (id: string, workOrderId: string, number: string, status: 'OPEN' | 'PASSED' | 'FAILED', openedAt: string, decidedAt: string | null) => ({
    sql: `INSERT INTO "Inspection" (id, "tenantId", "companyId", "siteId", "workOrderId", number, "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor",
            status, "inspectorUserId", "decidedAt", "signatureSha256", "computedResult", note, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 4, 3, 'II', 2.5, 4.0, 0, 1, $7::"InspectionStatus", $8, $9, $10, $11::"InspectionResult", $12, 1, $13, $13)`,
    values: [id, T, w.companyId, w.siteId, workOrderId, number, status, office.inspectorId, decidedAt ? new Date(decidedAt) : null, decidedAt ? 'a'.repeat(64) : null, status === 'OPEN' ? null : status === 'PASSED' ? 'PASS' : 'FAIL', OFFICE_WORDS.inspectionNote, new Date(openedAt)],
  })
  const defect = (inspectionId: string, workOrderId: string, defectClass: string, code: string, quantity: number) => ({
    sql: `INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, quantity, description, note, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6::"DefectClass", $7, $8, $9, $9, 1, now(), now())`,
    values: [newId(), T, w.siteId, workOrderId, inspectionId, defectClass, code, quantity, OFFICE_WORDS.defectNote],
  })
  const release = (id: string, workOrderId: string, cellId: string, inspectionId: string, quantity: number) => ({
    sql: `INSERT INTO "QualityRelease" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", quantity, "releasedById", "releasedAt", "signatureSha256", note, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    values: [id, T, w.companyId, w.siteId, workOrderId, cellId, inspectionId, quantity, office.inspectorId, new Date('2026-11-14T11:00:00.000Z'), 'b'.repeat(64), OFFICE_WORDS.inspectionNote],
  })
  const qualityHold = (workOrderId: string, reasonCode: string, placedAt: string, releasedAt: string | null) => ({
    sql: `INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", number, "subjectType", "subjectIds", "reasonCode", "reasonNote", status, "placedAt", "placedById", "releasedAt", "releasedById", note, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'WorkOrder', $6::uuid[], $7, $8, $9::"QualityHoldStatus", $10, $11, $12, $13, $8, 1, now(), now())`,
    values: [newId(), T, w.companyId, w.siteId, `T-PR19-HLD-${workOrderId.slice(-6)}-${reasonCode.slice(0, 3)}`, [workOrderId], reasonCode, OFFICE_WORDS.holdNote, releasedAt ? 'RELEASED' : 'ACTIVE', new Date(placedAt), office.inspectorId, releasedAt ? new Date(releasedAt) : null, releasedAt ? office.inspectorId : null],
  })
  const productionHold = (workOrderId: string, partyId: string | null, brandWords: string) => ({
    sql: `INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", note, "brandWords", status, "placedAt", "placedById", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'PRODUCTION', 'MATERIAL_MISSING', $7, $8, 'ACTIVE', $9, $10, 1, now(), now())`,
    values: [newId(), T, w.companyId, w.siteId, workOrderId, partyId, OFFICE_WORDS.holdNote, brandWords, new Date('2026-11-12T08:00:00.000Z'), office.inspectorId],
  })
  const check = (workOrderId: string, kind: string, outcome: string | null, decidedAt: string | null, pieces: number, defectivePieces: number) => ({
    sql: `INSERT INTO "InProcessCheck" (id, "tenantId", "companyId", "siteId", kind, status, outcome, "workOrderId", pieces, "defectivePieces", defects, "inspectorUserId", "decidedAt", note, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5::"InProcessCheckKind", $6::"InProcessCheckStatus", $7::"InProcessOutcome", $8, $9, $10, $10, $11, $12, $13, 1, now(), now())`,
    values: [newId(), T, w.companyId, w.siteId, kind, outcome ? 'DECIDED' : 'OPEN', outcome, workOrderId, pieces, defectivePieces, office.inspectorId, decidedAt ? new Date(decidedAt) : null, OFFICE_WORDS.checkNote],
  })
  await replica([
    inspection(inspections.beta, w.b.workOrderId, 'T-PR19-INS-B1', 'PASSED', '2026-11-13T08:00:00.000Z', '2026-11-14T10:00:00.000Z'),
    inspection(inspections.betaOpen, w.b.workOrderId, 'T-PR19-INS-B2', 'OPEN', '2026-11-15T08:00:00.000Z', null),
    inspection(inspections.mixed, w.mixed.workOrderId, OFFICE_WORDS.mixedInspection, 'FAILED', '2026-11-13T08:00:00.000Z', '2026-11-14T10:00:00.000Z'),
    inspection(inspections.alpha, w.a.workOrderId, OFFICE_WORDS.alphaInspection, 'PASSED', '2026-11-13T08:00:00.000Z', '2026-11-14T10:00:00.000Z'),
    defect(inspections.beta, w.b.workOrderId, 'MINOR', 'T-PR19-STITCH-SKIP', 1),
    defect(inspections.mixed, w.mixed.workOrderId, 'MAJOR', OFFICE_WORDS.mixedDefect, 2),
    defect(inspections.alpha, w.a.workOrderId, 'CRITICAL', OFFICE_WORDS.alphaDefect, 1),
    // B's own cells: 2 of size 50, 2 of size 52 (one taken back later); the mixed work order: B's size 52 cell 1, A's size 54 cell 1;
    // A's own cells: 2 of size 50.
    release(newId(), w.b.workOrderId, cell(betaCells, '50', ids.b), inspections.beta, 2),
    release(releases.beta52, w.b.workOrderId, cell(betaCells, '52', ids.b), inspections.beta, 2),
    release(newId(), w.mixed.workOrderId, cell(mixedCells, '52', ids.b), inspections.mixed, 1),
    release(newId(), w.mixed.workOrderId, cell(mixedCells, '54', ids.a), inspections.mixed, 1),
    release(newId(), w.a.workOrderId, cell(alphaCells, '50', ids.a), inspections.alpha, 2),
    {
      sql: `INSERT INTO "QualityReleaseReversal" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "releaseId", quantity, "reasonCode", reason, "reversedById", "reversedAt", "createdAt")
            VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'DEFECT_FOUND_LATER', $8, $9, $10, now())`,
      values: [newId(), T, w.companyId, w.siteId, w.b.workOrderId, cell(betaCells, '52', ids.b), releases.beta52, OFFICE_WORDS.reversalReason, office.inspectorId, new Date('2026-11-15T09:00:00.000Z')],
    },
    // Quality holds: B's own work order (active), the mixed one (released), A's (never B's to read).
    qualityHold(w.b.workOrderId, 'QUALITY_CHECK', '2026-11-13T08:00:00.000Z', null),
    qualityHold(w.mixed.workOrderId, 'SUPPLIER_CHECK', '2026-11-10T08:00:00.000Z', '2026-11-11T16:00:00.000Z'),
    qualityHold(w.a.workOrderId, OFFICE_WORDS.alphaHoldCode, '2026-11-09T08:00:00.000Z', null),
    // Our production holds: B's own work order (words for B), the mixed one (words typed for A only).
    productionHold(w.b.workOrderId, ids.b, BETA_HOLD_WORDS),
    productionHold(w.mixed.workOrderId, null, OFFICE_WORDS.alphaHoldWords),
    // In-process checks: B's own work order (first piece approved; end of line one pass, one fail; a roving check); the mixed one.
    check(w.b.workOrderId, 'FIRST_PIECE', 'APPROVED', '2026-11-05T09:00:00.000Z', 1, 0),
    check(w.b.workOrderId, 'END_OF_LINE', 'PASS', '2026-11-10T09:00:00.000Z', 10, 0),
    check(w.b.workOrderId, 'END_OF_LINE', 'FAIL', '2026-11-12T09:00:00.000Z', 5, 1),
    check(w.b.workOrderId, 'ROVING', 'RED', '2026-11-12T09:00:00.000Z', 3, 1),
    check(w.mixed.workOrderId, 'FIRST_PIECE', 'REJECTED', '2026-11-06T09:00:00.000Z', 1, 1),
  ])

  // The reports the factory kept (its own files of the inspections, the office's): B's passed one, the mixed and A's.
  for (const [inspectionId, number] of [
    [inspections.beta, 'T-PR19-INS-B1'],
    [inspections.mixed, OFFICE_WORDS.mixedInspection],
    [inspections.alpha, OFFICE_WORDS.alphaInspection],
  ] as const) {
    const bytes = inspectionId === inspections.beta ? REPORT_BYTES : Buffer.from(`%PDF-1.7 made-up report ${number}`)
    const file = await uploaded(`inspection-report-${number}-en.pdf`, { recordType: 'Inspection', recordId: inspectionId }, 'DOCUMENT', bytes)
    await replica([
      {
        sql: `INSERT INTO "GeneratedDocument" (id, "tenantId", "companyId", "siteId", "recordType", "recordId", kind, version, fingerprint, language, number, "fileId", "createdAt", "createdById")
              VALUES ($1, $2, $3, $4, 'Inspection', $5, 'INSPECTION_REPORT', 1, $6, 'en', $7, $8, $9, $10)`,
        values: [newId(), T, w.companyId, w.siteId, inspectionId, sha(bytes), number, file.id, new Date('2026-11-14T12:00:00.000Z'), office.inspectorId],
      },
    ])
  }

  // Photos. B's work order's photo carried to B's order and shared with B; A's likewise to A's order.
  photos.betaSource = await uploaded('Beta jacket front.jpg', { recordType: 'WorkOrder', recordId: w.b.workOrderId }, 'PHOTO', jpeg('beta front'))
  const betaCopy = await asOffice('POST', `/files/${photos.betaSource.id}/use-on`, { recordType: 'SalesOrder', recordId: w.b.salesOrderId, visibility: ['OFFICE', 'PARTNER'] })
  expect(betaCopy.status, JSON.stringify(betaCopy.body)).toBe(201)
  photos.betaCopy = betaCopy.body.file
  photos.alphaSource = await uploaded('Alpha jacket front.jpg', { recordType: 'WorkOrder', recordId: w.a.workOrderId }, 'PHOTO', jpeg('alpha front'))
  const alphaCopy = await asOffice('POST', `/files/${photos.alphaSource.id}/use-on`, { recordType: 'SalesOrder', recordId: w.a.salesOrderId, visibility: ['OFFICE', 'PARTNER'] })
  expect(alphaCopy.status, JSON.stringify(alphaCopy.body)).toBe(201)
  photos.alphaCopy = alphaCopy.body.file
  // The mixed work order's photo is refused onto B's order (B-TH-024's wall); a legacy copy of it sits there anyway (made before).
  photos.mixedSource = await uploaded('Mixed lot table.jpg', { recordType: 'WorkOrder', recordId: w.mixed.workOrderId }, 'PHOTO', jpeg('mixed lot'))
  const refused = await asOffice('POST', `/files/${photos.mixedSource.id}/use-on`, { recordType: 'SalesOrder', recordId: w.b.salesOrderId, visibility: ['OFFICE', 'PARTNER'] })
  expect(refused.status, JSON.stringify(refused.body)).toBe(409)
  expect(refused.body.error.issues[0].path).toBe('refusal/OTHER_PARTY')
  photos.legacyCopy = { id: newId(), originalName: 'Made-up legacy copy of the mixed lot.jpg' }
  await replica([
    {
      sql: `INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', $1::uuid, 'sourceFileId', $2::uuid, 'originalName', $3::text, 'storageKey', $4::text))).* FROM "StoredFile" f WHERE f.id = $5`,
      values: [photos.legacyCopy.id, photos.mixedSource.id, photos.legacyCopy.originalName, `t/${T}/c/${w.companyId}/2026/${newId()}`, photos.betaCopy.id],
    },
  ])
  // fix-pr-2: a copy of that legacy copy, on B's order too — its source is B's own record, its source's source the mixed lot (two hops).
  photos.legacyCopyOfCopy = { id: newId(), originalName: 'Made-up copy of the legacy copy.jpg' }
  await replica([
    {
      sql: `INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', $1::uuid, 'sourceFileId', $2::uuid, 'originalName', $3::text, 'storageKey', $4::text))).* FROM "StoredFile" f WHERE f.id = $5`,
      values: [photos.legacyCopyOfCopy.id, photos.legacyCopy.id, photos.legacyCopyOfCopy.originalName, `t/${T}/c/${w.companyId}/2026/${newId()}`, photos.betaCopy.id],
    },
  ])
  // Kept for the office only, and a shared document (no photo).
  photos.officeOnly = await uploaded('Beta order office photo.jpg', { recordType: 'SalesOrder', recordId: w.b.salesOrderId }, 'PHOTO', jpeg('office only'))
  photos.document = await uploaded('Beta order shared document.pdf', { recordType: 'SalesOrder', recordId: w.b.salesOrderId }, 'DOCUMENT', Buffer.from('%PDF-1.7 made-up shared document'), ['OFFICE', 'PARTNER'])

  // The portals: company A's terms, and A's buyer, B's production person and B's designer, signed in.
  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.alpha, ids.a, ['customer-buyer'])
  await partnerPerson(people.beta, ids.b, ['customer-production'])
  await partnerPerson(people.betaDesigner, ids.b, ['customer-designer'])
  for (const person of Object.keys(people) as (keyof typeof people)[]) browsers[person] = await signedIn(people[person])

  aMarkers = [
    ...(await markersOf(h.db, ids.a)),
    { label: 'mixed work order', text: w.mixed.number },
    { label: 'mixed work order', text: w.mixed.workOrderId },
    { label: "B's work order", text: w.b.workOrderNumber },
    { label: "B's work order", text: w.b.workOrderId },
    ...Object.entries(OFFICE_WORDS).map(([label, text]) => ({ label: `office: ${label}`, text })),
    { label: 'office: inspector id', text: office.inspectorId },
    { label: 'mixed inspection id', text: inspections.mixed },
    { label: 'alpha inspection id', text: inspections.alpha },
    { label: 'alpha photo', text: photos.alphaCopy.id },
    { label: 'alpha photo', text: photos.alphaSource.id },
    { label: 'mixed photo', text: photos.mixedSource.id },
    { label: 'legacy copy', text: photos.legacyCopy.id },
    { label: 'legacy copy', text: photos.legacyCopy.originalName },
    { label: 'copy of the legacy copy', text: photos.legacyCopyOfCopy.id },
    { label: 'copy of the legacy copy', text: photos.legacyCopyOfCopy.originalName },
    { label: 'office-only photo', text: photos.officeOnly.id },
    { label: 'source of B photo', text: photos.betaSource.id },
  ]
}, 600_000)

beforeEach(() => {
  freshGuard(h)
  forgetProgress()
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await officeApp?.close()
  await h?.close()
}, 60_000)

describe('B-PR-19 Quality & photos (GET /portal/production/:orderId/quality) — PW-P04', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('per cell: released and taken-back pieces of B’s own cells only (the mixed work order’s B cell counted, A’s never), never above what B ordered', async () => {
    const read = await get('beta', quality(w.b.salesOrderId))
    expect(read).toMatchObject({ level: 'QUALITY', order: { id: w.b.salesOrderId, number: 'SEED-SO-B001' } })
    const line = read.lines.find((row: Json) => row.lineId === w.b.salesOrderLineId)
    expect(line.sizes).toEqual([
      { size: '50', ordered: 4, released: 2, reversed: 0 },
      { size: '52', ordered: 4, released: 3, reversed: 1 },
      { size: '54', ordered: 2, released: 0, reversed: 0 },
    ])
    expect(line).toMatchObject({ ordered: 10, released: 5, reversed: 1, style: { code: 'T-OWN-JKT-02' } })
    // Part of the line is made on the mixed work order: its results stay ours, in words that name nobody.
    expect(line).toMatchObject({ sharedWork: true, sharedWorkWords: SHARED_WORK_WORDS })
    // Only its own order's lines.
    expect(read.lines.every((row: Json) => row.lineId !== w.a.salesOrderLineId)).toBe(true)
    expect(forbiddenKeysIn(read)).toEqual([])
  })

  it('results only of B’s single-brand work order: its passed inspection (sampling, defects, the report issued) and the open one; never the mixed one’s, never A’s', async () => {
    const read = await get('beta', quality(w.b.salesOrderId))
    expect(read.finals.map((final: Json) => [final.inspectionId, final.state])).toEqual([
      [inspections.beta, 'PASSED'],
      [inspections.betaOpen, 'WAITING'],
    ])
    const [passed, open] = read.finals as Json[]
    expect(passed).toEqual({
      inspectionId: inspections.beta,
      number: 'T-PR19-INS-B1',
      state: 'PASSED',
      stateWords: { it: 'Superato', en: 'Passed' },
      decidedOn: '2026-11-14',
      lines: [900],
      sampling: { garments: 4, sample: 3, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4', acceptMajor: 0, acceptMinor: 1 },
      defects: { critical: 0, major: 0, minor: 1, found: [{ defectClass: 'MINOR', classWords: { it: 'Minore', en: 'Minor' }, code: 'T-PR19-STITCH-SKIP', words: null, garments: 1 }] },
      report: { version: 1, language: 'en', madeOn: '2026-11-14' },
    })
    // Still being recorded: no defects yet, no report.
    expect(open).toMatchObject({ state: 'WAITING', decidedOn: null, defects: null, report: null })
    const text = JSON.stringify(read)
    for (const word of [OFFICE_WORDS.mixedInspection, OFFICE_WORDS.alphaInspection, OFFICE_WORDS.mixedDefect, OFFICE_WORDS.alphaDefect, OFFICE_WORDS.inspectorName, OFFICE_WORDS.inspectionNote, OFFICE_WORDS.defectNote]) expect(text).not.toContain(word)
  })

  it('in-process checks of B’s own work order per kind (first piece, end of line); never a roving check, never the mixed one’s', async () => {
    const read = await get('beta', quality(w.b.salesOrderId))
    expect(read.checks).toEqual([
      { kind: 'FIRST_PIECE', words: { it: 'Primo capo', en: 'First piece' }, state: 'PASSED', stateWords: { it: 'Superato', en: 'Passed' }, passed: 1, failed: 0, waiting: 0, countWords: { it: '1 superato', en: '1 passed' }, pieces: 1, defectivePieces: 0, lastOn: '2026-11-05' },
      { kind: 'END_OF_LINE', words: { it: 'Controllo a fine linea', en: 'End-of-line check' }, state: 'FAILED', stateWords: { it: 'Non superato', en: 'Failed' }, passed: 1, failed: 1, waiting: 0, countWords: { it: '1 superato · 1 non superato', en: '1 passed · 1 failed' }, pieces: 15, defectivePieces: 1, lastOn: '2026-11-12' },
    ])
    expect(JSON.stringify(read)).not.toContain(OFFICE_WORDS.checkNote)
  })

  it('holds by reason code and words: B’s own and the mixed work order’s (never the words meant for A, never the note, never A’s hold)', async () => {
    const read = await get('beta', quality(w.b.salesOrderId))
    const holds = (read.holds as Json[]).map((hold) => [hold.kind, hold.code, hold.words.en, hold.since, hold.until, hold.active])
    expect(holds).toEqual(
      expect.arrayContaining([
        ['QUALITY', 'QUALITY_CHECK', 'Quality check', '2026-11-13', null, true],
        ['QUALITY', 'SUPPLIER_CHECK', 'Supplier check', '2026-11-10', '2026-11-11', false],
        ['PRODUCTION', 'MATERIAL_MISSING', BETA_HOLD_WORDS, '2026-11-12', null, true],
        ['PRODUCTION', 'MATERIAL_MISSING', 'Material missing', '2026-11-12', null, true],
      ]),
    )
    expect(holds).toHaveLength(4)
    const text = JSON.stringify(read.holds)
    for (const word of [OFFICE_WORDS.alphaHoldCode, OFFICE_WORDS.alphaHoldWords, OFFICE_WORDS.holdNote, OFFICE_WORDS.inspectorName]) expect(text).not.toContain(word)
  })

  it('photos: only the one shared with B whose source is B’s own work order; never the legacy copy of the mixed lot (nor a copy of it), the office’s, a document or A’s', async () => {
    const read = await get('beta', quality(w.b.salesOrderId))
    // fix-pr-2: every hop of a copy's sources is followed (platform/files/content-wall): the copy of the legacy copy is not drawn.
    expect(read.photos).toEqual([{ id: photos.betaCopy.id, name: 'Beta jacket front.jpg', contentType: 'image/jpeg', sizeBytes: photos.betaSource.sizeBytes, sharedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }])
    // A's photo id (its copy and its source) is as unknown to B as a wrong id.
    for (const fileId of [photos.alphaCopy.id, photos.alphaSource.id, photos.mixedSource.id, photos.officeOnly.id]) {
      const answer = await browsers.beta.get(`/files/${fileId}`)
      seenByB.push({ url: `/files/${fileId}`, body: answer.body })
      expect(answer.status, fileId).toBe(404)
    }
    // B opens its own shared photo.
    expect((await get('beta', `/files/${photos.betaCopy.id}`)).file.id).toBe(photos.betaCopy.id)
  })

  it('another customer’s order is as unknown as a wrong id (404, the same words); a role without production is refused (403)', async () => {
    const foreign = await browsers.beta.get(quality(w.a.salesOrderId))
    seenByB.push({ url: 'A order quality', body: foreign.body })
    const unknown = await browsers.beta.get(quality(newId()))
    expect([foreign.status, unknown.status]).toEqual([404, 404])
    expect(refusalOf(foreign.body)).toEqual(refusalOf(unknown.body))
    await get('betaDesigner', quality(w.b.salesOrderId), 403)
    await get('betaDesigner', reportOf(w.b.salesOrderId, inspections.beta), 403)
  })

  it('below QUALITY the section is not drawn (404 in its words); A at + Gates & dates reads no quality of its own order', async () => {
    expect((await get('alpha', quality(w.a.salesOrderId), 404)).error.message).toBe(QUALITY_NOT_SHARED)
    await setLevel(ids.b, 'GATES')
    try {
      expect((await get('beta', quality(w.b.salesOrderId), 404)).error.message).toBe(QUALITY_NOT_SHARED)
      expect((await get('beta', reportOf(w.b.salesOrderId, inspections.beta), 404)).error.message).toBe(QUALITY_NOT_SHARED)
      // The order's own read draws no quality section either.
      expect(await get('beta', `/portal/production/${w.b.salesOrderId}`)).not.toHaveProperty('quality')
    } finally {
      await setLevel(ids.b, 'QUALITY')
    }
  })

  it('symmetric: A raised to QUALITY reads its own work order’s results and photo, never B’s or the mixed one’s', async () => {
    await setLevel(ids.a, 'QUALITY')
    try {
      const read = await get('alpha', quality(w.a.salesOrderId))
      expect(read.finals.map((final: Json) => final.inspectionId)).toEqual([inspections.alpha])
      expect(read.photos.map((photo: Json) => photo.id)).toEqual([photos.alphaCopy.id])
      const text = JSON.stringify(read)
      for (const word of ['T-PR19-INS-B1', OFFICE_WORDS.mixedInspection, 'T-PR19-STITCH-SKIP', BETA_HOLD_WORDS, photos.betaCopy.id]) expect(text).not.toContain(word)
      expect((await browsers.alpha.get(reportOf(w.a.salesOrderId, inspections.beta))).status).toBe(404)
    } finally {
      await setLevel(ids.a, 'GATES')
    }
  })
})

describe('B-PR-19 the inspection report PDF (GET /portal/production/:orderId/quality/report/:inspectionId) — PW-P04', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('B’s single-brand work order’s passed inspection: the factory’s kept version, inline, as kept', async () => {
    const answer = await browsers.beta.get(reportOf(w.b.salesOrderId, inspections.beta))
    seenByB.push({ url: 'report B', body: answer.response.body })
    expect(answer.status, String(answer.response.body).slice(0, 300)).toBe(200)
    expect(String(answer.response.headers['content-type'])).toContain('application/pdf')
    expect(String(answer.response.headers['content-disposition'])).toMatch(/^inline; filename="inspection-report-T-PR19-INS-B1-en\.pdf"/)
    expect(String(answer.response.headers['cache-control'])).toBe('no-store')
    expect(sha(answer.response.rawPayload)).toBe(sha(REPORT_BYTES))
  })

  it('the mixed work order’s, A’s, an open one and a wrong id: 404 as one unknown report; under A’s order: the order is unknown', async () => {
    const bodies: unknown[] = []
    for (const inspectionId of [inspections.mixed, inspections.alpha, inspections.betaOpen, newId()]) {
      const answer = await browsers.beta.get(reportOf(w.b.salesOrderId, inspectionId))
      seenByB.push({ url: `report ${inspectionId}`, body: answer.body })
      expect(answer.status, inspectionId).toBe(404)
      expect(answer.body.error.message).toBe(REPORT_NOT_FOUND)
      bodies.push(answer.body)
    }
    expect(new Set(bodies.map((body) => JSON.stringify(refusalOf(body as Json)))).size).toBe(1)
    const foreign = await browsers.beta.get(reportOf(w.a.salesOrderId, inspections.alpha))
    seenByB.push({ url: 'report under A order', body: foreign.body })
    expect(foreign.status).toBe(404)
    expect(refusalOf(foreign.body)).toEqual(refusalOf((await browsers.beta.get(quality(newId()))).body))
  })

  it('a decided inspection of its own with no report kept yet: 404 in its own words', async () => {
    // The document rows never change for the app: the test moves B's kept version aside with the database's rules off.
    await replica([{ sql: `UPDATE "GeneratedDocument" SET "recordId" = $2 WHERE "recordId" = $1 AND kind = 'INSPECTION_REPORT'`, values: [inspections.beta, newId()] }])
    try {
      expect((await get('beta', reportOf(w.b.salesOrderId, inspections.beta), 404)).error.message).toBe(NO_REPORT_YET)
      expect((await get('beta', quality(w.b.salesOrderId))).finals[0].report).toBeNull()
    } finally {
      await replica([{ sql: `UPDATE "GeneratedDocument" SET "recordId" = $1 WHERE kind = 'INSPECTION_REPORT' AND number = 'T-PR19-INS-B1'`, values: [inspections.beta] }])
    }
  })
})

describe('B-PR-19 the wall over every answer B got (PW-P04, PW-15)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('no answer or file B got holds A’s names, codes, numbers or ids, the mixed lot, an office person or the office’s words', async () => {
    expect(seenByB.length).toBeGreaterThan(10)
    const found = seenByB.flatMap((answer) => findMarkers(answer.body, aMarkers).map((marker) => `${answer.url}: ${marker}`))
    expect(found).toEqual([])
    const keys = seenByB.flatMap((answer) => (answer.body && typeof answer.body === 'object' ? forbiddenKeysIn(answer.body).map((key) => `${answer.url}: ${key}`) : []))
    expect(keys).toEqual([])
  })
})
