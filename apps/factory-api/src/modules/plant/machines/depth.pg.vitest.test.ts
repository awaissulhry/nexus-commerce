import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlantCare, type PlantCareSeed } from '../../../../../../packages/factory-db/seed/plantcare'
import { seed as seedPlant, type PlantSeed } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedPrint } from '../../../../../../packages/factory-db/seed/print'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Machines in depth (B-W2b-136; QHS-164, QHS-165, QHS-167; Owner answer H1; D.Lgs. 81/2008 art. 71) on the local stack with
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins, row-level security, the
 * column grants, the Machine guard and lock, and the trigger that writes the status history are real), the factory-db seeds
 * up to the plant care seed and the print seed (a label printer LBL-01 at A1). The seeded machines: SEED-SEW-L1-01 (running),
 * SEED-CP-01 (the press, locked as unsafe, with its check plans), SEED-CT-01 (the cutting table). A real maintenance lead
 * with two-factor for the release of a do-not-use machine. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/plant/machines`.
 */

let h: Harness
let app: FastifyInstance
let plant: PlantSeed
let care: PlantCareSeed

const ns = 'plant-machines-depth'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), actor: idOf('actor'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const TENANT: TestTenant = { id: A.tenant, slug: ns, companies: [{ id: A.companyA, code: 'A' }] }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  // A maintenance lead who is a technician: keeps the machines, signs safe, prints labels.
  manager: office(['plant.view', 'plant.machines.manage', 'plant.report', 'plant.jobs.manage', 'plant.jobs.work', 'plant.signSafe', 'plant.checks.manage', 'print.view', 'print.labels']),
  // Keeps the machines (the production manager): sets do-not-use, never releases it.
  keeper: office(['plant.view', 'plant.machines.manage']),
  viewer: office(['plant.view']),
  // Company A's site A1 only.
  siteOnly: { audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: [{ permissions: ['plant.view', 'plant.machines.manage'], companies: [A.companyA], sites: [idOf('site:A2')], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `md-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const outbox = (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [A.tenant, type, subject])
const today = businessDate(new Date())

let sewMachine: string
let pressMachine: string
let tableMachine: string
let maintenance: { browser: Browser; secret: string }

beforeAll(async () => {
  h = await startHarness('plant_machines_depth')
  await seedCore({ db: h.database, namespace: ns })
  await seedPrivacy({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await seedPrint({ db: h.database, namespace: ns })
  plant = await seedPlant({ db: h.database, namespace: ns })
  care = await seedPlantCare({ db: h.database, namespace: ns })
  ;[sewMachine, pressMachine, tableMachine] = plant.machineIds
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  const user = await addUser(h, TENANT, { email: `machines-${run}@example.test`, role: 'maintenance' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  maintenance = { browser, secret: await enrolTotp(h, browser) }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const machine = async (id: string) => (await ok('viewer', 'GET', `/plant/machines/${id}`)).card.machine as Json

describe('Change status and the status history (QHS-167; Owner answer H1)', () => {
  it('moves a machine by hand with its reason; the trigger writes the history; machine.status_changed says CHANGE', async () => {
    const before = await machine(sewMachine)
    expect(before.status).toBe('RUNNING')
    expect(await no('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version, to: 'DOWN', reason: ' ' }, 400)).toMatchObject({ code: 'validation_failed' })
    const moved = await ok('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version, to: 'DOWN', reason: 'Motor overheats (made-up)' })
    expect(moved.machine).toMatchObject({ status: 'DOWN', statusReason: 'Motor overheats (made-up)', version: before.version + 1 })
    const rows = await admin(`SELECT "fromStatus"::text AS "from", "toStatus"::text AS "to", reason FROM "MachineStatusEvent" WHERE "machineId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [sewMachine])
    expect(rows[0]).toEqual({ from: 'RUNNING', to: 'DOWN', reason: 'Motor overheats (made-up)' })
    expect((await outbox('machine.status_changed', sewMachine)).at(-1)!.payload).toMatchObject({ from: 'RUNNING', to: 'DOWN', cause: 'CHANGE', recordType: 'Machine', by: 'OFFICE', locked: false })
    expect(refusalOf(await no('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version + 1, to: 'DOWN', reason: 'Again' }, 409))).toBe('refusal/SAME_STATUS')
    expect(await no('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version, to: 'RUNNING', reason: 'Old version' }, 409)).toMatchObject({ code: 'conflict' })
    expect(await no('viewer', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version + 1, to: 'RUNNING', reason: 'Not mine' }, 403)).toMatchObject({ code: 'forbidden' })
    expect(await no('siteOnly', 'POST', `/plant/machines/${sewMachine}/status`, { version: before.version + 1, to: 'RUNNING', reason: 'Another site' }, 404)).toMatchObject({ code: 'not_found' })
  })

  it('never frees a machine locked as unsafe: its request\'s sign-safe does (H1)', async () => {
    const press = await machine(pressMachine)
    expect(press).toMatchObject({ status: 'DO_NOT_USE', locked: true })
    expect(refusalOf(await no('manager', 'POST', `/plant/machines/${pressMachine}/status`, { version: press.version, to: 'UNDER_MAINTENANCE', reason: 'Try to free it' }, 409))).toBe('refusal/LOCKED_UNSAFE')
  })

  it('do-not-use by hand needs its reason; only a technician releases it, with a fresh code', async () => {
    const down = await machine(sewMachine)
    const set = await ok('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: down.version, to: 'DO_NOT_USE', reason: 'Guard cracked, waiting for the part (made-up)' })
    expect(set.machine).toMatchObject({ status: 'DO_NOT_USE', locked: false })
    expect(await no('keeper', 'POST', `/plant/machines/${sewMachine}/status`, { version: set.machine.version, to: 'RUNNING', reason: 'Part fitted' }, 403)).toMatchObject({ code: 'forbidden' })
    // A test session has no fresh code: the release is refused before anything is written.
    expect((await call('manager', 'POST', `/plant/machines/${sewMachine}/status`, { version: set.machine.version, to: 'RUNNING', reason: 'Part fitted' })).statusCode).not.toBe(200)
    expect((await machine(sewMachine)).status).toBe('DO_NOT_USE')
    await stepUp(h, maintenance.browser, maintenance.secret)
    const released = await maintenance.browser.send('POST', `/plant/machines/${sewMachine}/status`, { version: set.machine.version, to: 'RUNNING', reason: 'Part fitted, guard checked (made-up)' }, { headers: { 'idempotency-key': freshKey() } })
    expect(released.status, JSON.stringify(released.body)).toBe(200)
    expect(released.body.machine).toMatchObject({ status: 'RUNNING', statusReason: 'Part fitted, guard checked (made-up)' })
  })

  it('reads the history of a window: the status before it, every change with its reason, no person', async () => {
    const history = await ok('viewer', 'GET', `/plant/machines/${sewMachine}/status-history?from=${today}&days=1`)
    expect(history.events.map((event: Json) => [event.from, event.to])).toEqual([
      ['RUNNING', 'DOWN'],
      ['DOWN', 'DO_NOT_USE'],
      ['DO_NOT_USE', 'RUNNING'],
    ])
    expect(history.events[1].reason).toBe('Guard cracked, waiting for the part (made-up)')
    expect(history.current).toMatchObject({ status: 'RUNNING' })
    expect(history.latest[0]).toMatchObject({ from: 'DO_NOT_USE', to: 'RUNNING' })
    expect(JSON.stringify(history)).not.toMatch(/userId|workerId|actorId|createdById/)
    const week = await ok('viewer', 'GET', `/plant/machines/${tableMachine}/status-history?from=${today}&days=7`)
    expect(Date.parse(week.to) - Date.parse(week.from)).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000)
    expect(week.current).toMatchObject({ status: expect.any(String) })
    expect(await no('viewer', 'GET', `/plant/machines/${tableMachine}/status-history?from=${today}&days=40`, undefined, 400)).toMatchObject({ code: 'validation_failed' })
  })
})

describe('Documents & CE (QHS-165; art. 71 c.4)', () => {
  const bytes = Buffer.from(`%PDF-1.4 made-up CE declaration ${run}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const body = { group: 'MACHINE_CE', kind: 'DOCUMENT', originalName: 'ce-declaration.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256 }
  let fileId: string

  it('files the CE declaration of a machine (shared with its site\'s tablets); the tile and the depth read see it', async () => {
    const before = await ok('viewer', 'GET', `/plant/machines/depth?ids=${tableMachine}`)
    expect(before.machines[0]).toMatchObject({ id: tableMachine, ceOnFile: false, manuals: 0 })
    expect(await no('viewer', 'POST', `/plant/machines/${tableMachine}/documents`, body, 403)).toMatchObject({ code: 'forbidden' })
    expect(refusalOf(await no('keeper', 'POST', `/plant/machines/${tableMachine}/documents`, { ...body, kind: 'PHOTO', contentType: 'image/jpeg' }, 409))).toBe('refusal/DOCUMENT_KIND')
    const announced = await ok('keeper', 'POST', `/plant/machines/${tableMachine}/documents`, body, 201)
    expect(announced.document).toMatchObject({ group: 'MACHINE_CE', status: 'PENDING_UPLOAD', onTablets: true })
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBe(200)
    const done = await ok('keeper', 'POST', `/plant/machines/${tableMachine}/documents/${announced.document.id}/complete`)
    expect(done.document).toMatchObject({ status: 'AVAILABLE', group: 'MACHINE_CE', onTablets: true })
    fileId = done.document.id
    const row = (await admin(`SELECT category::text AS category, visibility::text[] AS visibility, "floorSiteId", "createdById" FROM "StoredFile" WHERE id = $1`, [fileId]))[0]!
    expect(row).toMatchObject({ category: 'MACHINE_CE', visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.siteA1 })
    const list = await ok('viewer', 'GET', `/plant/machines/${tableMachine}/documents`)
    expect(list).toMatchObject({ ceOnFile: true, canManage: false, documents: [{ id: fileId, group: 'MACHINE_CE', originalName: 'ce-declaration.pdf' }] })
    expect((await ok('keeper', 'GET', `/plant/machines/${tableMachine}/documents`)).canManage).toBe(true)
    const after = await ok('viewer', 'GET', `/plant/machines/depth?ids=${tableMachine}`)
    expect(after.machines[0].ceOnFile).toBe(true)
    expect(after.tiles.noCe).toBe(before.tiles.noCe - 1)
    const missing = await ok('viewer', 'GET', '/plant/machines/attention?need=CE')
    expect(missing.machines.map((row: Json) => row.id)).not.toContain(tableMachine)
    expect(missing.machines.map((row: Json) => row.id)).toContain(sewMachine)
  })

  it('opens it for a look, and removes a wrong one with the reason', async () => {
    const look = await ok('viewer', 'GET', `/plant/machines/${tableMachine}/documents/${fileId}/download`)
    expect(look).toMatchObject({ fileName: 'ce-declaration.pdf', contentType: 'application/pdf', download: { method: 'GET' } })
    expect(await no('viewer', 'GET', `/plant/machines/${sewMachine}/documents/${fileId}/download`, undefined, 404)).toMatchObject({ code: 'not_found' })
    const manual = Buffer.from(`%PDF-1.4 made-up manual ${run}`)
    const announced = await ok('keeper', 'POST', `/plant/machines/${tableMachine}/documents`, { ...body, group: 'MANUAL', originalName: 'manual.pdf', sizeBytes: manual.length, sha256: createHash('sha256').update(manual).digest('hex'), onTablets: false }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: manual })).statusCode).toBe(200)
    const done = (await ok('keeper', 'POST', `/plant/machines/${tableMachine}/documents/${announced.document.id}/complete`)).document
    expect(done).toMatchObject({ group: 'MANUAL', onTablets: false })
    expect((await ok('viewer', 'GET', `/plant/machines/depth?ids=${tableMachine}`)).machines[0].manuals).toBe(1)
    expect(await no('viewer', 'POST', `/plant/machines/${tableMachine}/documents/${done.id}/remove`, { version: done.version, reason: 'Wrong file' }, 403)).toMatchObject({ code: 'forbidden' })
    expect((await ok('keeper', 'POST', `/plant/machines/${tableMachine}/documents/${done.id}/remove`, { version: done.version, reason: 'Wrong model (made-up)' })).removed).toBe(done.id)
    expect((await ok('viewer', 'GET', `/plant/machines/${tableMachine}/documents`)).documents.map((row: Json) => row.id)).toEqual([fileId])
  })
})

describe('the register\'s depth, the tiles as filters and the status wall', () => {
  it('counts the machines with a check overdue as the plans say, and lists them', async () => {
    const overdue = await admin(`SELECT DISTINCT p."machineId" FROM "MachineCheckPlan" p JOIN "Machine" m ON m.id = p."machineId" WHERE p."tenantId" = $1 AND p.status = 'ACTIVE' AND p."nextDueOn" < $2::date AND m.status <> 'RETIRED'`, [A.tenant, today])
    const depth = await ok('viewer', 'GET', `/plant/machines/depth?ids=${pressMachine},${sewMachine}`)
    expect(depth.tiles.checksOverdue).toBe(overdue.length)
    const press = depth.machines.find((row: Json) => row.id === pressMachine)
    expect(press.nextCheck).toMatchObject({ checkType: { code: expect.any(String) } })
    expect(depth.machines.find((row: Json) => row.id === sewMachine).nextCheck).toBeNull()
    const listed = await ok('viewer', 'GET', '/plant/machines/attention?need=CHECKS')
    expect(listed.machines.map((row: Json) => row.id).sort()).toEqual(overdue.map((row) => row.machineId).sort())
  })

  it('draws every machine in use by line, with its status and the counts', async () => {
    const wall = await ok('viewer', 'GET', `/plant/machines/wall?siteId=${A.siteA1}`)
    const tiles = wall.lines.flatMap((line: Json) => line.machines)
    expect(tiles.map((tile: Json) => tile.id)).toEqual(expect.arrayContaining([sewMachine, pressMachine, tableMachine]))
    expect(tiles.find((tile: Json) => tile.id === pressMachine)).toMatchObject({ status: 'DO_NOT_USE', locked: true })
    expect(wall.counts.DO_NOT_USE).toBeGreaterThanOrEqual(1)
    expect(wall.counts.locked).toBeGreaterThanOrEqual(1)
    expect(wall.truncated).toBe(false)
    expect(JSON.stringify(wall)).not.toMatch(/purchaseCost|supplier/)
  })
})

describe('QR tags to a label printer (QHS-164)', () => {
  it('lists the label printers, queues one tag per machine, refuses a retired one in words, reads the newest job', async () => {
    const printers = (await ok('manager', 'GET', `/plant/machines/tags/printers?siteId=${A.siteA1}`)).printers
    expect(printers).toEqual([expect.objectContaining({ code: 'LBL-01', labelWidthMm: 100, labelHeightMm: 50, dpi: 203, siteCode: 'A1' })])
    expect(await no('keeper', 'GET', `/plant/machines/tags/printers?siteId=${A.siteA1}`, undefined, 403)).toMatchObject({ code: 'forbidden' })
    const made = (await ok('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `TAG-${run}`.toUpperCase(), classId: Object.values(plant.classIds)[0] }, 201)).machine
    const retired = (await ok('manager', 'POST', `/plant/machines/${made.id}/retire`, { version: made.version, reason: 'Sold (made-up)' })).machine
    expect(retired.status).toBe('RETIRED')
    const printed = await ok('manager', 'POST', '/plant/machines/tags/print', { printerId: printers[0].id, machineIds: [sewMachine, tableMachine, made.id], copies: 2, language: 'en' })
    expect(printed.jobs.map((job: Json) => [job.machineId, job.state, job.copies, job.printerCode])).toEqual(
      expect.arrayContaining([
        [sewMachine, 'QUEUED', 2, 'LBL-01'],
        [tableMachine, 'QUEUED', 2, 'LBL-01'],
      ]),
    )
    expect(printed.refused).toEqual([expect.objectContaining({ machineId: made.id, code: 'TAG_RETIRED' })])
    const zpl = (await admin(`SELECT zpl, "labelKind", "scanId" FROM "PrintJob" WHERE id = $1`, [printed.jobs[0].jobId]))[0]!
    expect(zpl.labelKind).toBe('MACHINE')
    expect(zpl.zpl).toContain('^BQN,2,')
    expect(zpl.zpl).toContain('Scan to report a problem')
    const jobs = (await ok('viewer', 'GET', `/plant/machines/tags/jobs?ids=${sewMachine},${pressMachine}`)).jobs
    expect(jobs).toEqual([expect.objectContaining({ machineId: sewMachine, state: 'QUEUED' })])
    expect((await ok('viewer', 'GET', `/plant/machines/depth?ids=${sewMachine}`)).machines[0].tag).toMatchObject({ state: 'QUEUED', printedAt: null })
    // The generic print job answer knows the machine tag's label kind.
    expect((await ok('manager', 'GET', `/print/jobs/${printed.jobs[0].jobId}`)).job).toMatchObject({ labelKind: 'MACHINE', recordType: 'Machine' })
  })
})

describe('Retire ends the machine\'s check plans (design pop:retire "Plans end, kept for history")', () => {
  it('ends every active plan in the retire command', async () => {
    const types = (await ok('manager', 'GET', '/plant/checks/types?active=true')).types as Json[]
    const type = types.find((entry) => entry.machineClass === null) ?? types[0]!
    const made = (await ok('manager', 'POST', '/plant/machines', { siteId: A.siteA1, assetNumber: `RET-${run}`.toUpperCase(), classId: type.machineClass?.id ?? Object.values(plant.classIds)[0] }, 201)).machine
    await ok('manager', 'POST', '/plant/checks/plans', { machineId: made.id, checkTypeId: type.id, firstDueOn: today }, 201)
    const fresh = await machine(made.id)
    await ok('manager', 'POST', `/plant/machines/${made.id}/retire`, { version: fresh.version, reason: 'Scrapped (made-up)' })
    const plans = await admin(`SELECT status::text AS status, "endedReason" FROM "MachineCheckPlan" WHERE "machineId" = $1`, [made.id])
    expect(plans).toEqual([{ status: 'ENDED', endedReason: expect.stringContaining('Scrapped (made-up)') }])
    expect(care.planIds.guards).toBeTruthy()
  })
})
