import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runSmvTakeEffect } from './take-effect'

/**
 * Standard minutes and their governance (B-W2b-215; PRD-111, PRD-113, PRD-114, PRD-126) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_routings_instructions_w2b_guards triggers are real), on the seeds up to people: the product seed's library (cut 14, sew
 * 96.5 …), its DRAFT jacket SEED-JKT-01 revision 1 (sizes 50, 52, 54) and production's RELEASED SEED-JKT-02 revision 1.
 * Every person, number and reason is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/minutes`.
 */

vi.setConfig({ testTimeout: 60_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'w2b215-minutes'
const idOf = (key: string): string => seedUuid(NS, key)
const lastId = (key: string): string => `ffffffff${idOf(key).slice(8)}`
const T = idOf('tenant')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const SEW = idOf('product:operation:SEW')
const CUT = idOf('product:operation:CUT')
const jacket = idOf('product:style:JKT-01')
const draft = idOf('product:revision:JKT-01:1')
const sewStep = idOf('product:routing:JKT-01:1:SEED-SEW-ASM')
const cutStep = idOf('product:routing:JKT-01:1:SEED-CUT-LEA')
const releasedStyle = idOf('production:style:JKT-02')
const releasedRevision = lastId('production:revision:JKT-02:1')

const VIEW = 'product.routing.view'
const MANAGE = 'product.routing.manage'
const LIBRARY = 'product.operations.manage'
const PROPOSE = 'product.smv.propose'
const APPROVE = 'product.smv.approve'
const grant = (permissions: string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const ACTORS = { anna: newId(), bruno: newId(), carla: newId() }
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  // The methods engineer proposes; the production manager decides; both may do both, never on their own proposal.
  anna: office(ACTORS.anna, [grant([VIEW, MANAGE, LIBRARY, PROPOSE, APPROVE, 'audit.read'])]),
  bruno: office(ACTORS.bruno, [grant([VIEW, APPROVE, PROPOSE, 'people.piecerates.view'])]),
  carla: office(ACTORS.carla, [grant([VIEW, PROPOSE])]),
  viewer: office(newId(), [grant([VIEW])]),
  companyB: office(newId(), [grant([VIEW, PROPOSE, APPROVE], [companyB])]),
  hr: office(newId(), [grant(['people.piecerates.view', 'people.piecerates.manage', 'money.pay'])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant([VIEW, PROPOSE, APPROVE])] },
  floor: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [{ permissions: [VIEW, PROPOSE, 'floor.work'] as Permission[], companies: 'all', sites: [siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `m-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const outbox = (type: string) => admin<{ subject: string; payload: Json }>('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const operationRow = async (id: string) =>
  (await admin('SELECT "standardMinutes"::text AS smv, "basicMinutes"::text AS basic, "personalPct"::text AS p, "fatiguePct"::text AS f, "delayPct"::text AS d, version FROM "Operation" WHERE id = $1', [id]))[0]!
const versionRows = async (id: string) =>
  admin('SELECT number, status::text AS status, "standardMinutes"::text AS smv, "decidedById" AS "decidedBy", "decisionNote" AS note FROM "OperationTimeVersion" WHERE "operationId" = $1 ORDER BY number', [id])
const minutesUrl = (operationId: string) => `/product/operations/${operationId}/minutes`
const stepUrl = (stepId: string, styleId = jacket, revisionId = draft) => `/product/styles/${styleId}/revisions/${revisionId}/routing/steps/${stepId}/minutes`
const timesUrl = (styleId = jacket, revisionId = draft) => `/product/styles/${styleId}/revisions/${revisionId}/routing/times`
const revisionVersion = async () => (await admin<{ version: number }>('SELECT version FROM "StyleRevision" WHERE id = $1', [draft]))[0]!.version

const today = businessDate(new Date())
const day = (offset: number) => plusDays(today, offset)
const silent = { info() {}, warn() {}, error() {} }

const sewProposal = { basicMinutes: '85', personalPct: '5', fatiguePct: '4', delayPct: '3', source: 'TIME_STUDY', effectiveFrom: today, reason: 'Time study of line L1, twenty jackets.' }
let v1 = ''
let v2 = ''

beforeAll(async () => {
  db = await migratedDatabase('product_minutes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduction({ db: database, namespace: NS })
  await seedPeople({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('an operation that is not governed (W1 typed SMV)', () => {
  it("shows its typed SMV, no version, the routings it feeds; W1's typed change still works", async () => {
    const { minutes } = await ok('viewer', 'GET', minutesUrl(SEW))
    expect(minutes).toMatchObject({
      operation: { id: SEW, code: 'SEED-SEW-ASM', companyId: null, status: 'ACTIVE' },
      current: { standardMinutes: '96.5', basicMinutes: null, personalPct: null },
      governed: false,
      today,
      inForce: { standardMinutes: '96.5', versionId: null, number: null },
      pendingId: null,
      versions: [],
      impact: { pieceRates: { count: 0 } },
      may: { propose: false, decide: false },
    })
    expect(minutes.impact.routings).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: sewStep, seq: 20, standardMinutes: '96.5', runFrom: 'TYPED', timeVersionNumber: null, revision: expect.objectContaining({ id: draft, status: 'DRAFT' }) })]))
    await no('otherTenant', 'GET', minutesUrl(SEW), undefined, 404)
    await no('floor', 'GET', minutesUrl(SEW), undefined, 403)
  })
})

describe('Propose SMV change and its approval by a second person (PRD-111, PRD-113)', () => {
  it('a proposal gives its SMV from basic minutes and allowances and waits; one per operation; the rules are said in words', async () => {
    await no('viewer', 'POST', `${minutesUrl(SEW)}/proposals`, sewProposal, 403)
    expect((await no('companyB', 'POST', `${minutesUrl(SEW)}/proposals`, sewProposal, 403)).message).toMatch(/only by a role over every company/)
    const past = await no('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, effectiveFrom: day(-1) }, 400)
    expect(past.issues).toEqual([{ path: 'body/effectiveFrom', message: `A new SMV applies from today (${today}) or a later day.` }])
    const allowance = await no('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, personalPct: '100' }, 400)
    expect(allowance.issues).toEqual([{ path: 'body/personalPct', message: 'An allowance is below 100 percent.' }])

    const made = await ok('anna', 'POST', `${minutesUrl(SEW)}/proposals`, sewProposal, 201)
    v1 = made.versionId
    expect(made.minutes.pendingId).toBe(v1)
    expect(made.minutes.versions).toEqual([
      expect.objectContaining({ id: v1, number: 1, status: 'PROPOSED', basicMinutes: '85', personalPct: '5', fatiguePct: '4', delayPct: '3', standardMinutes: '95.2', source: 'TIME_STUDY', effectiveFrom: today, proposedBy: { id: ACTORS.anna, name: ACTORS.anna }, decidedBy: null, inForce: false, waiting: false }),
    ])
    expect(made.minutes.current.standardMinutes).toBe('96.5')
    const second = await no('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, basicMinutes: '84' }, 409)
    expect(second.message).toMatch(/^SMV version 1 of operation SEED-SEW-ASM waits for approval/)
    expect((await outbox('smv_version.changed')).map((row) => row.payload)).toEqual([
      { operationId: SEW, code: 'SEED-SEW-ASM', versionId: v1, number: 1, status: 'PROPOSED', change: 'PROPOSED', standardMinutes: '95.2', effectiveFrom: today },
    ])
  })

  it("W1's typed SMV is refused in words while a proposal waits (not the database's 500)", async () => {
    const { operation } = await ok('anna', 'GET', `/product/operations/${SEW}`)
    const refused = await no('anna', 'PATCH', `/product/operations/${SEW}`, { version: operation.version, standardMinutes: '90' }, 409)
    expect(refused).toMatchObject({ code: 'invalid_state', message: 'SMV version 1 of operation SEED-SEW-ASM waits for approval: approve or reject it before the SMV is typed again.' })
  })

  it('is decided by someone who did not propose it, at the version read; approved from today it takes effect at once', async () => {
    const own = await no('anna', 'POST', `${minutesUrl(SEW)}/versions/${v1}/approve`, { version: 1 }, 403)
    expect(own.message).toBe('You proposed SMV version 1: another person approves it (four eyes).')
    await no('carla', 'POST', `${minutesUrl(SEW)}/versions/${v1}/approve`, { version: 1 }, 403)
    await no('bruno', 'POST', `${minutesUrl(CUT)}/versions/${v1}/approve`, { version: 1 }, 404)
    expect((await no('bruno', 'POST', `${minutesUrl(SEW)}/versions/${v1}/approve`, { version: 7 }, 409)).message).toMatch(/changed since it was read \(version 7\); it is now at version 1/)

    const decided = await ok('bruno', 'POST', `${minutesUrl(SEW)}/versions/${v1}/approve`, { version: 1, note: 'Matches the study.' })
    expect(decided.tookEffect).toBe(true)
    expect(decided.minutes).toMatchObject({
      current: { standardMinutes: '95.2', basicMinutes: '85', personalPct: '5', fatiguePct: '4', delayPct: '3' },
      governed: true,
      inForce: { standardMinutes: '95.2', versionId: v1, number: 1, effectiveFrom: today },
      pendingId: null,
    })
    expect(decided.minutes.versions[0]).toMatchObject({ status: 'APPROVED', decidedBy: { id: ACTORS.bruno }, decisionNote: 'Matches the study.', inForce: true, version: 2 })
    expect(await operationRow(SEW)).toMatchObject({ smv: '95.200', basic: '85.000', p: '5.0000', f: '4.0000', d: '3.0000' })
    expect((await outbox('operation.smv_changed')).map((row) => row.payload)).toEqual([{ operationId: SEW, code: 'SEED-SEW-ASM', versionId: v1, number: 1, from: '96.5', standardMinutes: '95.2', by: 'APPROVAL' }])
    await no('bruno', 'POST', `${minutesUrl(SEW)}/versions/${v1}/approve`, { version: 2 }, 409)
    const history = await ok('anna', 'GET', `/audit/OperationTimeVersion/${v1}`)
    expect(history.entries.map((entry: Json) => entry.action)).toEqual(expect.arrayContaining(['product.smv.propose', 'product.smv.approve']))
  })

  it('a governed operation: W1 refuses a typed SMV in words, other fields still change; the database holds it too', async () => {
    const { operation } = await ok('anna', 'GET', `/product/operations/${SEW}`)
    const refused = await no('anna', 'PATCH', `/product/operations/${SEW}`, { version: operation.version, standardMinutes: '90' }, 409)
    expect(refused.message).toMatch(/^Operation SEED-SEW-ASM has an approved SMV: it changes only by a new version/)
    await ok('anna', 'PATCH', `/product/operations/${SEW}`, { version: operation.version, skill: 'machinist' })
    await expect(admin('UPDATE "Operation" SET "standardMinutes" = 90 WHERE id = $1', [SEW])).rejects.toThrow(/standard minutes|approved SMV/)
  })

  it('a later version waits for its day; a proposal before it is refused; a proposal replaced or rejected (with why) never applies', async () => {
    const later = await ok('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, basicMinutes: '80', source: 'PREDETERMINED', effectiveFrom: day(10), reason: 'New folder attachment.' }, 201)
    v2 = later.versionId
    const approved = await ok('bruno', 'POST', `${minutesUrl(SEW)}/versions/${v2}/approve`, { version: 1 })
    expect(approved.tookEffect).toBe(false)
    expect(approved.minutes.current.standardMinutes).toBe('95.2')
    expect(approved.minutes.versions.map((version: Json) => [version.number, version.status, version.standardMinutes, version.inForce, version.waiting])).toEqual([
      [2, 'APPROVED', '89.6', false, true],
      [1, 'APPROVED', '95.2', true, false],
    ])
    const early = await no('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, effectiveFrom: day(5) }, 400)
    expect(early.issues[0].message).toBe(`Version 2 is approved from ${day(10)}: a new version applies from that day or later.`)

    const third = await ok('carla', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, basicMinutes: '82', effectiveFrom: day(20) }, 201)
    const fourth = await ok('anna', 'POST', `${minutesUrl(SEW)}/proposals`, { ...sewProposal, basicMinutes: '81', effectiveFrom: day(20), replaces: third.versionId }, 201)
    expect(fourth.minutes.versions.slice(0, 2).map((version: Json) => [version.number, version.status, version.decidedBy])).toEqual([
      [4, 'PROPOSED', null],
      [3, 'SUPERSEDED', null],
    ])
    expect((await outbox('smv_version.changed')).filter((row) => row.payload.change === 'REPLACED').map((row) => row.payload.number)).toEqual([3])

    const waiting = await ok('bruno', 'GET', '/product/minutes/waiting')
    expect(waiting.count).toBe(1)
    expect(waiting.versions[0]).toMatchObject({ operation: { id: SEW, code: 'SEED-SEW-ASM', standardMinutes: '95.2' }, proposal: { id: fourth.versionId, number: 4 }, mayDecide: true })
    expect((await ok('anna', 'GET', '/product/minutes/waiting')).versions[0].mayDecide).toBe(false)
    expect((await ok('viewer', 'GET', '/product/minutes/waiting')).count).toBe(1)

    await no('anna', 'POST', `${minutesUrl(SEW)}/versions/${fourth.versionId}/reject`, { version: 1, note: 'Not mine to reject.' }, 403)
    expect((await no('bruno', 'POST', `${minutesUrl(SEW)}/versions/${fourth.versionId}/reject`, { version: 1 }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/note' })])
    const rejected = await ok('bruno', 'POST', `${minutesUrl(SEW)}/versions/${fourth.versionId}/reject`, { version: 1, note: 'The study covered only one size.' })
    expect(rejected.minutes.versions[0]).toMatchObject({ number: 4, status: 'REJECTED', decisionNote: 'The study covered only one size.', decidedBy: { id: ACTORS.bruno } })
    expect(rejected.minutes.pendingId).toBeNull()
    expect((await ok('bruno', 'GET', '/product/minutes/waiting')).count).toBe(0)
    expect((await versionRows(SEW)).map((row) => [row.number, row.status])).toEqual([
      [1, 'APPROVED'],
      [2, 'APPROVED'],
      [3, 'SUPERSEDED'],
      [4, 'REJECTED'],
    ])
  })
})

describe("a draft routing step's minutes (PRD-113, PRD-114, PRD-126)", () => {
  it('copies the approved version in force; W1 then refuses a typed SMV on that step in words; typed again here', async () => {
    const copied = await ok('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), run: { from: 'VERSION' } })
    const step = copied.times.steps.find((entry: Json) => entry.stepId === sewStep)
    expect(step).toMatchObject({
      run: { from: 'VERSION', standardMinutes: '95.2', basicMinutes: '85', personalPct: '5', timeVersion: { id: v1, number: 1, status: 'APPROVED', effectiveFrom: today } },
      library: { standardMinutes: '95.2', governed: true, inForceVersionId: v1, inForceNumber: 1, differs: false },
    })
    const routing = (await ok('anna', 'GET', `/product/styles/${jacket}/revisions/${draft}/routing`)).routing
    const refused = await no('anna', 'PATCH', `/product/styles/${jacket}/revisions/${draft}/routing/steps/${sewStep}`, { version: routing.revision.version, standardMinutes: '99' }, 409)
    expect(refused).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/^The SMV of routing step 20 is copied from SMV version 1 of its operation/) })
    await ok('anna', 'PATCH', `/product/styles/${jacket}/revisions/${draft}/routing/steps/${sewStep}`, { version: routing.revision.version, scanRequired: true })

    const typed = await ok('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), run: { from: 'TYPED', standardMinutes: '97' } })
    expect(typed.times.steps.find((entry: Json) => entry.stepId === sewStep)).toMatchObject({ run: { from: 'TYPED', standardMinutes: '97', basicMinutes: null, timeVersion: null }, library: { differs: true } })
    const again = (await ok('anna', 'GET', `/product/styles/${jacket}/revisions/${draft}/routing`)).routing
    await ok('anna', 'PATCH', `/product/styles/${jacket}/revisions/${draft}/routing/steps/${sewStep}`, { version: again.revision.version, standardMinutes: '96' })
  })

  it('takes its own allowances; a version that is not APPROVED, or none in force, is refused in words', async () => {
    const built = await ok('anna', 'PUT', stepUrl(cutStep), { version: await revisionVersion(), run: { from: 'ALLOWANCES', basicMinutes: '12.5', personalPct: '5', fatiguePct: '4', delayPct: '3' } })
    expect(built.times.steps.find((entry: Json) => entry.stepId === cutStep).run).toMatchObject({ from: 'ALLOWANCES', standardMinutes: '14', basicMinutes: '12.5', timeVersion: null })
    const rejectedVersion = (await versionRows(SEW)).find((row) => row.number === 4)
    expect(rejectedVersion).toBeTruthy()
    const v4 = (await admin<{ id: string }>('SELECT id FROM "OperationTimeVersion" WHERE "operationId" = $1 AND number = 4', [SEW]))[0]!.id
    expect((await no('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), run: { from: 'VERSION', timeVersionId: v4 } }, 409)).message).toBe('SMV version 4 of operation SEED-SEW-ASM is rejected: a step copies an APPROVED version.')
    expect((await no('anna', 'PUT', stepUrl(cutStep), { version: await revisionVersion(), run: { from: 'VERSION' } }, 409)).message).toMatch(/^Operation SEED-CUT-LEA has no approved SMV: propose one/)
    const waiting = await ok('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), run: { from: 'VERSION', timeVersionId: v2 } })
    expect(waiting.times.steps.find((entry: Json) => entry.stepId === sewStep).run).toMatchObject({ from: 'VERSION', standardMinutes: '89.6', timeVersion: { number: 2 } })
  })

  it('keeps set-up, wait and move per work order and extra minutes per size; a lead time for a quantity; the rules in words', async () => {
    const set = await ok('anna', 'PUT', stepUrl(sewStep), {
      version: await revisionVersion(),
      setupMinutes: '20',
      waitMinutes: '15',
      sizeTimes: [
        { size: '54', extraMinutes: '4' },
        { size: '50', extraMinutes: '-1.5' },
      ],
    })
    const sew = set.times.steps.find((entry: Json) => entry.stepId === sewStep)
    expect(sew).toMatchObject({
      setupMinutes: '20',
      waitMinutes: '15',
      moveMinutes: null,
      sizeTimes: [
        { size: '50', extraMinutes: '-1.5', minutes: '88.1' },
        { size: '54', extraMinutes: '4', minutes: '93.6' },
      ],
    })
    await ok('anna', 'PUT', stepUrl(cutStep), { version: await revisionVersion(), moveMinutes: '5' })
    const { times } = await ok('viewer', 'GET', `${timesUrl()}?quantity=10&size=54`)
    // cut 14 + sew 89.6 + finishing 8 + pack 3.5 = 115.1 per garment; size 54 adds 4.
    expect(times).toMatchObject({ perGarment: '115.1', setup: '20', wait: '15', move: '5', editable: true })
    expect(times.bySize).toEqual([
      { size: '50', minutes: '113.6' },
      { size: '52', minutes: '115.1' },
      { size: '54', minutes: '119.1' },
    ])
    expect(times.lead).toEqual({ quantity: 10, size: '54', setup: '20', run: '1191', wait: '15', move: '5', total: '1231' })

    const bad = await no('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), sizeTimes: [{ size: '60', extraMinutes: '1' }, { size: '52', extraMinutes: '-89.6' }] }, 400)
    expect(bad.issues.map((issue: Json) => issue.message)).toEqual(["Size 60 is not in the style's range (50, 52, 54).", 'Size 52 would take 0 minutes: a size takes more than 0 (the step takes 89.6).'])
    const below = await no('anna', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), run: { from: 'TYPED', standardMinutes: '1.5' } }, 400)
    expect(below.issues).toEqual([{ path: 'body/run', message: 'With 1.5 minutes, size 50 would take 0 or less: change its extra minutes in the same request (sizeTimes).' }])
    await no('anna', 'PUT', stepUrl(sewStep), { version: 1, setupMinutes: '1' }, 409)
    await no('anna', 'GET', `${timesUrl()}?size=60`, undefined, 400)
    await no('viewer', 'PUT', stepUrl(sewStep), { version: await revisionVersion(), setupMinutes: '1' }, 403)

    const releasedStep = (await admin<{ id: string }>('SELECT id FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [releasedRevision]))[0]!.id
    const released = (await admin<{ version: number }>('SELECT version FROM "StyleRevision" WHERE id = $1', [releasedRevision]))[0]!.version
    expect((await no('anna', 'PUT', stepUrl(releasedStep, releasedStyle, releasedRevision), { version: released, setupMinutes: '1' }, 409)).code).toBe('invalid_state')
    expect((await ok('viewer', 'GET', timesUrl(releasedStyle, releasedRevision))).times.editable).toBe(false)

    const events = await outbox('style.routing_changed')
    expect(events.filter((row) => row.payload.revisionId === draft).length).toBeGreaterThanOrEqual(6)
  })
})

describe('piece rates read the approved SMV of their first day (PRD-113; smv-source)', () => {
  it('fill an empty SMV with it, refuse another typed one, and a copy for a later day takes that day\'s SMV', async () => {
    const table = await ok('hr', 'POST', '/people/piece-rates/tables', { siteId: siteA1, code: 'SMV-T', name: 'SMV test' }, 201)
    const typedWrong = await no('hr', 'POST', `/people/piece-rates/tables/${table.table.id}/versions`, { changeReason: 'NEW', effectiveFrom: today, rates: [{ operationId: SEW, basis: 'SMV_RATE', standardMinutes: '96.5', ratePerMinute: '0.12' }] }, 400)
    expect(typedWrong.issues).toEqual([
      { path: 'rates/0/standardMinutes', message: `The operation's approved SMV on ${today} is 95.2 (version 1): leave the SMV empty to take it, or propose an SMV change in Products › Operations.` },
    ])
    const made = await ok('hr', 'POST', `/people/piece-rates/tables/${table.table.id}/versions`, { changeReason: 'NEW', effectiveFrom: today, rates: [{ operationId: SEW, basis: 'SMV_RATE', ratePerMinute: '0.12' }, { operationId: CUT, basis: 'SMV_RATE', ratePerMinute: '0.1' }] }, 201)
    const byOperation = new Map(made.rates.map((rate: Json) => [rate.operation.id, rate]))
    expect(byOperation.get(SEW)).toMatchObject({ standardMinutes: '95.2', ratePerPiece: '11.424' })
    expect(byOperation.get(CUT)).toMatchObject({ standardMinutes: '14' })

    const copy = await ok('hr', 'POST', `/people/piece-rates/tables/${table.table.id}/versions`, { changeReason: 'METHOD_CHANGED', effectiveFrom: day(10) }, 201)
    expect(new Map(copy.rates.map((rate: Json) => [rate.operation.id, rate])).get(SEW)).toMatchObject({ standardMinutes: '89.6', ratePerMinute: '0.12', ratePerPiece: '10.752' })

    const seen = await ok('bruno', 'GET', minutesUrl(SEW))
    expect(seen.minutes.impact.pieceRates.count).toBe(2)
    expect(seen.minutes.impact.pieceRates.rows.map((row: Json) => [row.table.code, row.versionNo, row.standardMinutes])).toEqual([
      ['SMV-T', 2, '89.6'],
      ['SMV-T', 1, '95.2'],
    ])
    const hidden = await ok('anna', 'GET', minutesUrl(SEW))
    expect(hidden.minutes.impact.pieceRates).toEqual({ count: 2, rows: null })
  })
})

describe('the hourly job: an approved version takes effect on its day', () => {
  it('settles on the day: the operation takes the numbers, the earlier version is superseded; a second run does nothing', async () => {
    const clock = fixedClock(`${day(10)}T09:00:00.000Z`)
    expect(await runSmvTakeEffect({ database, log: silent, clock })).toMatchObject({ settled: 1, failed: 0 })
    expect(await operationRow(SEW)).toMatchObject({ smv: '89.600', basic: '80.000' })
    expect((await versionRows(SEW)).map((row) => [row.number, row.status, row.decidedBy])).toEqual([
      [1, 'SUPERSEDED', ACTORS.bruno],
      [2, 'APPROVED', ACTORS.bruno],
      [3, 'SUPERSEDED', null],
      [4, 'REJECTED', ACTORS.bruno],
    ])
    expect((await outbox('operation.smv_changed')).map((row) => [row.payload.number, row.payload.from, row.payload.standardMinutes, row.payload.by])).toEqual([
      [1, '96.5', '95.2', 'APPROVAL'],
      [2, '95.2', '89.6', 'SCHEDULE'],
    ])
    expect(await runSmvTakeEffect({ database, log: silent, clock: fixedClock(`${day(10)}T10:00:00.000Z`) })).toMatchObject({ settled: 0, failed: 0 })
  })
})
