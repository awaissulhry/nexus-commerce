import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { pointsPer100SqYd } from '@nexus/factory-domain/quality/incoming/units'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { subcontractFacts } from '../../payables/matching'

/**
 * Rolls, components and goods back from a workshop at incoming inspection (B-W2b-111; QHS-032, QHS-033, QHS-036) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security
 * and the …_inspection_plans_w2b_guards, subcontract and scan triggers are real), tenant A from EVERY seed. Made-up plans:
 * INC-FABRIC (a fixed sample of 2 rolls) and INC-WORKSHOP (a fixed sample of 3 pieces, opened by a rule on goods back
 * from the workshop P2). The fabric and protector inspections are planted as a rule would open them (the seed's lining lot
 * is opening stock, no receipt); the workshop's goods go through the office's receive, the rule, the inspection and the
 * decision. Decisions are signed through the harness's real sign-in (an office quality inspector, step-up). Made-up words.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/incoming/units`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'incoming-units-a'
let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `units-${run}-${++keys}`

const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), company: id('company:A'), site: id('site:A1'), P2: id('party:P2'), worker: id('worker:A1:operator'), device: id('device:A1:cutting') }
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.company, code: 'SCA' }, { id: id('company:B'), code: 'SCB' }] }

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const RECORD: Permission[] = ['quality.incoming.view', 'quality.incoming.record']
const BUYER: Permission[] = ['purchasing.view', 'purchasing.subcontract.manage', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'workorders.view', 'costing.view', 'costing.ledger.manage']
const SESSIONS: Record<string, SessionContext> = {}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

let inspector: { id: string; browser: Browser; secret: string }
const sign = async (inspectionId: string, body: Json) => {
  await stepUp(h, inspector.browser, inspector.secret)
  return inspector.browser.post(`/quality/incoming/${inspectionId}/decide`, body, { headers: { 'idempotency-key': freshKey() } })
}

/** A made-up APPROVED incoming plan with a fixed sample (written as the plans module leaves it: author ≠ approver). */
async function addPlan(code: string, fixed: number): Promise<{ planId: string; versionId: string }> {
  const planId = newId()
  const versionId = newId()
  const author = newId()
  await admin(`INSERT INTO "InspectionPlan" (id, "tenantId", "companyId", code, stage, name, "ownerId", "createdById") VALUES ($1, $2, $3, $4, 'INCOMING', $5, $6, $6)`, [planId, A.tenant, A.company, code, `Made-up plan ${code}`, author])
  await admin(`INSERT INTO "InspectionPlanVersion" (id, "tenantId", "companyId", "planId", number, "authorId", "samplingMethod", "fixedSampleSize", frequency, "createdById") VALUES ($1, $2, $3, $4, 1, $5, 'FIXED', $6, 'EVERY_LOT', $5)`, [versionId, A.tenant, A.company, planId, author, fixed])
  // One check that takes a result (a version is approved with one), not mandatory.
  await admin(`INSERT INTO "InspectionPlanCheck" (id, "tenantId", "planVersionId", "sortOrder", code, "labelIt", "labelEn", type, mandatory, "createdById") VALUES ($1, $2, $3, 10, 'LOOK', 'Aspetto', 'Look', 'PASS_FAIL', false, $4)`, [newId(), A.tenant, versionId, author])
  await admin(`UPDATE "InspectionPlanVersion" SET status = 'APPROVED', "approvedById" = $2, "approvedAt" = now(), "approvalSha256" = $3 WHERE id = $1`, [versionId, newId(), createHash('sha256').update(versionId).digest('hex')])
  return { planId, versionId }
}

/** An OPEN incoming inspection of a lot, as a rule opens it (nobody's yet), numbered as the seed numbers its own. */
async function plantInspection(lotId: string, itemId: string, versionId: string, lotSize: string, uom: string, sampleSize: number): Promise<string> {
  const inspectionId = newId()
  await admin(`INSERT INTO "IncomingInspection" (id, "tenantId", "companyId", "siteId", number, "lotId", "itemId", "planVersionId", "lotSize", uom, "sampleSize") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $11)`, [
    inspectionId,
    A.tenant,
    A.company,
    A.site,
    `T-${run}-${randomBytes(4).toString('hex')}`,
    lotId,
    itemId,
    versionId,
    lotSize,
    uom,
    sampleSize,
  ])
  return inspectionId
}

let fabric: { versionId: string; planId: string }
let workshopPlan: { versionId: string; planId: string }
let lining: { lotId: string; itemId: string; rolls: { id: string; code: string }[] }
let protectorLot: { lotId: string; itemId: string }
let certificateId: string
let wo: { id: string; sew: string }
let order: Json
let bundles: { id: string; code: string; quantity: number }[] = []

beforeAll(async () => {
  h = await startHarness('incoming_units')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: 'units.inspector@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  inspector = { id: user.id, browser, secret: await enrolTotp(h, browser) }
  const buyerId = newId()
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up buyer', 'ACTIVE')`, [buyerId, A.tenant, `${buyerId}@example.test`])
  Object.assign(SESSIONS, {
    keeper: { audience: 'office', tenantId: A.tenant, actorId: inspector.id, grants: [grant(RECORD)] },
    viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.incoming.view'])] },
    buyer: { audience: 'office', tenantId: A.tenant, actorId: buyerId, grants: [grant(BUYER)] },
    bench: { audience: 'floor', tenantId: A.tenant, actorId: A.worker, siteId: A.site, deviceId: A.device, grants: [grant(['floor.work', ...RECORD], { companies: [A.company], sites: [A.site] })] },
  } satisfies Record<string, SessionContext>)

  fabric = await addPlan(`T-FAB-${run}`, 2)
  workshopPlan = await addPlan(`T-WSH-${run}`, 3)
  // The rule: goods back from the workshop P2 go to INC-WORKSHOP (B-W2b-101's GOODS_RECEIPT, a SUPPLIER chip).
  await admin(`INSERT INTO "InspectionTrigger" (id, "tenantId", "companyId", "sortOrder", event, "appliesTo", "planId", frequency, active, "createdById") VALUES ($1, $2, $3, 5, 'GOODS_RECEIPT', $4::jsonb, $5, 'EVERY_LOT', true, $6)`, [
    newId(),
    A.tenant,
    A.company,
    JSON.stringify([{ kind: 'SUPPLIER', value: A.P2 }]),
    workshopPlan.planId,
    newId(),
  ])
  const lin = (await admin<{ id: string; itemId: string }>(`SELECT id::text, "itemId"::text FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!
  lining = { lotId: lin.id, itemId: lin.itemId, rolls: await admin(`SELECT id::text, code FROM "FabricRoll" WHERE "lotId" = $1 ORDER BY code`, [lin.id]) }
  const pro = (await admin<{ id: string; itemId: string }>(`SELECT id::text, "itemId"::text FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-PRO-01'`, [A.tenant]))[0]!
  protectorLot = { lotId: pro.id, itemId: pro.itemId }
  certificateId = (await admin<{ id: string }>(`SELECT id::text FROM "Certificate" WHERE "tenantId" = $1 AND standard LIKE 'EN 1621-1%' AND status = 'VALID' ORDER BY "validTo" DESC LIMIT 1`, [A.tenant]))[0]!.id

  // The workshop: WO-0001's sewing done by P2, three made-up whole-garment bundles (as B-W2b-10's receive-back test).
  wo = (await admin<{ id: string; sew: string }>(`SELECT w.id::text, o.id::text AS sew FROM "WorkOrder" w JOIN "WorkOrderOperation" o ON o."workOrderId" = w.id WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001' AND o.seq = 20`, [A.tenant]))[0]!
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(`UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7 FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`, [A.P2, wo.sew])
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 3`, [wo.id])
  for (const [index, quantity] of [3, 2, 2].entries()) {
    await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [newId(), A.tenant, A.site, wo.id, cells[index % cells.length]!.id, `T-UN-${run}-${index + 1}`, quantity])
  }
  bundles = await admin(`SELECT id::text, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 AND code LIKE $2 ORDER BY code`, [wo.id, `T-UN-${run}-%`])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const seedOrderId = (await admin<{ id: string }>(`SELECT id::text FROM "SubcontractOrder" WHERE "tenantId" = $1 AND number = 'SEED-SC-0001'`, [A.tenant]))[0]!.id
  const seedOrder = (await ok('buyer', 'GET', `/purchasing/subcontracting/orders/${seedOrderId}`)).order
  if (seedOrder.status === 'DRAFT' || seedOrder.status === 'ISSUED') await ok('buyer', 'POST', `/purchasing/subcontracting/orders/${seedOrderId}/cancel`, { version: seedOrder.version, reason: 'Made again for the incoming units test' })
  order = (await ok('buyer', 'POST', '/purchasing/subcontracting/orders', { workOrderId: wo.id, operations: [{ workOrderOperationId: wo.sew }] }, 201)).order
  order = (await ok('buyer', 'POST', `/purchasing/subcontracting/orders/${order.id}/issue`, { version: order.version })).order
  order = (await ok('buyer', 'POST', `/purchasing/subcontracting/orders/${order.id}/kit/send`, { version: order.version, bundles: bundles.map((bundle) => ({ bundleId: bundle.id })), ddt: null }, 201)).order
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('fabric rolls by the 4-point system (QHS-032)', () => {
  let rolls: Json

  it('records rolls by tag and by the supplier’s number; the database works out the points per 100 square yards', async () => {
    const inspectionId = await plantInspection(lining.lotId, lining.itemId, fabric.versionId, '120.0000', 'M', 2)
    rolls = await ok('keeper', 'GET', `/quality/incoming/${inspectionId}`)
    expect(rolls.inspection).toMatchObject({ subject: 'LOT', byRoll: true, byHide: false, sampleSize: 2 })
    expect(rolls.sampling.words.en).toBe('Inspect 2 rolls of the lot of 120 m · 0 done')
    expect(rolls.rollCandidates.map((roll: Json) => roll.code)).toEqual(lining.rolls.map((roll) => roll.code))
    expect(rolls.choices.fourPointLimit).toBe('40')
    // The tag: its width and length (60 m received) taken from the roll.
    rolls = await ok('keeper', 'PUT', `/quality/incoming/${inspectionId}/rolls`, { version: rolls.inspection.version, rollId: lining.rolls[0]!.id, onePoint: 3, twoPoint: 2, threePoint: 1, fourPoint: 4, decision: 'ACCEPTED' })
    expect(rolls.rolls[0]).toMatchObject({ rollRef: lining.rolls[0]!.code, roll: { id: lining.rolls[0]!.id }, points: 26, widthCm: '145.00', lengthM: '60.00', pointsPer100SqYd: pointsPer100SqYd({ onePoint: 3, twoPoint: 2, threePoint: 1, fourPoint: 4 }, '145.00', '60.00'), verdict: { suggested: 'ACCEPTED' }, decision: 'ACCEPTED' })
    // The supplier's number: width and length measured here, or refused in words.
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${inspectionId}/rolls`, { version: rolls.inspection.version, rollRef: 'SUP-77', fourPoint: 12 }, 400))).toEqual(['body/widthCm', 'body/lengthM'])
    rolls = await ok('keeper', 'PUT', `/quality/incoming/${inspectionId}/rolls`, { version: rolls.inspection.version, rollRef: 'SUP-77', fourPoint: 12, widthCm: '150', lengthM: '40' })
    const sup = rolls.rolls.find((roll: Json) => roll.rollRef === 'SUP-77')
    expect(sup).toMatchObject({ roll: null, points: 48, pointsPer100SqYd: '66.89', verdict: { suggested: 'REJECTED', over: true }, decision: null })
    expect(rolls.rollSummary).toMatchObject({ rolls: 2, over: 1, accepted: 1, undecided: 1 })
    expect(rolls.inspector.kind).toBe('OFFICE')
    // The sample is full: a third roll is refused in words.
    expect((await refused('keeper', 'PUT', `/quality/incoming/${inspectionId}/rolls`, { version: rolls.inspection.version, rollRef: 'SUP-78', widthCm: '150', lengthM: '40' }, 409)).message).toBe('The sample is 2 rolls: all are recorded. Take one out first.')
    expect((await admin(`SELECT "pointsPer100SqYd"::text AS p FROM "IncomingRollResult" WHERE "incomingInspectionId" = $1 AND "rollRef" = 'SUP-77'`, [inspectionId]))[0]).toEqual({ p: '66.89' })
  })

  it('a lot counted in pieces takes no roll; every roll is decided before the PIN; the rolls bind the decision in metres', async () => {
    const pieces = await plantInspection(protectorLot.lotId, protectorLot.itemId, fabric.versionId, '24.0000', 'PCS', 2)
    const seeded = await ok('keeper', 'GET', `/quality/incoming/${pieces}`)
    expect((await refused('keeper', 'PUT', `/quality/incoming/${pieces}/rolls`, { version: seeded.inspection.version, rollRef: 'X', widthCm: '1', lengthM: '1' }, 409)).message).toMatch(/fabric rolls are inspected on a lot counted in a length/)
    await ok('keeper', 'POST', `/quality/incoming/${pieces}/cancel`, { version: seeded.inspection.version, reason: 'Planted for the refusal only (made up).' })
    const url = `/quality/incoming/${rolls.inspection.id}/decide`
    expect(paths(await refused('keeper', 'POST', url, { version: rolls.inspection.version, accepted: '60', rejected: '60', toSort: '0' }, 400))).toEqual(['body/rolls'])
    const sup = rolls.rolls.find((roll: Json) => roll.rollRef === 'SUP-77')
    rolls = await ok('keeper', 'PUT', `/quality/incoming/${rolls.inspection.id}/rolls`, { version: rolls.inspection.version, rollRef: 'SUP-77', decision: 'REJECTED' })
    expect(rolls.rolls.find((roll: Json) => roll.id === sup.id)).toMatchObject({ decision: 'REJECTED', widthCm: '150.00', lengthM: '40.00', fourPoint: 12 })
    expect(paths(await refused('keeper', 'POST', url, { version: rolls.inspection.version, accepted: '100', rejected: '20', toSort: '0' }, 400))).toEqual(['body/rejected'])
    const signed = await sign(rolls.inspection.id, { version: rolls.inspection.version, accepted: '80', rejected: '40', toSort: '0' })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.inspection).toMatchObject({ status: 'DECIDED', computedResult: 'PASS', decision: { accepted: '80.0000', rejected: '40.0000', toSort: '0.0000' } })
    expect(signed.body.next).toMatchObject({ step: 'RELEASE_PART', rejectedRolls: [{ rollRef: 'SUP-77' }], rejectedLines: [] })
    expect((await events('incoming_inspection.recorded')).filter((event) => event.incomingInspectionId === rolls.inspection.id).map((event) => event.what)).toEqual(['ROLL', 'ROLL', 'ROLL'])
  })
})

describe('components against spec and certificate (QHS-033), and the defect counter', () => {
  it('records the checklist with the certificate it holds, and the counter of a lot not counted by hide', async () => {
    const inspectionId = await plantInspection(protectorLot.lotId, protectorLot.itemId, fabric.versionId, '24.0000', 'PCS', 2)
    let view = await ok('bench', 'GET', `/quality/incoming/${inspectionId}`)
    expect(view.choices.certificates.map((entry: Json) => entry.id)).toContain(certificateId)
    expect(view.choices.coveringCertificate).toMatchObject({ id: certificateId })
    view = await ok('keeper', 'PUT', `/quality/incoming/${inspectionId}/components/1`, { version: view.inspection.version, kind: 'PROTECTOR', marking: 'EN 1621-1:2012 L2 B', protectorType: 'B', size: 'M', certificateId, checkedQuantity: 2, defectiveQuantity: 0, decision: 'ACCEPTED' })
    expect(view.components[0]).toMatchObject({ seq: 1, kind: 'PROTECTOR', certificate: { id: certificateId }, certificateCheck: { state: 'VALID' }, suggested: 'ACCEPTED', reasons: [], decision: 'ACCEPTED' })
    view = await ok('keeper', 'PUT', `/quality/incoming/${inspectionId}/components/2`, { version: view.inspection.version, kind: 'PROTECTOR', checkedQuantity: 2, defectiveQuantity: 1 })
    expect(view.components[1]).toMatchObject({ certificateCheck: { state: 'MISSING' }, suggested: 'REJECTED' })
    expect(view.components[1].reasons.map((reason: Json) => reason.en)).toContain('Without an EN 1621 certificate the protector goes into no PPE garment.')
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${inspectionId}/components/3`, { version: view.inspection.version, kind: 'ZIP', protectorType: 'A', checkedQuantity: 2, defectiveQuantity: 3 }, 400))).toEqual(['body/defectiveQuantity', 'body/protectorType'])
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${inspectionId}/components/3`, { version: view.inspection.version, kind: 'ZIP', certificateId: newId(), checkedQuantity: 2 }, 400))).toEqual(['body/certificateId'])
    // The counter: units of the sample with a defect, up to the sample; a hide lot counts from its marks instead.
    expect(paths(await refused('keeper', 'PUT', `/quality/incoming/${inspectionId}/counters`, { version: view.inspection.version, found: { critical: 0, major: 3, minor: 0 } }, 400))).toEqual(['body/found/major'])
    view = await ok('keeper', 'PUT', `/quality/incoming/${inspectionId}/counters`, { version: view.inspection.version, found: { critical: 0, major: 1, minor: 0 } })
    expect(view.inspection.found).toEqual({ critical: 0, major: 1, minor: 0 })
    // Every component decided before the PIN; one taken out.
    expect(paths(await refused('keeper', 'POST', `/quality/incoming/${inspectionId}/decide`, { version: view.inspection.version, accepted: '22', rejected: '2', toSort: '0' }, 400))).toEqual(['body/components'])
    view = await ok('keeper', 'DELETE', `/quality/incoming/${inspectionId}/components/2?version=${view.inspection.version}`)
    expect(view.components.map((component: Json) => component.seq)).toEqual([1])
    const signed = await sign(inspectionId, { version: view.inspection.version, accepted: '24', rejected: '0', toSort: '0' })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.inspection).toMatchObject({ status: 'DECIDED', computedResult: 'PASS' })
  })
})

describe('goods back from a workshop, checked before stock and before payment (QHS-036)', () => {
  let receipt: Json
  let inspection: Json

  it('the receipt opens its inspection by rule: the bundles wait, no fee, not in the invoice match, the order stays open', async () => {
    const [b1, b2, b3] = bundles
    const response = await call('buyer', 'POST', `/purchasing/subcontracting/orders/${order.id}/receive`, {
      version: order.version,
      lines: [
        { operationId: order.operations[0].id, bundleId: b1!.id, good: 3, defective: 0, scrapped: 0 },
        { operationId: order.operations[0].id, bundleId: b2!.id, good: 1, defective: 1, scrapped: 0, reason: 'CLEANING' },
        { operationId: order.operations[0].id, bundleId: b3!.id, good: 2, defective: 0, scrapped: 0 },
      ],
    })
    expect(response.statusCode, response.body).toBe(201)
    receipt = response.json()
    order = receipt.order
    expect(receipt.inspection).toMatchObject({ number: expect.stringMatching(/^IIN-/) })
    expect(receipt.inspection.words.en).toMatch(/^7 pieces wait for incoming inspection IIN-/)
    expect(receipt.outside.map((line: Json) => [line.scanId, line.words])).toEqual([0, 1, 2].map(() => [null, receipt.inspection.words.en]))
    const lines = await admin<{ id: string }>(`SELECT id::text FROM "SubcontractReceiptLine" WHERE "receiptId" = $1 ORDER BY seq`, [receipt.receipt.id])
    expect(await admin(`SELECT id FROM "OperationScan" WHERE "subcontractReceiptLineId" = ANY($1::uuid[])`, [lines.map((line) => line.id)])).toEqual([])
    expect(await admin(`SELECT amount FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT'`, [order.id])).toEqual([])
    expect(receipt.ledger).toEqual({ posted: 0, waiting: [] })
    const facts = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => subcontractFacts(client, newId(), order.id))
    expect(facts!.facts).toMatchObject({ piecesBackGood: 0, goodValue: '0.000000' })
    // The rules' handler a moment later finds it open (its trail says so); the receipt line is not reported by hand meanwhile.
    expect((await refused('buyer', 'POST', `/production/scans/receipt-lines/${lines[0]!.id}/report`, {}, 409)).message).toMatch(/wait for incoming inspection IIN-/)
    inspection = await ok('keeper', 'GET', `/quality/incoming/${receipt.inspection.id}`)
    expect(inspection.inspection).toMatchObject({ subject: 'WORKSHOP', status: 'OPEN', lotSize: '7.0000', uom: 'PCS', sampleSize: 3 })
    expect(inspection.lot).toBeNull()
    expect(inspection.receipt).toMatchObject({ seq: 1, order: { number: order.number }, workshop: { id: A.P2 }, lots: 7 })
    expect(inspection.receipt.lines.map((line: Json) => line.state)).toEqual(['HELD', 'HELD', 'HELD'])
    expect(inspection.plan.code).toBe(`T-WSH-${run}`)
  })

  it('the tablet reads the receipt (no workshop name); a second inspection of it is refused while one is open', async () => {
    const bench = await ok('bench', 'GET', `/quality/incoming/receipts/${receipt.receipt.id}`)
    expect(bench.open.inspection.id).toBe(inspection.inspection.id)
    expect(bench.receipt.workshop).toBeNull()
    expect(bench.open.receipt.lines).toHaveLength(3)
    expect((await refused('keeper', 'POST', '/quality/incoming', { subcontractReceiptId: receipt.receipt.id }, 409)).message).toMatch(/open incoming inspection already/)
    expect(paths(await refused('keeper', 'POST', '/quality/incoming', { lotId: lining.lotId, subcontractReceiptId: receipt.receipt.id }, 400))).toEqual(['body/lotId'])
    const close = await call('buyer', 'POST', `/purchasing/subcontracting/orders/${order.id}/close`, { version: order.version })
    expect(close.statusCode).toBe(409)
  })

  it('decides bundle by bundle: the kept ones go on and are paid, the rejected one moves to defective', async () => {
    const lines = inspection.receipt.lines as Json[]
    inspection = await ok('keeper', 'PUT', `/quality/incoming/${inspection.inspection.id}/counters`, { version: inspection.inspection.version, found: { critical: 0, major: 1, minor: 0 } })
    const url = `/quality/incoming/${inspection.inspection.id}/decide`
    expect(paths(await refused('keeper', 'POST', url, { version: inspection.inspection.version, accepted: '4', rejected: '3', toSort: '0' }, 400))).toEqual(['body/rejectedLines'])
    expect(paths(await refused('keeper', 'POST', url, { version: inspection.inspection.version, accepted: '3', rejected: '1', toSort: '3', rejectedLines: [lines[2]!.id] }, 400))).toContain('body/toSort')
    const signed = await sign(inspection.inspection.id, { version: inspection.inspection.version, accepted: '4', rejected: '3', toSort: '0', rejectedLines: [lines[2]!.id] })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    inspection = signed.body
    expect(inspection.inspection).toMatchObject({ status: 'DECIDED', decision: { accepted: '4.0000', rejected: '3.0000', toSort: '0.0000' } })
    expect(inspection.receipt.lines.map((line: Json) => line.state)).toEqual(['REPORTED', 'REPORTED', 'REJECTED'])
    expect(inspection.next).toMatchObject({ step: 'RELEASE_PART', lotStatus: null, rejectedLines: [{ id: lines[2]!.id, pieces: 2 }] })
    expect(inspection.next.words.en).toMatch(/^4 accepted pieces go on to the next operation/)
    const operation = (await admin(`SELECT "piecesBackGood" AS good, "piecesBackDefective" AS defective FROM "SubcontractOperation" WHERE id = $1`, [order.operations[0].id]))[0]
    expect(operation).toEqual({ good: 4, defective: 3 })
    const scans = await admin(`SELECT "subcontractReceiptLineId"::text AS line, "goodQuantity" AS good, "reworkQuantity" AS rework FROM "OperationScan" WHERE "subcontractReceiptLineId" = ANY($1::uuid[]) ORDER BY "goodQuantity" DESC`, [lines.map((line) => line.id)])
    expect(scans).toEqual([{ line: lines[0]!.id, good: 3, rework: 0 }, { line: lines[1]!.id, good: 1, rework: 1 }])
    // The fee for the 4 pieces accepted (5.25 each); the invoice match counts them.
    expect((await admin<{ amount: number }>(`SELECT amount FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT'`, [order.id])).reduce((sum, row) => sum + Number(row.amount), 0)).toBe(2100)
    const facts = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => subcontractFacts(client, newId(), order.id))
    expect(facts!.facts.piecesBackGood).toBe(4)
    expect((await refused('buyer', 'POST', `/production/scans/receipt-lines/${lines[2]!.id}/report`, {}, 409)).message).toMatch(/rejected this line/)
    expect((await admin(`SELECT after->'rejectedLines' AS lines FROM "AuditLog" WHERE "recordType" = 'SubcontractReceipt' AND "recordId" = $1`, [receipt.receipt.id]))[0]).toEqual({ lines: [lines[2]!.id] })
    expect((await events('subcontract_order.updated')).filter((event) => event.subcontractOrderId === order.id).at(-1)).toMatchObject({ fields: ['incomingInspection', 'piecesBackGood', 'piecesBackDefective'] })
    expect((await events('incoming_inspection.decided')).find((event) => event.incomingInspectionId === inspection.inspection.id)).toMatchObject({ lotId: null, subcontractReceiptId: receipt.receipt.id, next: 'RELEASE_PART' })
  })

  it('lists the workshop inspection with its receipt; the viewer may not decide', async () => {
    const list = await ok('viewer', 'GET', `/quality/incoming?subcontractReceiptId=${receipt.receipt.id}`)
    expect(list.items).toEqual([expect.objectContaining({ id: inspection.inspection.id, lot: null, item: null, receipt: { id: receipt.receipt.id, workOrderId: wo.id } })])
    const viewer = await ok('viewer', 'GET', `/quality/incoming/${inspection.inspection.id}`)
    expect(viewer.may).toEqual({ record: false, decide: false, cancel: false })
  })
})
