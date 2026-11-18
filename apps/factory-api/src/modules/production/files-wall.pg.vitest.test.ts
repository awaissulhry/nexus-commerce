import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedInstructions, type InstructionsSeed } from '../../../../../packages/factory-db/seed/instructions'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { buildApp } from '../../core/app'
import { testAuthenticator } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * B-PR-08b — files of production records honour the brand (production plan §2 "files", PW-05 files; rides the threads files fix
 * B-TH-029, office file reads ask the RECORD's own scope from its thread resolver, and B-PR-44's record scope; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."), on the local stack through the real files routes: the production two-brand
 * harness (brand A = the seeds' P1, brand B = the threads' second brand; a work order each; a legacy work order mixing both), the
 * instructions seed (A's private-label work instruction, an operation's instruction on every style), and here a file on each
 * production record an office person may open from the generic files routes:
 *
 *   work order       A's, B's, the mixed one                  (thread resolver: its customer; mixed: every customer only)
 *   quality hold     on A's, on B's work order                (resolver: what it holds)
 *   NCR              on A's work order                        (resolver: what it names)
 *   inspection       on A's, on B's work order                (its work order's customer)
 *   defect, result   of A's inspection (their photos)         B-PR-08b: through the inspection's work order (named no one before)
 *   production hold  on A's, on the mixed work order          B-PR-08b: through the work order (a mixed one's hold named none)
 *   instruction      A's private label, every style           B-PR-08b: through its style (B-PR-37: walled by the brand)
 *
 *   PW-05 (files)  office.p2 (limited to B) lists none of A's or the mixed records' files and opens none by id, download or
 *                  preview (404 as a wrong id); B's open; office.p1 the mirror (never the mixed work order's either); the office
 *                  of every customer reads them all; Use on carries neither A's defect photo nor the mixed hold's file onto B's
 *                  order (409 refusal/OTHER_PARTY); nothing p2 got holds an A marker.
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/files-wall`.
 */

let h: Harness
let app: FastifyInstance
let w: ProductionTwoBrands
let instructions: InstructionsSeed
const NS = 'pr08b-files-wall'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const SESSIONS = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Statements with the database's rules off, in one transaction (records the app would make through its own screens). */
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

const seenByB: { url: string; body: unknown }[] = []
let counter = 0
async function call(session: keyof typeof SESSIONS, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `pr08b-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const parsed = response.headers['content-type']?.toString().includes('json') ? (response.json() as Json) : { raw: response.body }
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, body: parsed })
  return { status: response.statusCode, body: parsed }
}

/** A file uploaded by the office of every customer through the real routes (announce, put in the local store, confirm). */
async function uploaded(name: string, record: { recordType: string; recordId: string }): Promise<Json> {
  const bytes = Buffer.from(`%PDF-1.7 made-up production file of the pr08b test: ${name}`)
  const announced = await call('office.all', 'POST', '/files', { companyId: w.companyId, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...record })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: bytes })).statusCode).toBe(200)
  const done = await call('office.all', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}

/** The production records of the test, by name: whose they are, and the file on each. */
interface Case {
  readonly name: string
  readonly owner: 'A' | 'B' | 'MIXED' | 'EVERY'
  readonly recordType: string
  readonly recordId: string
  file?: Json
}
const cases: Case[] = []
const caseOf = (name: string): Case => cases.find((entry) => entry.name === name)!
let aMarkers: Marker[] = []

beforeAll(async () => {
  h = await startHarness('pr08b_files_wall')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedFiles, seedProduction, seedNumbering, seedReasons]) await seed({ db: h.database, namespace: NS })
  instructions = await seedInstructions({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app, namespace: NS })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  const brandOf = async (instructionId: string) => (await admin<{ brandPartyId: string | null }>(`SELECT s."brandPartyId" FROM "WorkInstruction" i JOIN "Style" s ON s.id = i."styleId" WHERE i.id = $1`, [instructionId]))[0]?.brandPartyId ?? null
  expect(await brandOf(instructions.instructionIds.revision)).toBe(ids.a)

  const made = { holdA: newId(), holdB: newId(), ncrA: newId(), inspectionA: newId(), inspectionB: newId(), defectA: newId(), resultA: newId(), plainHoldA: newId(), plainHoldMixed: newId() }
  const qualityHold = (id: string, workOrderId: string) => ({
    sql: `INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", number, "subjectType", "subjectIds", "reasonCode", status, "placedAt", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'WorkOrder', $6::uuid[], 'QUALITY_CHECK', 'ACTIVE', now(), 1, now(), now())`,
    values: [id, T, w.companyId, w.siteId, `T-PR08B-HLD-${id.slice(-6)}`, [workOrderId]],
  })
  const inspection = (id: string, workOrderId: string) => ({
    sql: `INSERT INTO "Inspection" (id, "tenantId", "companyId", "siteId", "workOrderId", number, "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor", status, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 4, 3, 'II', 2.5, 4.0, 0, 1, 'OPEN', 1, now(), now())`,
    values: [id, T, w.companyId, w.siteId, workOrderId, `T-PR08B-INS-${id.slice(-6)}`],
  })
  const productionHold = (id: string, workOrderId: string, partyId: string | null) => ({
    sql: `INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", status, "placedAt", "placedById", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'PRODUCTION', 'MATERIAL_MISSING', 'ACTIVE', now(), $7, 1, now(), now())`,
    values: [id, T, w.companyId, w.siteId, workOrderId, partyId, newId()],
  })
  await replica([
    qualityHold(made.holdA, w.a.workOrderId),
    qualityHold(made.holdB, w.b.workOrderId),
    {
      sql: `INSERT INTO "Nonconformance" (id, "tenantId", "companyId", "siteId", number, title, source, "foundAt", "foundOn", "quantityAffected", uom, severity, "workOrderId", version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'Made-up NCR of the pr08b test', 'INSPECTION', 'IN_LINE', now(), 1, 'PCS', 'MAJOR', $6, 1, now(), now())`,
      values: [made.ncrA, T, w.companyId, w.siteId, `T-PR08B-NCR-${made.ncrA.slice(-6)}`, w.a.workOrderId],
    },
    inspection(made.inspectionA, w.a.workOrderId),
    inspection(made.inspectionB, w.b.workOrderId),
    {
      sql: `INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, quantity, version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'MAJOR', 'T-PR08B-SEAM', 1, 1, now(), now())`,
      values: [made.defectA, T, w.siteId, w.a.workOrderId, made.inspectionA],
    },
    {
      sql: `INSERT INTO "InspectionCheckResult" (id, "tenantId", "siteId", "inspectionId", "planCheckId", outcome, version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'FAIL', 1, now(), now())`,
      values: [made.resultA, T, w.siteId, made.inspectionA, newId()],
    },
    productionHold(made.plainHoldA, w.a.workOrderId, ids.a),
    productionHold(made.plainHoldMixed, w.mixed.workOrderId, null),
  ])

  cases.push(
    { name: 'work order A', owner: 'A', recordType: 'WorkOrder', recordId: w.a.workOrderId },
    { name: 'work order B', owner: 'B', recordType: 'WorkOrder', recordId: w.b.workOrderId },
    { name: 'mixed work order', owner: 'MIXED', recordType: 'WorkOrder', recordId: w.mixed.workOrderId },
    { name: 'quality hold A', owner: 'A', recordType: 'QualityHold', recordId: made.holdA },
    { name: 'quality hold B', owner: 'B', recordType: 'QualityHold', recordId: made.holdB },
    { name: 'NCR A', owner: 'A', recordType: 'Nonconformance', recordId: made.ncrA },
    { name: 'inspection A', owner: 'A', recordType: 'Inspection', recordId: made.inspectionA },
    { name: 'inspection B', owner: 'B', recordType: 'Inspection', recordId: made.inspectionB },
    { name: 'defect of A', owner: 'A', recordType: 'InspectionDefect', recordId: made.defectA },
    { name: 'check result of A', owner: 'A', recordType: 'InspectionCheckResult', recordId: made.resultA },
    { name: 'production hold A', owner: 'A', recordType: 'WorkOrderHold', recordId: made.plainHoldA },
    { name: 'production hold of the mixed work order', owner: 'MIXED', recordType: 'WorkOrderHold', recordId: made.plainHoldMixed },
    { name: 'instruction of A’s private label', owner: 'A', recordType: 'WorkInstruction', recordId: instructions.instructionIds.revision },
    { name: 'instruction of every style', owner: 'EVERY', recordType: 'WorkInstruction', recordId: instructions.instructionIds.sewing },
  )
  for (const entry of cases) entry.file = await uploaded(`T-PR08B ${entry.name}.pdf`, { recordType: entry.recordType, recordId: entry.recordId })

  aMarkers = [
    ...(await markersOf(h.db, ids.a)),
    { label: 'mixed work order', text: w.mixed.number },
    { label: 'mixed work order', text: w.mixed.workOrderId },
    ...cases.filter((entry) => entry.owner === 'A' || entry.owner === 'MIXED').flatMap((entry) => [
      { label: `${entry.name}: file`, text: entry.file!.id as string },
      { label: `${entry.name}: file name`, text: entry.file!.originalName as string },
      { label: `${entry.name}: record`, text: entry.recordId },
    ]),
  ]
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

/** What the session reads of a record's files: its list, and the file by id, download and preview. */
// fix-pr-3: a refusal's words without its own request id (every answer carries a fresh requestId): "404 as a wrong id".
const refusalOf = (body: Json): Json => {
  const { requestId: _requestId, ...error } = (body.error ?? {}) as Json
  return error
}

async function reads(session: keyof typeof SESSIONS, entry: Case) {
  const list = await call(session, 'GET', `/files?recordType=${entry.recordType}&recordId=${entry.recordId}`)
  expect(list.status, `${session} list ${entry.name}: ${JSON.stringify(list.body)}`).toBe(200)
  const byId = await call(session, 'GET', `/files/${entry.file!.id}`)
  const download = await call(session, 'GET', `/files/${entry.file!.id}/download`)
  const preview = await call(session, 'GET', `/files/${entry.file!.id}/preview`)
  return { listed: (list.body.files as Json[]).map((file) => file.id as string), statuses: [byId.status, download.status, preview.status], byId }
}

describe('B-PR-08b PW-05 (files): the files of production records honour the brand', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('office.p2 (limited to B) lists none of A’s or the mixed records’ files and opens none (404 as a wrong id); B’s and every style’s open', async () => {
    const unknown = await call('office.p2', 'GET', `/files/${newId()}`)
    expect(unknown.status).toBe(404)
    for (const entry of cases) {
      const read = await reads('office.p2', entry)
      if (entry.owner === 'B' || entry.owner === 'EVERY') {
        expect(read.listed, entry.name).toContain(entry.file!.id)
        expect(read.statuses[0], entry.name).toBe(200)
      } else {
        expect(read.listed, entry.name).toEqual([])
        expect(read.statuses, entry.name).toEqual([404, 404, 404])
        expect(refusalOf(read.byId.body), entry.name).toEqual(refusalOf(unknown.body)) // fix-pr-3: the words, not the request id
      }
    }
  })

  it('office.p1 (limited to A) is the mirror: A’s and every style’s open; B’s and the mixed work order’s never (every customer only)', async () => {
    for (const entry of cases) {
      const read = await reads('office.p1', entry)
      if (entry.owner === 'A' || entry.owner === 'EVERY') {
        expect(read.listed, entry.name).toContain(entry.file!.id)
        expect(read.statuses[0], entry.name).toBe(200)
      } else {
        expect(read.listed, entry.name).toEqual([])
        expect(read.statuses, entry.name).toEqual([404, 404, 404])
      }
    }
  })

  it('the production unit (every customer) reads every production record’s file', async () => {
    for (const entry of cases) {
      const read = await reads('office.all', entry)
      expect(read.listed, entry.name).toContain(entry.file!.id)
      expect(read.statuses[0], entry.name).toBe(200)
    }
  })

  it('Use on carries neither A’s defect photo nor the mixed work order’s hold file onto B’s order (409 refusal/OTHER_PARTY); B’s own goes', async () => {
    for (const name of ['defect of A', 'check result of A', 'production hold of the mixed work order']) {
      const refused = await call('office.all', 'POST', `/files/${caseOf(name).file!.id}/use-on`, { recordType: 'SalesOrder', recordId: w.b.salesOrderId, visibility: ['OFFICE', 'PARTNER'] })
      expect(refused.status, `${name}: ${JSON.stringify(refused.body)}`).toBe(409)
      expect(refused.body.error.issues[0].path, name).toBe('refusal/OTHER_PARTY')
    }
    const own = await call('office.all', 'POST', `/files/${caseOf('inspection B').file!.id}/use-on`, { recordType: 'SalesOrder', recordId: w.b.salesOrderId })
    expect(own.status, JSON.stringify(own.body)).toBe(201)
    expect(own.body.file).toMatchObject({ recordType: 'SalesOrder', recordId: w.b.salesOrderId, sourceFileId: caseOf('inspection B').file!.id })
  })

  it('nothing office.p2 got holds A’s names, numbers, ids or files, or the mixed work order', () => {
    expect(seenByB.length).toBeGreaterThan(cases.length * 4)
    const found = seenByB.flatMap((answer) => findMarkers(answer.body, aMarkers).map((marker) => `${answer.url}: ${marker}`))
    expect(found).toEqual([])
  })
})
