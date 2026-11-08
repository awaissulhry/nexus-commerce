import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedInspectionPlans, type InspectionPlansSeed } from '../../../../../../packages/factory-db/seed/inspection-plans'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedQuality, type QualitySeed } from '../../../../../../packages/factory-db/seed/quality'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-W2b-127 (Inspections in depth: incoming and in-line in one list, the cause of a defect) on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the inspection and amendment guards are
 * real), the real app. Tenant A from the factory-db seeds up to quality and inspection plans (WO-0001's PASSED inspection on
 * W1's checklist and its OPEN one with a defect; the OPEN final inspection on FIN-JACKET v1; SEED-IIN-0002 DECIDED with a note
 * correction asked and countersigned). The list's new facts: the plan version, the units counted, a countersigned correction
 * (`?amended=true`), the incoming lot's supplier for the office. A defect line names its cause code. Made-up words only. Run
 * with `node scripts/factory/run-pg-tests.mjs modules/quality/final/inspections-depth`.
 */

let h: Harness
let app: FastifyInstance
let quality: QualitySeed
let plans: InspectionPlansSeed

const NS = 'w2b127-depth-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const siteA = idIn('site:A1')

type Json = Record<string, any>
type Method = 'GET' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = () => `depth-${++counter}-${newId()}`
/** A write past the database's guards (the test's planted facts only: never what the test then proves). */
const force = async (sql: string, values: unknown[] = []) => {
  // One connection (pg.Client): the three statements run in one transaction, in order.
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query('SET LOCAL session_replication_role = replica')
    await h.db.admin.query(sql, values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const VIEW: Permission[] = ['quality.inspections.view', 'quality.incoming.view', 'quality.inprocess.view']
const recorderId = newId()
const SESSIONS: Record<string, SessionContext> = {
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(VIEW)] },
  recorder: { audience: 'office', tenantId: T, actorId: recorderId, grants: [grant([...VIEW, 'quality.inspections.record'])] },
}

async function call(session: string, method: Method, url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: Method, url: string, body?: unknown): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}

beforeAll(async () => {
  h = await startHarness('quality_insp_depth')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  quality = await seedQuality({ db: h.database, namespace: NS })
  plans = await seedInspectionPlans({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const rowOf = (list: Json, id: string): Json => list.inspections.find((row: Json) => row.id === id)

describe('the final inspections list in depth (design qi-grid: Plan + version, Sample n of N, Amended results)', () => {
  it('a row says its plan version and the units counted on a plan; a W1 inspection has neither', async () => {
    const list = await ok('viewer', 'GET', '/quality/inspections?limit=200')
    expect(rowOf(list, quality.passedInspectionId)).toMatchObject({ planVersion: null, inspected: null, amended: false })
    const planned = rowOf(list, plans.inspectionId)
    expect(planned.planVersion).toMatchObject({ code: 'FIN-JACKET', number: 1 })
    expect(Number.isInteger(planned.inspected)).toBe(true)
  })

  it('a correction counts once countersigned: a request alone is not "amended"; ?amended=true lists only those', async () => {
    const requestId = newId()
    const asker = newId()
    // Planted (the amendments' own test proves the routes and their guards): a REQUEST, then its countersignature.
    await force(
      `INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, field, "after", reason, "signedById", "signedAt", "signatureSha256", "createdById")
       VALUES ($1, $2, $3, $4, 'REQUEST', 'note', '"Left out at the bench."', 'The note was missing.', $5, now(), repeat('b', 64), $5)`,
      [requestId, T, siteA, quality.passedInspectionId, asker],
    )
    expect(rowOf(await ok('viewer', 'GET', '/quality/inspections?limit=200'), quality.passedInspectionId).amended).toBe(false)
    expect((await ok('viewer', 'GET', '/quality/inspections?amended=true')).inspections.map((row: Json) => row.id)).not.toContain(quality.passedInspectionId)
    await force(
      `INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, "requestId", "signedById", "signedAt", "signatureSha256", "createdById")
       VALUES ($1, $2, $3, $4, 'SIGNED', $5, $6, now(), repeat('c', 64), $6)`,
      [newId(), T, siteA, quality.passedInspectionId, requestId, newId()],
    )
    expect(rowOf(await ok('viewer', 'GET', '/quality/inspections?limit=200'), quality.passedInspectionId).amended).toBe(true)
    const amended = (await ok('viewer', 'GET', '/quality/inspections?amended=true')).inspections
    expect(amended.map((row: Json) => row.id)).toEqual([quality.passedInspectionId])
    expect(amended[0]).toMatchObject({ amended: true, status: 'PASSED' })
  })
})

describe('the incoming inspections list in the same page (supplier, plan, amended)', () => {
  it('each row names its plan version; the office reads the lot supplier; SEED-IIN-0002 carries its countersigned correction', async () => {
    const list = await ok('viewer', 'GET', '/quality/incoming?limit=200')
    const decided = list.items.find((row: Json) => row.id === plans.decidedIncomingId)
    const open = list.items.find((row: Json) => row.id === plans.openIncomingId)
    expect(decided).toMatchObject({ amended: true, plan: { code: 'INC-LEATHER', number: 1 } })
    expect(open).toMatchObject({ amended: false, plan: { code: 'INC-LEATHER' } })
    const [lot] = await admin<{ supplierId: string | null }>(`SELECT "supplierId" FROM "Lot" WHERE id = $1`, [plans.lotId])
    if (lot?.supplierId) expect(open.supplier).toMatchObject({ id: lot.supplierId, name: expect.any(String) })
    else expect(open.supplier).toBeNull()
  })
})

describe('a defect names its cause (design ins-defects "cause code")', () => {
  it('takes an active cause of the list; refuses an unknown or a retired one in words; a line without one keeps it', async () => {
    // Planted: the recorder is the assignee of WO-0001's OPEN inspection (only its inspector or assignee records it).
    await force(`UPDATE "Inspection" SET "assignedInspectorId" = $1, "assignedInspectorWorkerId" = NULL WHERE id = $2`, [recorderId, quality.openInspectionId])
    const causeId = newId()
    const retiredId = newId()
    await admin(`INSERT INTO "CauseCode" (id, "tenantId", code, process, "labelIt", "labelEn") VALUES ($1, $2, 'DEPTH-SEW', 'SEWING', 'Cucitura', 'Sewing'), ($3, $2, 'DEPTH-OLD', 'MATERIAL', 'Vecchio', 'Old')`, [causeId, T, retiredId])
    await admin(`UPDATE "CauseCode" SET active = false WHERE id = $1`, [retiredId])
    const read = await ok('recorder', 'GET', `/quality/inspections/${quality.openInspectionId}`)
    const line = read.inspection.defects[0]
    expect(line).toHaveProperty('causeCodeId', null)
    const body = (causeCodeId: string | null | undefined, version: number) => ({
      version,
      defects: [{ defectClass: line.defectClass, code: line.code, quantity: line.quantity, workOrderSizeId: line.workOrderSizeId, defectCodeId: line.defectCodeId, zone: line.zone, note: line.note, ...(causeCodeId === undefined ? {} : { causeCodeId }) }],
    })
    const unknown = await call('recorder', 'PUT', `/quality/inspections/${quality.openInspectionId}/defects`, body(newId(), read.inspection.version))
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/defects/0/causeCodeId'])
    const retired = await call('recorder', 'PUT', `/quality/inspections/${quality.openInspectionId}/defects`, body(retiredId, read.inspection.version))
    expect(retired.status).toBe(400)
    expect(retired.body.error.issues[0].message).toMatch(/DEPTH-OLD is retired/)
    const saved = await ok('recorder', 'PUT', `/quality/inspections/${quality.openInspectionId}/defects`, body(causeId, read.inspection.version))
    expect(saved.inspection.defects[0].causeCodeId).toBe(causeId)
    // The bench sends no cause: the stored one stays.
    const kept = await ok('recorder', 'PUT', `/quality/inspections/${quality.openInspectionId}/defects`, body(undefined, saved.inspection.version))
    expect(kept.inspection.defects[0].causeCodeId).toBe(causeId)
    const cleared = await ok('recorder', 'PUT', `/quality/inspections/${quality.openInspectionId}/defects`, body(null, kept.inspection.version))
    expect(cleared.inspection.defects[0].causeCodeId).toBeNull()
  })
})
