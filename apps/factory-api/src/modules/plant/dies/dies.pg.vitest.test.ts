import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCutting, type CuttingSeed } from '../../../../../../packages/factory-db/seed/cutting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlantCare, type PlantCareSeed } from '../../../../../../packages/factory-db/seed/plantcare'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * The clicking-die register (B-W2b-136; QHS-173) on the local stack with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime logins, row-level security, the column grants and the
 * …_plant_care_w2b_guards ClickingDie trigger are real), the factory-db seeds up to the plant care seed (dies
 * SEED-D-0001 front left 50, SEED-D-0002 front left 52 WORN, SEED-D-0003 sleeve every size, SEED-D-0004 RETIRED; style
 * SEED-JKT-01 sizes 50, 52, 54). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/plant/dies`.
 */

let h: Harness
let app: FastifyInstance
let care: PlantCareSeed
let cutting: CuttingSeed

const ns = 'plant-dies'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), actor: idOf('actor'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1'), style: idOf('product:style:JKT-01'), supplier: idOf('party:P2'), customer: idOf('party:P1') }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], grants?: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: A.actor, grants: grants ?? [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(['plant.view', 'plant.machines.manage', 'parties.view']),
  owner: office(['plant.view', 'plant.machines.manage', 'parties.view', 'money.cost']),
  viewer: office(['plant.view']),
  // Company B's site B1 only: the dies of site A1 are out of reach.
  otherSite: office([], [{ permissions: ['plant.view', 'plant.machines.manage'], companies: [idOf('company:B')], sites: [idOf('site:B1')], parties: 'all' }]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `d-${run}-${++keys}`
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
const outbox = (subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'clicking_die.changed' AND subject = $2 ORDER BY "occurredAt", id`, [A.tenant, subject])

beforeAll(async () => {
  h = await startHarness('plant_dies')
  await seedCore({ db: h.database, namespace: ns })
  await seedPrivacy({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await seedPlant({ db: h.database, namespace: ns })
  care = await seedPlantCare({ db: h.database, namespace: ns })
  cutting = await seedCutting({ db: h.database, namespace: ns })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the register: dies per style, size and piece', () => {
  it('lists the dies in use by number, retired ones only when asked, the cost only with the cost grain', async () => {
    const list = await ok('keeper', 'GET', '/plant/dies')
    expect(list.dies.map((die: Json) => die.code)).toEqual(['SEED-D-0001', 'SEED-D-0002', 'SEED-D-0003'])
    expect(list.dies[0]).toMatchObject({ siteCode: 'A1', style: { code: 'SEED-JKT-01' }, size: '50', piece: 'Front left', patternPiece: { name: 'Front left', revision: 1 }, rackLocation: 'Rack R1, shelf 1', supplier: { code: 'SEED-S1' }, condition: 'GOOD' })
    expect(list.dies[2]).toMatchObject({ size: null, piece: 'Sleeve' })
    expect('purchaseCost' in list.dies[0]).toBe(false)
    expect(list.canManage).toBe(true)
    expect((await ok('owner', 'GET', '/plant/dies')).dies[0].purchaseCost).toBe(18000)
    expect((await ok('viewer', 'GET', '/plant/dies')).canManage).toBe(false)
    expect((await ok('viewer', 'GET', '/plant/dies?condition=RETIRED')).dies.map((die: Json) => die.code)).toEqual(['SEED-D-0004'])
    expect((await ok('viewer', 'GET', '/plant/dies?condition=WORN,DAMAGED')).dies.map((die: Json) => die.code)).toEqual(['SEED-D-0002'])
    expect((await ok('viewer', 'GET', '/plant/dies?q=sleeve')).dies.map((die: Json) => die.code)).toEqual(['SEED-D-0003'])
    expect((await ok('viewer', 'GET', '/plant/dies?q=r1,')).dies.map((die: Json) => die.code)).toEqual(['SEED-D-0001', 'SEED-D-0002'])
  })

  it('pages by number', async () => {
    const first = await ok('viewer', 'GET', '/plant/dies?limit=2')
    expect(first.dies).toHaveLength(2)
    const second = await ok('viewer', 'GET', `/plant/dies?limit=2&cursor=${first.nextCursor}`)
    expect(second.dies.map((die: Json) => die.code)).toEqual(['SEED-D-0003'])
    expect(second.nextCursor).toBeNull()
  })

  it('a grant of another site sees none of site A1\'s dies', async () => {
    expect((await ok('otherSite', 'GET', '/plant/dies')).dies).toEqual([])
  })
})

describe('the New die dialog\'s choices', () => {
  it('finds the style by code or name, with its sizes', async () => {
    const found = await ok('viewer', 'GET', '/plant/dies/styles?q=jkt')
    expect(found.styles[0]).toEqual({ id: A.style, code: 'SEED-JKT-01', name: 'Seed leather jacket', sizes: ['50', '52', '54'] })
    expect(found.styles.map((style: Json) => style.code)).toEqual([...found.styles.map((style: Json) => style.code)].sort())
    expect((await ok('viewer', 'GET', '/plant/dies/styles?q=leather%20jacket')).styles.map((style: Json) => style.code)).toEqual(['SEED-JKT-01'])
  })

  it('gives one style\'s sizes and the pieces of its newest revision in use', async () => {
    const choices = await ok('viewer', 'GET', `/plant/dies/choices?styleId=${A.style}`)
    expect(choices.sizes).toEqual(['50', '52', '54'])
    expect(choices.pieces.map((piece: Json) => piece.name)).toEqual(expect.arrayContaining(['Front left', 'Sleeve']))
    expect(choices.pieces.find((piece: Json) => piece.name === 'Sleeve')).toMatchObject({ id: cutting.patternPieceIds.sleeve, revision: 1, sizes: ['52', '54'] })
  })
})

let made: Json

describe('register, change and retire a die', () => {
  it('registers a die GOOD, number stamped upper case, with the cost from the cost grain; the same key answers again', async () => {
    const body = { siteId: A.siteA1, code: ' live-d 9001 ', styleId: A.style, size: '54', piece: 'Front left', patternPieceId: cutting.patternPieceIds.front, rackLocation: 'Rack R4', material: 'Steel rule', supplierId: A.supplier, purchaseCost: 19900 }
    const key = freshKey()
    const answer = await ok('owner', 'POST', '/plant/dies', body, 201, key)
    made = answer.die
    expect(made).toMatchObject({ code: 'LIVE-D9001', size: '54', condition: 'GOOD', purchaseCost: 19900, version: 1, patternPiece: { name: 'Front left' } })
    expect(answer.replayed).toBe(false)
    expect((await ok('owner', 'POST', '/plant/dies', body, 200, key)).replayed).toBe(true)
    expect((await outbox(made.id)).map((row) => row.payload)).toEqual([{ dieId: made.id, code: 'LIVE-D9001', styleId: A.style, change: 'REGISTERED', fields: [] }])
    const [audit] = await admin(`SELECT action, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2`, [A.tenant, made.id])
    expect(audit).toMatchObject({ action: 'plant.registerDie', after: { purchaseCost: { $money: 'cost', value: 19900 } } })
  })

  it('refuses a taken number, a size outside the style, another style\'s piece, a cost without the grain, a customer as supplier', async () => {
    const base = { siteId: A.siteA1, styleId: A.style, piece: 'Back' }
    expect(refusalOf(await no('keeper', 'POST', '/plant/dies', { ...base, code: 'seed-d-0001' }, 409))).toBe('refusal/DIE_NUMBER_TAKEN')
    expect(refusalOf(await no('keeper', 'POST', '/plant/dies', { ...base, code: 'LIVE-D9002', size: '60' }, 409))).toBe('refusal/SIZE_NOT_IN_STYLE')
    expect(refusalOf(await no('keeper', 'POST', '/plant/dies', { ...base, code: 'LIVE-D9002', styleId: A.supplier }, 409))).toBe('refusal/STYLE_UNKNOWN')
    expect((await call('keeper', 'POST', '/plant/dies', { ...base, code: 'LIVE-D9002', purchaseCost: 100 })).statusCode).toBe(403)
    expect((await no('keeper', 'POST', '/plant/dies', { ...base, code: 'LIVE-D9002', supplierId: A.customer }, 400)).issues[0].path).toBe('body/supplierId')
    expect((await no('keeper', 'POST', '/plant/dies', { ...base, code: 'D#2' }, 400)).issues[0].path).toBe('body/code')
  })

  it('moves the die to another rack and marks it worn inline, each with the version read', async () => {
    const moved = await ok('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 1, rackLocation: 'Rack R5, shelf 3' })
    expect(moved.die).toMatchObject({ rackLocation: 'Rack R5, shelf 3', version: 2 })
    const worn = await ok('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 2, condition: 'WORN' })
    expect(worn.die).toMatchObject({ condition: 'WORN', version: 3 })
    expect((await outbox(made.id)).map((row) => row.payload.fields)).toEqual([[], ['rackLocation'], ['condition']])
    // Nothing changed: no new version, no event.
    expect((await ok('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 3, condition: 'WORN' })).die.version).toBe(3)
  })

  it('refuses an old version, RETIRED by hand, and a pattern piece of no style of the die', async () => {
    expect((await call('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 1, rackLocation: 'Rack R6' })).statusCode).toBe(409)
    expect(refusalOf(await no('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 3, condition: 'RETIRED' }, 409))).toBe('refusal/CONDITION_RETIRED_BY_RETIRE')
    expect(refusalOf(await no('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 3, patternPieceId: A.style }, 409))).toBe('refusal/PIECE_OTHER_STYLE')
  })

  it('the viewer reads but never writes (403); another site\'s grant does not find the die (404)', async () => {
    expect((await call('viewer', 'PATCH', `/plant/dies/${made.id}`, { version: 3, rackLocation: 'Rack R7' })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/plant/dies', { siteId: A.siteA1, code: 'LIVE-D9003', styleId: A.style, piece: 'Back' })).statusCode).toBe(403)
    expect((await call('otherSite', 'PATCH', `/plant/dies/${made.id}`, { version: 3, rackLocation: 'Rack R7' })).statusCode).toBe(404)
    expect((await call('otherSite', 'POST', `/plant/dies/${made.id}/retire`, { version: 3, reason: 'Cracked' })).statusCode).toBe(404)
  })

  it('retires the die with its reason on the note and in the audit row; then only the note changes', async () => {
    const retired = await ok('keeper', 'POST', `/plant/dies/${made.id}/retire`, { version: 3, reason: 'Cracked at the collar' })
    expect(retired.die.condition).toBe('RETIRED')
    expect(retired.die.note).toMatch(/^Retired \d{4}-\d{2}-\d{2}: Cracked at the collar$/)
    const [audit] = await admin(`SELECT reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action = 'plant.retireDie'`, [A.tenant, made.id])
    expect(audit?.reason).toBe('Cracked at the collar')
    expect(refusalOf(await no('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 4, rackLocation: 'Rack R9' }, 409))).toBe('refusal/DIE_RETIRED')
    expect(refusalOf(await no('keeper', 'POST', `/plant/dies/${made.id}/retire`, { version: 4, reason: 'Again' }, 409))).toBe('refusal/DIE_RETIRED')
    expect((await ok('keeper', 'PATCH', `/plant/dies/${made.id}`, { version: 4, note: 'Kept for the record.' })).die).toMatchObject({ note: 'Kept for the record.', condition: 'RETIRED' })
    expect((await outbox(made.id)).map((row) => row.payload.change)).toEqual(['REGISTERED', 'CHANGED', 'CHANGED', 'RETIRED', 'CHANGED'])
    expect(care.dieIds.retired).toBeTruthy()
  })
})
