import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Piece rates and the legal switch of piece pay (B-W2b-34; MES-254, MES-255, MES-262; W2b plan §3 GATE-PIECE-PAY) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security,
 * the grants and the …_pay_w2b_guards triggers are real), on the seeds up to people: plant A1 names workers on a made-up
 * RSU agreement (Production › Settings), company A has a published worker notice and a stored DPIA, A1's two floor
 * workers are linked to employees E1 and E2; no piece-pay row, no scheme, no payroll code, no PERFORMANCE gate (this file
 * opts in to each itself). Every person, rate and reference is made up. The law the tests name: c.c. art. 2100 (piece
 * work where the CCNL allows it), art. 2101 (rates told to the workers before they apply; they change only by a new
 * version), Statuto dei Lavoratori art. 4 c.1 and c.3, GDPR arts. 13 and 35; the pay grain: HR and the worker only.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/people/piecerates`.
 */

// Each test walks several real routes (and the tablet hashes a PIN): more than vitest's 5 s under a loaded machine.
vi.setConfig({ testTimeout: 60_000 })

let h: Harness
let app: FastifyInstance

const NS = 'w2b34-piecerates'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const lineL1 = idOf('site:A1:line:L1')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const OPERATOR_NAME = 'Seed Worker A1-1'
const ops = { cut: idOf('product:operation:CUT'), sew: idOf('product:operation:SEW'), pack: idOf('product:operation:PACK') }
const styleId = idOf('production:style:JKT-02')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const PIN = '518274'
const device = newId()

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const floor = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: T, actorId, siteId: siteA1, deviceId: device, grants: [grant(permissions, [companyA], [siteA1])] })
const MANAGE: Permission[] = ['people.piecerates.view', 'people.piecerates.manage']
const SESSIONS: Record<string, SessionContext> = {
  hr: office([grant([...MANAGE, 'money.pay' as Permission])]),
  managerNoPay: office([grant(MANAGE)]),
  viewer: office([grant([...(templateOf('production_manager')?.permissions ?? [])])]),
  companyB: office([grant([...MANAGE, 'money.pay' as Permission], [companyB])]),
  plain: office([grant(['home.view'])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant([...MANAGE, 'money.pay' as Permission])] },
  floorOperator: floor(operator, ['floor.work', 'money.pay' as Permission]),
  floorLeadNoPay: floor(lead, ['floor.work']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
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
const outbox = (type: string) => admin('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const auditOf = (action: string) => admin('SELECT "recordId", before, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T, action])
const versionRow = async (id: string) => (await admin('SELECT status::text AS status, "effectiveTo"::text AS "effectiveTo", "confirmedAt", "confirmedById", version FROM "PieceRateVersion" WHERE id = $1', [id]))[0]!
const switchRow = async () => (await admin('SELECT state::text AS state, "onFrom"::text AS "onFrom", "offFrom"::text AS "offFrom", "offReason", "earlierWindows", version FROM "PiecePaySwitch" WHERE id = $1', [siteA1]))[0]

const today = businessDate(new Date())
const day = (offset: number) => plusDays(today, offset)

/** The person who keeps piece pay and the people data gates (the Owner's permissions), with two-factor. */
let keeper: { browser: Browser; secret: string }
let tableId = ''
let v1 = ''
let v2 = ''

beforeAll(async () => {
  h = await startHarness('people_piecerates')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedPeople({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const keeperUser = await addUser(h, TENANT, { email: `pay.keeper-${run}@example.test` })
  const roleId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.role.create({ data: { id: roleId, key: 'custom.paykeeper', name: 'Pay keeper', permissions: ['people.piecerates.manage', 'people.piecerates.switch', 'people.piecerates.view', 'people.privacy.manage', 'people.privacy.view'], grains: ['pay'], requireMfa: false, audience: 'OFFICE' } })
    await client.roleAssignment.create({ data: { id: newId(), userId: keeperUser.id, roleId, allCompanies: true, companyIds: [], siteIds: [], validFrom: new Date('2026-10-01T00:00:00.000Z') } })
  })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, keeperUser.email, keeperUser.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  keeper = { browser, secret: await enrolTotp(h, browser) }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('rate tables in versions (MES-254; c.c. art. 2101: a rate changes only by a new version with a reason)', () => {
  it('adds a table for a style at a site; a taken code, another company and a role without the permission are refused', async () => {
    const made = await ok('hr', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code: 'jkt-02', name: 'Jacket JKT-02', styleId }, 201)
    tableId = made.table.id
    expect(made.table).toMatchObject({ code: 'JKT-02', currency: 'EUR', status: 'ACTIVE', fixed: false, style: { id: styleId } })
    expect(made.versions).toEqual([])
    expect((await no('hr', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code: 'JKT-02', name: 'Again' }, 400)).issues).toEqual([{ path: 'code', message: 'Taken at this site.' }])
    await no('viewer', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code: 'X1', name: 'X' }, 403)
    await no('companyB', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code: 'X1', name: 'X' }, 404)
    await no('otherTenant', 'GET', `/people/piece-rates/tables/${tableId}`, undefined, 404)
    expect((await outbox('piece_rate_table.changed')).map((row) => row.payload)).toEqual([{ tableId, siteId: siteA1, change: 'CREATED' }])
  })

  it('makes a DRAFT with why and its rates: SMV × rate per minute (the operation\'s SMV when none is typed) or fixed', async () => {
    const made = await ok(
      'hr',
      'POST',
      `/people/piece-rates/tables/${tableId}/versions`,
      {
        changeReason: 'NEW',
        effectiveFrom: today,
        rates: [
          { operationId: ops.sew, basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12' },
          { operationId: ops.pack, basis: 'FIXED', ratePerPiece: '0.30' },
          { operationId: ops.cut, basis: 'SMV_RATE', ratePerMinute: '0.10' },
        ],
      },
      201,
    )
    v1 = made.version.id
    expect(made.version).toMatchObject({ versionNo: 1, status: 'DRAFT', state: 'DRAFT', rateCount: 3, publishedOn: null, readBy: { read: 0, of: 0 } })
    const byCode = new Map(made.rates.map((rate: Json) => [rate.operation.id, rate]))
    expect(byCode.get(ops.sew)).toMatchObject({ basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12', ratePerPiece: '11.58' })
    expect(byCode.get(ops.pack)).toMatchObject({ basis: 'FIXED', ratePerMinute: null, ratePerPiece: '0.3' })
    const cutSmv = (await admin<{ smv: string }>('SELECT "standardMinutes"::text AS smv FROM "Operation" WHERE id = $1', [ops.cut]))[0]!.smv
    expect(Number((byCode.get(ops.cut) as Json).standardMinutes)).toBe(Number(cutSmv))
    expect(made.actions.putInForce).toMatchObject({ allowed: false, refusal: { code: 'NOT_PUBLISHED' } })
    const bad = await no('hr', 'PUT', `/people/piece-rates/versions/${v1}/rates`, { version: made.version.version, rates: [{ operationId: ops.sew, basis: 'SMV_RATE', standardMinutes: '10', ratePerMinute: '0.1', ratePerPiece: '9.99' }] }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['rates/0/ratePerPiece'])
  })

  it('hides every pay figure from a role without the pay grain, and refuses a rate sent by one (operations and SMVs only)', async () => {
    const seen = await ok('viewer', 'GET', `/people/piece-rates/versions/${v1}`)
    expect(seen.payShown).toBe(false)
    expect(seen.rates.length).toBe(3)
    for (const rate of seen.rates) {
      expect(rate).not.toHaveProperty('ratePerPiece')
      expect(rate).not.toHaveProperty('ratePerMinute')
      if (rate.basis === 'SMV_RATE') expect(rate.standardMinutes).not.toBeNull()
    }
    const grid = await ok('viewer', 'GET', `/people/piece-rates/rates?siteId=${siteA1}`)
    expect(grid.rows.length).toBe(3)
    expect(JSON.stringify(grid.rows)).not.toContain('11.58')
    const typed = await call('managerNoPay', 'PUT', `/people/piece-rates/versions/${v1}/rates`, { version: seen.version.version, rates: [{ operationId: ops.pack, basis: 'FIXED', ratePerPiece: '0.40' }] })
    expect(typed.statusCode).toBe(403)
    expect((await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)).payShown).toBe(true)
  })
})

describe('publishing rates to the workers (MES-255; c.c. art. 2101 c.3: told before they apply)', () => {
  it('previews who receives it (names inside this dialog only), then publishes and puts the DRAFT in force in one step', async () => {
    const preview = await ok('hr', 'GET', `/people/piece-rates/versions/${v1}/publish/preview`)
    expect(preview).toMatchObject({ count: 2, newCount: 2, withoutEmployee: 0, refusal: null })
    expect(preview.workers.map((worker: Json) => worker.workerId).sort()).toEqual([operator, lead].sort())
    const current = await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)
    const published = await ok('hr', 'POST', `/people/piece-rates/versions/${v1}/publish`, { version: current.version.version, onFloor: true, printed: true }, 201)
    expect(published.version).toMatchObject({ status: 'PUBLISHED', state: 'CONFIRMED', inForceToday: true, publishedOn: today, readBy: { read: 0, of: 2 } })
    expect(published.publications).toHaveLength(1)
    expect(published.publications[0]).toMatchObject({ status: 'PUBLISHED', onFloor: true, printed: true, readBy: { read: 0, of: 2 } })
    expect(published.publications[0].workers.map((worker: Json) => worker.read)).toEqual([null, null])
    expect((await outbox('rate_publication.changed')).map((row) => row.payload)).toEqual([{ publicationId: published.publications[0].id, versionId: v1, siteId: siteA1, lineId: null, change: 'PUBLISHED', workers: 2 }])
    expect((await outbox('piece_rate_version.changed')).map((row) => row.payload.change)).toEqual(['CREATED', 'IN_FORCE'])
    expect(JSON.stringify((await outbox('rate_publication.changed')).concat(await outbox('piece_rate_version.changed')))).not.toContain(OPERATOR_NAME)
    expect((await auditOf('people.publishRates'))[0]!.after).toMatchObject({ versionId: v1, workers: 2, onFloor: true, printed: true })
    // Everyone told already: nothing more to publish.
    await no('hr', 'POST', `/people/piece-rates/versions/${v1}/publish`, { version: published.version.version }, 409)
  })

  it('keeps the rates in force frozen: the API refuses an edit, and so does the database for any login', async () => {
    const detail = await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)
    const refused = await no('hr', 'PUT', `/people/piece-rates/versions/${v1}/rates`, { version: detail.version.version, rates: [] }, 409)
    expect(refused.issues[0].path).toBe('refusal/NOT_DRAFT')
    await expect(admin('UPDATE "PieceRateEntry" SET "ratePerPiece" = 1 WHERE "versionId" = $1', [v1])).rejects.toThrow(/its rates are written only while it is a DRAFT/)
    const table = await ok('hr', 'GET', `/people/piece-rates/tables/${tableId}`)
    expect(table.table.fixed).toBe(true)
    await no('hr', 'PATCH', `/people/piece-rates/tables/${tableId}`, { version: table.table.version, styleId: null }, 409)
  })

  it('makes a provisional version with a trial (MES-262) that supersedes the one before from its first day', async () => {
    const made = await ok('hr', 'POST', `/people/piece-rates/tables/${tableId}/versions`, { changeReason: 'METHOD_CHANGED', changeNote: 'New folder on the sewing machine.', effectiveFrom: day(30), provisional: true, trialEndsOn: day(60) }, 201)
    v2 = made.version.id
    expect(made.version).toMatchObject({ versionNo: 2, provisional: true, trialEndsOn: day(60), rateCount: 3 })
    const rates = made.rates.map((rate: Json) => ({ operationId: rate.operation.id, basis: rate.basis, standardMinutes: rate.operation.id === ops.sew ? '90' : rate.standardMinutes, ratePerMinute: rate.ratePerMinute, ratePerPiece: rate.basis === 'FIXED' ? rate.ratePerPiece : null }))
    const set = await ok('hr', 'PUT', `/people/piece-rates/versions/${v2}/rates`, { version: made.version.version, rates })
    expect(set.rates.find((rate: Json) => rate.operation.id === ops.sew).ratePerPiece).toBe('10.8')
    const published = await ok('hr', 'POST', `/people/piece-rates/versions/${v2}/publish`, { version: set.version.version, lineId: lineL1, workerIds: [operator, lead] }, 201)
    expect(published.version).toMatchObject({ status: 'PROVISIONAL', state: 'PROVISIONAL', stateWords: `Provisional until ${day(60)}.`, inForceToday: false })
    expect(await versionRow(v1)).toMatchObject({ status: 'SUPERSEDED', effectiveTo: day(29) })
    // One command supersedes v1 and puts v2 in force: their two events share the moment.
    expect((await outbox('piece_rate_version.changed')).map((row) => row.payload.change).sort()).toEqual(['CREATED', 'CREATED', 'IN_FORCE', 'IN_FORCE', 'RATES_SET', 'SUPERSEDED'])
    // The trial runs: it is confirmed from its last day, or replaced by a new version before.
    const early = await no('hr', 'POST', `/people/piece-rates/versions/${v2}/confirm`, { version: published.version.version }, 409)
    expect(early.issues[0].path).toBe('refusal/TRIAL_RUNNING')
    const grid = await ok('hr', 'GET', `/people/piece-rates/rates?siteId=${siteA1}`)
    expect(new Set(grid.rows.map((row: Json) => row.version.versionNo))).toEqual(new Set([1, 2]))
  })

  it('confirms provisional rates after their trial, one or many at once (all or none)', async () => {
    const trialVersion = async (code: string) => {
      const table = await ok('hr', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code, name: `Trial ${code}` }, 201)
      const id = newId()
      await admin(
        `INSERT INTO "PieceRateVersion" (id, "tenantId", "companyId", "siteId", "tableId", "versionNo", "changeReason", "effectiveFrom", provisional, "trialEndsOn", "updatedAt") VALUES ($1, $2, $3, $4, $5, 1, 'NEW', $6, true, $7, now())`,
        [id, T, companyA, siteA1, table.table.id, day(-10), day(-1)],
      )
      await admin(`INSERT INTO "PieceRateEntry" (id, "tenantId", "siteId", "versionId", "operationId", basis, "ratePerPiece", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'FIXED', 0.5, now())`, [newId(), T, siteA1, id, ops.pack])
      await admin(`INSERT INTO "RatePublication" (id, "tenantId", "companyId", "siteId", "versionId", "workerIds", "publishedAt", "publishedById", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`, [newId(), T, companyA, siteA1, id, [operator], `${day(-11)}T10:00:00.000Z`, newId()])
      await admin(`UPDATE "PieceRateVersion" SET status = 'PROVISIONAL' WHERE id = $1`, [id])
      return id
    }
    const one = await trialVersion('TRIAL-1')
    const two = await trialVersion('TRIAL-2')
    const confirmed = await ok('hr', 'POST', `/people/piece-rates/versions/${one}/confirm`, { version: 1 })
    expect(confirmed.version).toMatchObject({ status: 'PUBLISHED', state: 'CONFIRMED', stateWords: 'Confirmed after its trial.' })
    expect((await versionRow(one)).confirmedAt).not.toBeNull()
    const preview = await ok('hr', 'POST', '/people/piece-rates/versions/confirm/preview', { ids: [two, v2] })
    expect(preview.canConfirm).toBe(1)
    expect(preview.rows.find((row: Json) => row.id === v2).refusal.code).toBe('TRIAL_RUNNING')
    const v2Version = (await versionRow(v2)).version
    const mixed = await no('hr', 'POST', '/people/piece-rates/versions/confirm', { items: [{ id: two, version: 1 }, { id: v2, version: v2Version }] }, 409)
    expect(mixed.issues.map((issue: Json) => issue.path)).toEqual(['items/1'])
    expect((await versionRow(two)).status).toBe('PROVISIONAL')
    expect((await ok('hr', 'POST', '/people/piece-rates/versions/confirm', { items: [{ id: two, version: 1 }] })).confirmed).toHaveLength(1)
    expect((await versionRow(two)).status).toBe('PUBLISHED')
  })

  it('withdraws a wrong publication of a DRAFT (with why), never one of rates in force', async () => {
    const made = await ok('hr', 'POST', `/people/piece-rates/tables/${tableId}/versions`, { changeReason: 'CORRECTION', changeNote: 'Packing rate typed wrong.', effectiveFrom: day(90) }, 201)
    const published = await ok('hr', 'POST', `/people/piece-rates/versions/${made.version.id}/publish`, { version: made.version.version, workerIds: [operator], putInForce: false }, 201)
    expect(published.version.status).toBe('DRAFT')
    const publication = published.publications[0]
    await no('hr', 'POST', `/people/piece-rates/publications/${publication.id}/withdraw`, { version: publication.version, reason: '' }, 400)
    const withdrawn = await ok('hr', 'POST', `/people/piece-rates/publications/${publication.id}/withdraw`, { version: publication.version, reason: 'Sent to the wrong line.' })
    expect(withdrawn.publications[0]).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'Sent to the wrong line.' })
    const inForce = (await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)).publications[0]
    expect((await no('hr', 'POST', `/people/piece-rates/publications/${inForce.id}/withdraw`, { version: inForce.version, reason: 'Try it.' }, 409)).issues[0].path).toBe('refusal/NOT_DRAFT')
    await ok('hr', 'POST', `/people/piece-rates/versions/${made.version.id}/cancel`, { version: withdrawn.version.version, reason: 'Not needed after all.' })
  })
})

describe('who has read the rates: a receipt per worker (MES-255, AckTracker; c.c. art. 2101)', () => {
  it('records signed paper copies in the office, once per worker; a worker the publication did not reach is refused', async () => {
    const publication = (await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)).publications[0]
    const recorded = await ok('hr', 'POST', `/people/piece-rates/publications/${publication.id}/paper-receipts`, { workerIds: [lead] })
    expect(recorded).toMatchObject({ recorded: 1, already: 0 })
    expect(recorded.version.readBy).toEqual({ read: 1, of: 2 })
    expect(recorded.publications[0].workers.find((worker: Json) => worker.workerId === lead).read.channel).toBe('PAPER')
    expect((await ok('hr', 'POST', `/people/piece-rates/publications/${publication.id}/paper-receipts`, { workerIds: [lead] })).recorded).toBe(0)
    await no('hr', 'POST', `/people/piece-rates/publications/${publication.id}/paper-receipts`, { workerIds: [idOf('worker:B1:operator')] }, 400)
    expect((await outbox('rate.read')).map((row) => row.payload)).toEqual([{ publicationId: publication.id, versionId: v1, siteId: siteA1, channel: 'PAPER', receipts: 1 }])
    await expect(admin('DELETE FROM "RateAcknowledgement" WHERE "publicationId" = $1', [publication.id])).rejects.toThrow(/append-only/)
  })

  it('shows a worker the rates published to them on the floor, the pay figure only with the pay grain; never another\'s', async () => {
    const mine = await ok('floorOperator', 'GET', '/people/piece-rates/floor/mine')
    const own = mine.publications.find((row: Json) => row.versionId === v1)
    // Version 1 pays until the day before version 2's first day: superseded, still in force today.
    expect(own).toMatchObject({ versionNo: 1, state: 'SUPERSEDED', effectiveTo: day(29), read: null })
    expect(own.rates.find((rate: Json) => rate.operation.code === 'SEED-SEW-ASM').ratePerPiece).toBe('11.58')
    expect(mine.publications.some((row: Json) => row.versionId === v2)).toBe(true)
    const theirs = await ok('floorLeadNoPay', 'GET', '/people/piece-rates/floor/mine')
    expect(theirs.publications.find((row: Json) => row.versionId === v1).read.channel).toBe('PAPER')
    expect(JSON.stringify(theirs)).not.toContain('11.58')
    // The trial tables went to the operator only.
    expect(theirs.publications.length).toBeLessThan(mine.publications.length)
  })

  it('records the worker\'s own reading on the tablet with the PIN again (a signing act), once', async () => {
    const supervisor = await addUser(h, TENANT, { email: `supervisor-${run}@example.test`, role: 'floor_supervisor' })
    const browser = new Browser(h.app)
    const signedIn = await browser.signIn(TENANT.slug, supervisor.email, supervisor.password)
    if (signedIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
    const made = await browser.post('/auth/floor/devices', { siteId: siteA1, name: `Rates tablet ${run}` })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1', [operator, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
    const tablet = new Browser(h.app)
    await tablet.get('/auth/csrf')
    expect((await tablet.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })).status).toBe(200)
    expect((await tablet.post('/floor/sign-in', { workerId: operator, pin: PIN })).status).toBe(200)
    const mine = await tablet.get('/people/piece-rates/floor/mine')
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    const own = (mine.body as Json).publications.find((row: Json) => row.versionId === v1)
    // The operator template holds the pay grain for the worker's own records.
    expect(own.rates.find((rate: Json) => rate.operation.code === 'SEED-SEW-ASM').ratePerPiece).toBe('11.58')
    const read = await tablet.post(`/people/piece-rates/floor/publications/${own.publicationId}/read`, { clientEventId: `evt-${run}-read` }, { headers: { 'idempotency-key': key() } })
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect((read.body as Json)).toMatchObject({ changed: true, read: { channel: 'DEVICE' } })
    const again = await tablet.post(`/people/piece-rates/floor/publications/${own.publicationId}/read`, {}, { headers: { 'idempotency-key': key() } })
    expect((again.body as Json).changed).toBe(false)
    expect((await ok('hr', 'GET', `/people/piece-rates/versions/${v1}`)).version.readBy).toEqual({ read: 2, of: 2 })
    const receipt = (await admin('SELECT channel::text AS channel, "deviceId", "employeeId", "clientEventId" FROM "RateAcknowledgement" WHERE "publicationId" = $1 AND "workerId" = $2', [own.publicationId, operator]))[0]!
    expect(receipt).toMatchObject({ channel: 'DEVICE', clientEventId: `evt-${run}-read` })
    expect(receipt.employeeId).not.toBeNull()
    // The PIN again after the step-up window: a signing act.
    h.clock.advance(3 * 60_000)
    const v2Publication = (mine.body as Json).publications.find((row: Json) => row.versionId === v2)
    const late = await tablet.post(`/people/piece-rates/floor/publications/${v2Publication.publicationId}/read`, {}, { headers: { 'idempotency-key': key() } })
    expect(late.status).toBe(403)
  }, 120_000)
})

describe('the legal switch: "Start piece pay" only when every precondition is on record (GATE-PIECE-PAY)', () => {
  it('ships OFF: every missing precondition in words with its law, nothing asked', async () => {
    const view = await ok('hr', 'GET', `/people/piece-rates/sites/${siteA1}/switch`)
    expect(view).toMatchObject({ state: 'OFF', version: null, canStart: false })
    const missing = view.preconditions.filter((item: Json) => !item.met).map((item: Json) => item.code)
    expect(missing).toEqual(['PERFORMANCE_GATE', 'WORKER_NOTICE', 'DPIA', 'CCNL', 'CONSULTANT', 'SCHEME', 'EARNING_CODES'])
    expect(view.preconditions.find((item: Json) => item.code === 'SITE_BASIS').met).toBe(true)
    expect(view.preconditions.find((item: Json) => item.code === 'CCNL').law).toBe('c.c. art. 2100')
    expect(view.candidates.notices.length).toBeGreaterThan(0)
    expect(view.candidates.dpias.length).toBeGreaterThan(0)
    const b1 = await ok('hr', 'GET', `/people/piece-rates/sites/${siteB1}/switch`)
    expect(b1.preconditions.find((item: Json) => item.code === 'SITE_BASIS').met).toBe(false)
  })

  it('records what piece pay rests on, then refuses to start in words while the gate and the codes are missing (no code asked)', async () => {
    const view = await ok('hr', 'GET', `/people/piece-rates/sites/${siteA1}/switch`)
    const schemeId = newId()
    await admin(`INSERT INTO "IncentiveScheme" (id, "tenantId", "companyId", name, kind, "guaranteedBasis", "guaranteedHourlyRate", "validFrom", "updatedAt") VALUES ($1, $2, $3, 'Piece rate (made up)', 'PIECE_RATE', 'CCNL_MINIMUM', 9, $4, now())`, [schemeId, T, companyA, day(-1)])
    await admin(`UPDATE "IncentiveScheme" SET status = 'ACTIVE', "activatedAt" = now(), "activatedById" = $2 WHERE id = $1`, [schemeId, newId()])
    const recorded = await ok('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, {
      ccnlName: 'A made-up CCNL',
      ccnlArticle: 'art. 0 (made up)',
      workerNoticeId: view.candidates.notices[0].id,
      dpiaId: view.candidates.dpias[0].id,
      consultantName: 'A made-up labour consultant',
      consultantAgreedOn: today,
      schemeId,
    })
    expect(recorded.state).toBe('OFF')
    expect(recorded.preconditions.filter((item: Json) => !item.met).map((item: Json) => item.code)).toEqual(['PERFORMANCE_GATE', 'EARNING_CODES'])
    expect((await outbox('piece_pay.switched')).map((row) => row.payload.change)).toEqual(['PRECONDITIONS_RECORDED'])
    const refused = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/start`, { version: recorded.version, onFrom: day(1), reason: 'Agreed with the RSU (made up).' }, { headers: { 'idempotency-key': key() } })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(((refused.body as Json).error.issues as Json[]).map((issue) => issue.path)).toEqual(['preconditions/PERFORMANCE_GATE', 'preconditions/EARNING_CODES'])
    expect((await switchRow())!.state).toBe('OFF')
  })

  it('starts from a day to come with a fresh code once everything is on record; its preconditions then stay as they are', async () => {
    await admin(`INSERT INTO "PayrollCodeMapping" (id, "tenantId", "companyId", kind, "ourCode", meaning, "providerCode", "updatedAt") VALUES ($1, $2, $3, 'EARNING', 'PIECE', 'Piece pay', 'P01', now())`, [newId(), T, companyA])
    await stepUp(h, keeper.browser, keeper.secret)
    const gate = await keeper.browser.post(`/people/privacy/sites/${siteA1}/purposes/PERFORMANCE/switch-on`, { reason: 'Piece pay rests on the RSU agreement (made up).' })
    expect(gate.status, JSON.stringify(gate.body)).toBe(200)
    h.clock.advance(6 * 60_000)
    const version = (await switchRow())!.version
    const noCode = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/start`, { version, onFrom: day(1), reason: 'Agreed with the RSU (made up).' }, { headers: { 'idempotency-key': key() } })
    expect(noCode.status).toBe(403)
    await no('hr', 'POST', `/people/piece-rates/sites/${siteA1}/switch/start`, { version, onFrom: day(1), reason: 'Not mine.' }, 403)
    await stepUp(h, keeper.browser, keeper.secret)
    const past = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/start`, { version, onFrom: day(-1), reason: 'Agreed with the RSU (made up).' }, { headers: { 'idempotency-key': key() } })
    expect(past.status).toBe(400)
    const started = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/start`, { version, onFrom: day(1), reason: 'Agreed with the RSU (made up).' }, { headers: { 'idempotency-key': key() } })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    expect(started.body as Json).toMatchObject({ state: 'ON', onFrom: day(1), canStart: false })
    expect(await switchRow()).toMatchObject({ state: 'ON', onFrom: day(1), offFrom: null })
    expect((await outbox('piece_pay.switched')).at(-1)!.payload).toEqual({ siteId: siteA1, change: 'SWITCHED_ON', state: 'ON', onFrom: day(1), offFrom: null, by: 'OFFICE' })
    expect((await auditOf('people.startPiecePay'))[0]!.reason).toBe('Agreed with the RSU (made up).')
    const frozen = await no('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, { version: (await switchRow())!.version, ccnlArticle: 'art. 1' }, 409)
    expect(frozen.message).toMatch(/stays as it is while it runs/)
    expect((await ok('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, { version: (await switchRow())!.version, preconditionsNote: 'Copy of the agreement in the HR binder.' })).recorded.preconditionsNote).toBe('Copy of the agreement in the HR binder.')
  })

  it('stops piece pay in the same command when the site\'s PERFORMANCE gate is switched off (Statuto art. 4 c.1)', async () => {
    const gateVersion = (await admin<{ version: number }>(`SELECT version FROM "PeopleLegalGate" WHERE "siteId" = $1 AND purpose = 'PERFORMANCE' AND "switchedOffAt" IS NULL`, [siteA1]))[0]!.version
    const off = await keeper.browser.post(`/people/privacy/sites/${siteA1}/purposes/PERFORMANCE/switch-off`, { version: gateVersion, reason: 'The agreement was withdrawn (made up).' })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect((off.body as Json).words.join(' ')).toMatch(/Piece pay at this site stopped too, from/)
    const row = (await switchRow())!
    expect(row).toMatchObject({ state: 'OFF', onFrom: day(1), offFrom: day(1) })
    expect(row.offReason).toMatch(/switched off: The agreement was withdrawn/)
    expect((await outbox('piece_pay.switched')).at(-1)!.payload).toMatchObject({ change: 'SWITCHED_OFF', state: 'OFF', by: 'GATE_OFF' })
    const view = await ok('hr', 'GET', `/people/piece-rates/sites/${siteA1}/switch`)
    expect(view.preconditions.filter((item: Json) => !item.met).map((item: Json) => item.code)).toEqual(['PERFORMANCE_GATE'])
  })

  it('starts again (the window just closed kept) and stops by a person without a code: from its first day while it is to come', async () => {
    await stepUp(h, keeper.browser, keeper.secret)
    expect((await keeper.browser.post(`/people/privacy/sites/${siteA1}/purposes/PERFORMANCE/switch-on`, { reason: 'A new agreement (made up).' })).status).toBe(200)
    h.clock.advance(6 * 60_000)
    await stepUp(h, keeper.browser, keeper.secret)
    const restarted = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/start`, { version: (await switchRow())!.version, onFrom: day(2), reason: 'The new agreement covers it.' }, { headers: { 'idempotency-key': key() } })
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200)
    expect((await switchRow())!.earlierWindows).toEqual([{ from: day(1), to: day(1) }])
    h.clock.advance(6 * 60_000)
    await no('hr', 'POST', `/people/piece-rates/sites/${siteA1}/switch/stop`, { version: (await switchRow())!.version, reason: 'Not mine.' }, 403)
    const stopped = await keeper.browser.post(`/people/piece-rates/sites/${siteA1}/switch/stop`, { version: (await switchRow())!.version, reason: 'The labour consultant asked to wait.' }, { headers: { 'idempotency-key': key() } })
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200)
    expect(await switchRow()).toMatchObject({ state: 'OFF', onFrom: day(2), offFrom: day(2), offReason: 'The labour consultant asked to wait.' })
    expect((await outbox('piece_pay.switched')).at(-1)!.payload).toMatchObject({ change: 'SWITCHED_OFF', by: 'OFFICE' })
  })

  it('shows the tiles per site: trials ending soon, rates not read by all, drafts; the switch and what it still needs', async () => {
    const overview = await ok('hr', 'GET', `/people/piece-rates?siteId=${siteA1}`)
    expect(overview.sites).toHaveLength(1)
    expect(overview.sites[0].switch).toMatchObject({ state: 'OFF', missing: 0 })
    expect(overview.sites[0].tiles.unread).toBeGreaterThanOrEqual(1)
    expect((await ok('viewer', 'GET', '/people/piece-rates')).payShown).toBe(false)
    await no('plain', 'GET', '/people/piece-rates', undefined, 403)
  })
})
