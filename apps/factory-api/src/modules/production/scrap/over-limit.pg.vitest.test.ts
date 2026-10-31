import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { scrapApprovalStatesOf, scrapWaitsAt } from './over-limit'

/**
 * Scrap above a site's limit waits for the team leader's approval (B-W2b-53; MES-128 "Scrap over a quantity or value limit
 * waits for a supervisor before it posts"; design floor.supervisor "Waiting for you", production.scrap "Waiting for
 * approval (over the limit)") through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the
 * runtime and floor logins: row-level security, the grants and the scan triggers are real), on the factory-db seeds up
 * to production: WO-0001 in progress at plant A1 (which names workers; its operator acknowledged the notice), its second
 * bundle of two garments reported at sewing. The operator's reports at final inspection are written as the floor writes
 * them (the scan, its scrap line STAIN); the limit is set through Floor rules per site. A real team leader signs in with
 * the PIN on an enrolled tablet for the approval that signs. Every name and number is made up. The law the tests name:
 * Statuto dei Lavoratori (L. 300/1970) art. 4 — the waiting lists name no person. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/scrap`.
 */

let h: Harness
let app: FastifyInstance
let seed: ProductionSeed

const NS = 'w2b53-scrap-limit'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const device = idOf('device:A1:cutting')
const qcStation = idOf('site:A1:station:QC-01')
const sew2 = idOf('site:A1:station:SEW-02')
const OPERATOR_NAME = 'Seed Worker A1-1'
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '482913'
const operatorUser = newId()

const MANAGER: Permission[] = ['production.settings.view', 'production.settings.manage', 'production.scrap.view', 'production.scrap', 'production.scrap.overLimit']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const floor = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: T, actorId, siteId: siteA1, deviceId: device, grants: [grant(permissions, [companyA], [siteA1])] })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(MANAGER)]),
  viewer: office([grant(['production.scrap.view'])]),
  companyB: office([grant(MANAGER, [companyB])]),
  operatorUser: office([grant(MANAGER)], operatorUser),
  lead: floor(lead, ['floor.work', 'floor.lead']),
  operatorAsLead: floor(operator, ['floor.work', 'floor.lead']),
  operator: floor(operator, ['floor.work', 'production.scan']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')

/** A report of bundle 2 (two garments) at final inspection, as the operator's tablet writes it: scrap with its line. */
async function reportQc(scrap: number, serverTime = new Date()): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1 }, (client) =>
    client.$transaction(async (tx) => {
      await tx.operationScan.create({
        data: {
          id,
          siteId: siteA1,
          workOrderId: seed.workOrderId,
          workOrderOperationId: seed.operationIds.qc,
          bundleId: seed.bundleIds[1],
          kind: 'REPORT',
          goodQuantity: 2 - scrap,
          scrapQuantity: scrap,
          scrapReason: scrap > 0 ? 'STAIN' : null,
          workerId: operator,
          stationId: qcStation,
          deviceId: device,
          clientScanId: `w2b53-${run}-${++serial}`,
          deviceTime: serverTime,
          serverTime,
          createdById: operator,
        },
        select: { id: true },
      })
      if (scrap > 0) await tx.operationScanDefect.create({ data: { id: newId(), siteId: siteA1, scanId: id, kind: 'SCRAP', reasonCode: 'STAIN', quantity: scrap, createdById: operator }, select: { id: true } })
    }),
  )
  return id
}

/** The operator undoes a report on the same tablet (the scan stays; the undo voids it). */
async function undo(scanId: string): Promise<void> {
  await h.database.withScope({ audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1 }, (client) =>
    client.operationScan.create({
      data: { id: newId(), siteId: siteA1, workOrderId: seed.workOrderId, workOrderOperationId: seed.operationIds.qc, bundleId: seed.bundleIds[1], kind: 'UNDO', correctsId: scanId, reason: 'Scanned in a hurry.', workerId: operator, stationId: qcStation, deviceId: device, clientScanId: `w2b53-${run}-${++serial}`, createdById: operator },
      select: { id: true },
    }),
  )
}

const scrapRows = async (query = '') => ok('manager', 'GET', `/production/scrap?workOrderId=${seed.workOrderId}${query}`)
const rowOf = (page: Json, scanId: string) => page.rows.find((row: Json) => row.source.type === 'SCAN' && row.source.id === scanId)
const decisions = (scanId: string) => admin('SELECT "recordType", "actorId", audience::text AS audience, after, reason FROM "AuditLog" WHERE action = \'production.decideScrapOverLimit\' AND ("recordId" = $1::uuid OR (after->>\'scanId\') = $2) ORDER BY at, id', [scanId, scanId])
const decidedEvents = (scanId: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = \'production.scrap_over_limit_decided\' AND payload->>\'scanId\' = $1 ORDER BY "occurredAt", id', [scanId])
const askRecut = (session: string, scanId: string) => call(session, 'POST', '/production/replacements', { kind: 'RECUT', quantity: 1, reason: 'Cut two more from the next hide.', sourceScanId: scanId })

beforeAll(async () => {
  h = await startHarness('w2b53_scrap_limit')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  seed = await seedProduction({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // The operator is also an office user (made up): that account never decides the operator's scrap.
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, $3, 'Made-up Operator (office)', 'ACTIVE', now())`, [operatorUser, T, `operator-${run}@example.test`])
  await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [operator, operatorUser])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let before: string
let waiting: string

describe('which scrap waits (MES-128)', () => {
  it('a report taken before the site had a limit needs no approval; the limit applies from its moment on', async () => {
    before = await reportQc(2, new Date(Date.now() - 120_000))
    const rules = await ok('manager', 'POST', `/production/settings/${siteA1}/floor-rules`, { scrapApprovalLimit: 1, reason: 'Leather is dear.' })
    expect(rules.checks.scrapApprovalLimit).toBe(1)
    const page = await scrapRows()
    expect(rowOf(page, before)).toMatchObject({ pieces: 2, reasonCode: 'STAIN', approval: null })
    expect(page.tiles.waitingApproval).toBe(0)
  })

  it('a report above the limit counts at once, and its scrap waits: the row, the tile, the filter, the office list (never who)', async () => {
    await undo(before)
    waiting = await reportQc(2)
    const page = await scrapRows()
    expect(rowOf(page, waiting).approval).toEqual({ state: 'WAITING', limit: 1, decidedAt: null, decidedOn: null, reason: null, note: null })
    expect(page.tiles.waitingApproval).toBe(1)
    const filtered = await scrapRows('&approval=WAITING')
    expect(filtered.rows.map((row: Json) => row.source.id)).toEqual([waiting])
    const list = await ok('viewer', 'GET', `/production/scrap/over-limit?siteId=${siteA1}`)
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ scanId: waiting, scrapQuantity: 2, goodQuantity: 0, station: { code: 'QC-01' }, operation: { seq: 30 }, reasons: [{ code: 'STAIN', quantity: 2 }], approval: { state: 'WAITING', limit: 1 } })
    expect(list.refusalTiles.map((tile: Json) => tile.code)).toEqual(['REWORK_INSTEAD', 'WRONG_COUNT', 'WRONG_REASON', 'OTHER'])
    expect(JSON.stringify(list)).not.toContain(OPERATOR_NAME)
    expect(JSON.stringify(list)).not.toContain(operator)
    // The bundle went on: the scan stands (F3), its garments are scrap in the counts.
    expect(await admin('SELECT kind::text, "scrapQuantity" FROM "OperationScan" WHERE id = $1', [waiting])).toEqual([{ kind: 'REPORT', scrapQuantity: 2 }])
  })

  it('waiting scrap posts nothing: no replacement, no scrap of stock naming it (409 in words)', async () => {
    const recut = await askRecut('manager', waiting)
    expect(recut.statusCode, recut.body).toBe(409)
    expect(refusalOf(recut.json().error)).toBe('refusal/SCRAP_WAITS_APPROVAL')
    expect(recut.json().error.message).toBe("2 pieces scrapped in one scan is above this site's limit of 1: it waits for the team leader's approval before it posts.")
    const stock = await no('manager', 'POST', '/production/scrap/stock', { workOrderId: seed.workOrderId, reasonCode: 'STAIN', sourceScanId: waiting, lines: [{ hideId: newId() }] }, 409)
    expect(refusalOf(stock)).toBe('refusal/SCRAP_WAITS_APPROVAL')
  })

  it('the readers: the states for the cost ledger (office scope) and the words for the tablet (floor scope)', async () => {
    const states = await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => scrapApprovalStatesOf(client, [waiting, before, seed.scanIds[2]]))
    expect([...states.entries()]).toEqual([
      [waiting, 'WAITING'],
      [before, null],
      [seed.scanIds[2], null],
    ])
    const words = await h.database.withScope({ audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1 }, (client) => scrapWaitsAt(client, siteA1, 2))
    expect(words).toMatchObject({ waits: true, limit: 1 })
  })
})

describe("the team leader's decision on the tablet and the office's (four eyes)", () => {
  it('the person who took the scan never decides it: not as the lead on a tablet, not as their office account', async () => {
    expect(refusalOf(await no('operatorAsLead', 'POST', `/production/scrap/floor/waiting/${waiting}/refuse`, { reason: 'WRONG_COUNT' }, 409))).toBe('refusal/SELF_DECISION')
    expect(refusalOf(await no('operatorUser', 'POST', `/production/scrap/over-limit/${waiting}/approve`, {}, 409))).toBe('refusal/SELF_DECISION')
    await no('operator', 'GET', '/production/scrap/floor/waiting', undefined, 403)
    await no('viewer', 'POST', `/production/scrap/over-limit/${waiting}/approve`, {}, 403)
    await no('companyB', 'POST', `/production/scrap/over-limit/${waiting}/approve`, {}, 404)
  })

  it('the lead sees what waits on the site (no name), refuses with a reason tile; refused scrap never posts', async () => {
    const list = await ok('lead', 'GET', '/production/scrap/floor/waiting')
    expect(list.rows.map((row: Json) => [row.scanId, row.own])).toEqual([[waiting, false]])
    expect(JSON.stringify(list)).not.toContain(OPERATOR_NAME)
    expect(refusalOf(await no('lead', 'POST', `/production/scrap/floor/waiting/${waiting}/refuse`, { reason: 'OTHER' }, 409))).toBe('refusal/NOTE_NEEDED')
    const refused = await ok('lead', 'POST', `/production/scrap/floor/waiting/${waiting}/refuse`, { reason: 'REWORK_INSTEAD' })
    expect(refused).toMatchObject({ scanId: waiting, approval: { state: 'REFUSED', limit: 1, decidedOn: 'FLOOR', reason: 'REWORK_INSTEAD' } })
    expect(refused.words).toMatch(/^The scrap of bundle .+ is refused: it does not post\. The scan's counts are put right by a correction\.$/)
    expect(await decisions(waiting)).toEqual([
      { recordType: 'OperationScan', actorId: lead, audience: 'FLOOR', after: { decision: 'REFUSED', scrapQuantity: 2, limit: 1, reason: 'REWORK_INSTEAD', note: null, decidedOn: 'FLOOR' }, reason: 'It can be repaired: rework' },
      { recordType: 'WorkOrder', actorId: lead, audience: 'FLOOR', after: { scanId: waiting, bundleId: seed.bundleIds[1], decision: 'REFUSED', scrapQuantity: 2, limit: 1, reason: 'REWORK_INSTEAD', note: null, decidedOn: 'FLOOR' }, reason: 'It can be repaired: rework' },
    ])
    expect((await decidedEvents(waiting)).map((row) => row.payload)).toEqual([
      { workOrderId: seed.workOrderId, number: expect.any(String), siteId: siteA1, bundleId: seed.bundleIds[1], scanId: waiting, decision: 'REFUSED', scrapQuantity: 2, limit: 1, decidedOn: 'FLOOR' },
    ])
    expect(refusalOf(await no('lead', 'POST', `/production/scrap/floor/waiting/${waiting}/refuse`, { reason: 'WRONG_COUNT' }, 409))).toBe('refusal/DECIDED_ALREADY')
    expect((await ok('lead', 'GET', '/production/scrap/floor/waiting')).rows).toEqual([])
    const recut = await askRecut('manager', waiting)
    expect(recut.statusCode).toBe(409)
    expect(refusalOf(recut.json().error)).toBe('refusal/SCRAP_REFUSED')
    expect(rowOf(await scrapRows(), waiting).approval).toMatchObject({ state: 'REFUSED', decidedOn: 'FLOOR', reason: 'REWORK_INSTEAD' })
  })

  it('the counts put right (an undo, a new report) wait again; the office approves and the replacement is asked', async () => {
    await undo(waiting)
    const again = await reportQc(2)
    expect(rowOf(await scrapRows(), again).approval.state).toBe('WAITING')
    const approved = await ok('manager', 'POST', `/production/scrap/over-limit/${again}/approve`, { note: 'Seen the hide: real flaw.' })
    expect(approved).toMatchObject({ approval: { state: 'APPROVED', decidedOn: 'OFFICE', note: 'Seen the hide: real flaw.' } })
    expect(approved.words).toMatch(/^2 pieces of bundle .+ approved as scrap: it posts now/)
    const recut = await askRecut('manager', again)
    expect(recut.statusCode, recut.body).toBe(201)
    expect((await scrapRows()).tiles.waitingApproval).toBe(0)
    // Approving many: each answered (one approved now, one decided already, one unknown).
    await undo(again)
    const third = await reportQc(2)
    const many = await ok('manager', 'POST', '/production/scrap/over-limit/approve', { scanIds: [third, again, newId()] })
    expect(many.approved).toEqual([third])
    expect(many.held.map((row: Json) => [row.scanId === again ? 'again' : row.code, row.code])).toEqual([
      ['again', 'DECIDED_ALREADY'],
      ['NOT_FOUND', 'NOT_FOUND'],
    ])
  })

  it('a scan whose scrap is not above the limit is refused a decision, in words', async () => {
    const error = await no('manager', 'POST', `/production/scrap/over-limit/${seed.scanIds[2]}/approve`, {}, 409)
    expect(refusalOf(error)).toBe('refusal/NOT_OVER_LIMIT')
    expect(error.message).toBe('0 pieces is not above the limit of 1 in force when the scan was taken: no approval is needed.')
  })
})

describe('the team leader approves on a real tablet with the PIN (a signing act)', () => {
  let tablet: Browser
  let pending: string

  beforeAll(async () => {
    const supervisor = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
    const browser = new Browser(h.app)
    const signedIn = await browser.signIn(TENANT.slug, supervisor.email, supervisor.password)
    if (signedIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
    const made = await browser.post('/auth/floor/devices', { siteId: siteA1, stationId: sew2, name: `Line tablet ${run}` })
    if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
    await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1', [lead, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
    tablet = new Browser(h.app)
    await tablet.get('/auth/csrf')
    const enrolled = await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
    if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
    const leadIn = await tablet.post('/floor/sign-in', { workerId: lead, pin: PIN })
    if (leadIn.status !== 200) throw new Error(`floor sign-in: ${leadIn.status} ${JSON.stringify(leadIn.body)}`)
    const third = (await admin<{ id: string }>('SELECT id FROM "OperationScan" WHERE "bundleId" = $1 AND "workOrderOperationId" = $2 AND kind = \'REPORT\' ORDER BY "serverTime" DESC LIMIT 1', [seed.bundleIds[1], seed.operationIds.qc]))[0]!.id
    await undo(third)
    pending = await reportQc(2)
  }, 180_000)

  it('asks the PIN again once the step-up window passed; with the PIN proved it approves (by the lead, on the floor)', async () => {
    h.clock.advance(3 * 60_000)
    const list = await tablet.get('/production/scrap/floor/waiting')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect((list.body as Json).rows.map((row: Json) => row.scanId)).toEqual([pending])
    const late = await tablet.post(`/production/scrap/floor/waiting/${pending}/approve`, {}, { headers: { 'idempotency-key': key() } })
    expect(late.status).toBe(403)
    expect((late.body as Json).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await decisions(pending)).toEqual([])
    const proved = await tablet.post('/floor/step-up', { pin: PIN })
    expect(proved.status, JSON.stringify(proved.body)).toBe(200)
    const approved = await tablet.post(`/production/scrap/floor/waiting/${pending}/approve`, {}, { headers: { 'idempotency-key': key() } })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect((approved.body as Json).approval).toMatchObject({ state: 'APPROVED', decidedOn: 'FLOOR' })
    expect((await decisions(pending)).map((row) => [row.recordType, row.actorId, row.audience])).toEqual([
      ['OperationScan', lead, 'FLOOR'],
      ['WorkOrder', lead, 'FLOOR'],
    ])
  })
})
