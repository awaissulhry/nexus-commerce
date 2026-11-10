import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { prepacksGuarded } from './store'

/**
 * Prepacks (B-W2b-233; PRD-055) on the local stack, through the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and B-W2b-210's guards are real), the core and sizes seeds
 * (SEED-JKT-01 on the EU jacket scale 48-56, made in 50, 52, 54, with SEED-PP-JKT-7 2-3-2, SEED-PP-JKT-COL 52 black ×2 red
 * ×1 and the archived SEED-PP-JKT-OLD; the scale's SEED-PP-EU-9 1-2-3-2-1), sessions from the test authenticator. Every
 * code is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/prepacks`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seed: SizesDepthSeed

const NS = 'w2b233-prepacks'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')

const PEOPLE: Record<string, { tenantId: string; permissions: readonly Permission[]; companies: ScopeSet }> = {
  // Sales keeps the packs dealers order (product.prepacks.manage) without changing the style.
  sales: { tenantId: tenant, permissions: ['product.styles.view', 'product.prepacks.manage', 'audit.read'], companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.styles.view'], companies: 'all' },
  // The production manager keeps styles but, without product.prepacks.manage in this made-up role, no prepack.
  stylesOnly: { tenantId: tenant, permissions: ['product.styles.view', 'product.styles.manage'], companies: 'all' },
  otherTenant: { tenantId: newId(), permissions: ['product.styles.view', 'product.prepacks.manage'], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: newId(), grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const events = async () => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'prepack.changed' ORDER BY "occurredAt", id`, [tenant])).map((row) => row.payload)
const sectionUrl = () => `/product/styles/${seed.jacket.styleId}/prepacks`
const section = async (session = 'viewer'): Promise<Json> => (await ok(session, 'GET', sectionUrl())).prepacks
const byCode = (view: Json, code: string): Json => view.prepacks.find((prepack: Json) => prepack.code === code)
const [BLK, RED] = [0, 1]

beforeAll(async () => {
  db = await migratedDatabase('w2b233_prepacks')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seed = await seedSizesDepth({ db: database, namespace: NS })
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

describe("a style's prepacks (PRD-055)", () => {
  it("reads the style's own packs and its scale's, with the ratio, the pieces and what the style cannot sell", async () => {
    const view = await section()
    expect(view.prepacks.map((prepack: Json) => [prepack.code, prepack.scope, prepack.status, prepack.ratio, prepack.pieces, prepack.byColourway, prepack.outsideRange, prepack.usable])).toEqual([
      ['SEED-PP-JKT-7', 'STYLE', 'ACTIVE', '2-3-2', 7, false, [], true],
      ['SEED-PP-JKT-COL', 'STYLE', 'ACTIVE', '3', 3, true, [], true],
      ['SEED-PP-JKT-OLD', 'STYLE', 'ARCHIVED', '1-1', 2, false, [], false],
      ['SEED-PP-EU-9', 'SCALE', 'ACTIVE', '1-2-3-2-1', 9, false, ['48', '56'], false],
    ])
    expect(byCode(view, 'SEED-PP-JKT-COL').lines.map((line: Json) => [line.size, line.colourway?.code, line.quantity])).toEqual([
      ['52', 'BLK', 2],
      ['52', 'RED', 1],
    ])
    expect(byCode(view, 'SEED-PP-EU-9').words).toBe('9 pieces per pack: 48 ×1, 50 ×2, 52 ×3, 54 ×2, 56 ×1 · not for this style: it is not made in 48, 56')
    expect(view).toMatchObject({ style: { code: 'SEED-JKT-01', sizes: ['50', '52', '54'] }, sizeScale: { code: 'SEED-EU-JKT', sizes: ['48', '50', '52', '54', '56'] }, styleRefusal: null })
    expect(view.colourways.map((colourway: Json) => colourway.code)).toEqual(['BLK', 'RED'])
    const one = (await ok('viewer', 'GET', `/product/prepacks/${seed.prepackIds.jacket}`)).prepack
    expect(one).toMatchObject({ code: 'SEED-PP-JKT-7', bySize: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }, { size: '54', quantity: 2 }] })
    await refused('otherTenant', 'GET', sectionUrl(), undefined, 404)
    await refused('otherTenant', 'GET', `/product/prepacks/${seed.prepackIds.jacket}`, undefined, 404)
  })

  it('sales adds a pack of the style, per size or per colourway; refuses in words what does not fit', async () => {
    const created = (await ok('sales', 'POST', sectionUrl(), { code: 'PP-DEALER-4', name: 'Dealer pack of 4', lines: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }, { size: '54', quantity: 1 }] }, 201)).prepack
    expect(created).toMatchObject({ scope: 'STYLE', styleId: seed.jacket.styleId, ratio: '1-2-1', pieces: 4, usable: true, version: 1 })
    expect((await events()).at(-1)).toEqual({ prepackId: created.id, code: 'PP-DEALER-4', sizeScaleId: seed.jacketScaleId, styleId: seed.jacket.styleId, change: 'CREATED' })
    const colours = (await ok('sales', 'POST', sectionUrl(), { code: 'PP-COL-2', name: 'Two of 54', lines: [{ size: '54', colourwayId: seed.jacket.colourwayIds[BLK], quantity: 1 }, { size: '54', colourwayId: seed.jacket.colourwayIds[RED], quantity: 1 }] }, 201)).prepack
    expect(colours.lines.map((line: Json) => line.colourway.code)).toEqual(['BLK', 'RED'])

    expect((await refused('sales', 'POST', sectionUrl(), { code: 'PP-DEALER-4', name: 'Again', lines: [{ size: '50', quantity: 1 }] }, 409)).message).toBe('The prepack code PP-DEALER-4 is taken in size scale SEED-EU-JKT: pick another.')
    const outside = await refused('sales', 'POST', sectionUrl(), { code: 'PP-X', name: 'X', lines: [{ size: '56', quantity: 1 }] }, 400)
    expect(outside.issues).toEqual([{ path: 'body/lines/0/size', message: 'Size 56 is not one of the sizes of style SEED-JKT-01 (50, 52, 54).' }])
    const both = await refused('sales', 'POST', sectionUrl(), { code: 'PP-X', name: 'X', lines: [{ size: '52', quantity: 1 }, { size: '52', colourwayId: seed.jacket.colourwayIds[RED], quantity: 1 }] }, 400)
    expect(both.issues[0]).toEqual({ path: 'body/lines/1/colourwayId', message: 'Size 52 is given both for any colourway and per colourway: give it one way.' })
    const scaleColour = await refused('sales', 'POST', sectionUrl(), { scope: 'SCALE', code: 'PP-X', name: 'X', lines: [{ size: '52', colourwayId: seed.jacket.colourwayIds[RED], quantity: 1 }] }, 400)
    expect(scaleColour.issues[0].path).toBe('body/lines/0/colourwayId')
    await refused('viewer', 'POST', sectionUrl(), { code: 'PP-X', name: 'X', lines: [{ size: '52', quantity: 1 }] }, 403)
    await refused('stylesOnly', 'POST', sectionUrl(), { code: 'PP-X', name: 'X', lines: [{ size: '52', quantity: 1 }] }, 403)
  })

  it('adds a pack of every style of the scale, with the scale’s sizes', async () => {
    const created = (await ok('sales', 'POST', sectionUrl(), { scope: 'SCALE', code: 'PP-EU-WIDE', name: 'Wide EU pack', lines: [{ size: '48', quantity: 1 }, { size: '56', quantity: 1 }] }, 201)).prepack
    expect(created).toMatchObject({ scope: 'SCALE', styleId: null, ratio: '1-0-0-0-1', outsideRange: [], usable: true })
    expect(byCode(await section(), 'PP-EU-WIDE')).toMatchObject({ outsideRange: ['48', '56'], usable: false })
  })

  it('changes the lines at the version: kept lines keep their row, others come and go', async () => {
    const before = byCode(await section(), 'PP-DEALER-4')
    const lineIds = async () => (await admin<{ id: string; size: string }>(`SELECT id, size FROM "PrepackLine" WHERE "prepackId" = $1 ORDER BY size`, [before.id])).map((row) => `${row.size}:${row.id}`)
    const kept = (await lineIds()).find((entry) => entry.startsWith('52:'))
    const changed = (await ok('sales', 'PATCH', `/product/prepacks/${before.id}`, { version: before.version, lines: [{ size: '52', quantity: 3 }, { size: '54', quantity: 2 }] })).prepack
    expect(changed).toMatchObject({ ratio: '3-2', pieces: 5, version: before.version + 1 })
    expect(await lineIds()).toContain(kept)
    expect((await events()).at(-1)).toMatchObject({ prepackId: before.id, change: 'LINES' })
    expect((await refused('sales', 'PATCH', `/product/prepacks/${before.id}`, { version: before.version, name: 'Stale' }, 409)).message).toMatch(/version/)
    const taken = await refused('sales', 'PATCH', `/product/prepacks/${before.id}`, { version: changed.version, code: 'SEED-PP-JKT-7' }, 409)
    expect(taken.message).toBe('The prepack code SEED-PP-JKT-7 is taken in size scale SEED-EU-JKT: pick another.')
    const renamed = (await ok('sales', 'PATCH', `/product/prepacks/${before.id}`, { version: changed.version, name: 'Dealer pack of 5' })).prepack
    expect(renamed).toMatchObject({ name: 'Dealer pack of 5', version: changed.version + 1 })
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'Prepack' AND "recordId" = $1 ORDER BY at`, [before.id])
    expect(audit.map((row) => row.action)).toEqual(['product.prepacks.create', 'product.prepacks.update', 'product.prepacks.update'])
  })

  it('archives the selection (its lines freeze) and restores it', async () => {
    const view = await section()
    const pick = ['PP-DEALER-4', 'PP-COL-2'].map((code) => byCode(view, code))
    const archived = (await ok('sales', 'POST', '/product/prepacks/status', { prepacks: pick.map((prepack) => ({ id: prepack.id, version: prepack.version })), status: 'ARCHIVED' })).prepacks
    expect(archived.map((prepack: Json) => [prepack.code, prepack.status, prepack.usable])).toEqual([
      ['PP-DEALER-4', 'ARCHIVED', false],
      ['PP-COL-2', 'ARCHIVED', false],
    ])
    const frozen = await refused('sales', 'PATCH', `/product/prepacks/${pick[0]!.id}`, { version: archived[0].version, lines: [{ size: '50', quantity: 1 }] }, 409)
    expect(frozen.message).toBe('Prepack PP-DEALER-4 is archived: restore it to change it.')
    await refused('sales', 'POST', '/product/prepacks/status', { prepacks: [{ id: pick[0]!.id, version: pick[0]!.version }], status: 'ACTIVE' }, 409)
    const restored = (await ok('sales', 'POST', '/product/prepacks/status', { prepacks: [{ id: pick[0]!.id, version: archived[0].version }], status: 'ACTIVE' })).prepacks
    expect(restored[0]).toMatchObject({ status: 'ACTIVE', usable: true })
    expect((await events()).slice(-3).map((event) => event.change)).toEqual(['ARCHIVED', 'ARCHIVED', 'RESTORED'])
  })

  it("the style's edit rule holds a style's pack, not the scale's (B-W2b-221)", async () => {
    await admin(`INSERT INTO "ProductSettings" (id, "tenantId", "editRuleConcept", "editRuleDevelopment") VALUES ($1, $1, 'BLOCKED', 'BLOCKED')`, [tenant])
    try {
      const view = await section()
      expect(view.styleRefusal).toMatch(/nothing of it changes in this state/)
      const refusal = await refused('sales', 'POST', sectionUrl(), { code: 'PP-HELD', name: 'Held', lines: [{ size: '52', quantity: 1 }] }, 409)
      expect(refusal.issues).toEqual([{ path: 'refusal/EDIT_BLOCKED', message: expect.stringMatching(/nothing of it changes in this state/) }])
      const wide = byCode(view, 'PP-EU-WIDE')
      expect((await ok('sales', 'PATCH', `/product/prepacks/${wide.id}`, { version: wide.version, name: 'Wide EU pack (renamed)' })).prepack.name).toBe('Wide EU pack (renamed)')
    } finally {
      await admin(`DELETE FROM "ProductSettings" WHERE id = $1`, [tenant])
    }
  })

  it('a database refusal reaches the caller as a 409 in words, never a 500', async () => {
    const refusal = Object.assign(new Error('raw'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: 'product: prepack 0190 is ARCHIVED: its lines never change' } } } })
    await expect(prepacksGuarded(() => Promise.reject(refusal))).rejects.toThrow(ConflictError)
    await expect(prepacksGuarded(() => Promise.reject(refusal))).rejects.toThrow('Prepack 0190 is ARCHIVED: its lines never change. Load the prepacks again.')
    await expect(prepacksGuarded(() => Promise.reject(Object.assign(new Error('dup'), { code: 'P2002' })), 'Taken.')).rejects.toThrow('Taken.')
  })
})
