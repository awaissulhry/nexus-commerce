import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { millimetres, portalSizesFor, protectorZones } from './sizes'

/**
 * owb-pd4s s.3 (S4 products; design § 5q "Customer"): the customer's product Sizes — GET /portal/catalogue/:styleId/sizes — on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the part rule are real), the core,
 * pricing and sizes seeds: SEED-JKT-01 (P1's own label, a DRAFT style priced by P1's list; revision 1 a DRAFT with its live spec —
 * chest width, back length, sleeve length for 50, 52, 54 — and its shoulder (level 2), back and elbow (level 1) protectors) and
 * SEED-JKT-02 (P1's own label, released). The read is the route's own function (portalSizesFor), in the tenant's scope as the
 * person, as the portal's inTenant runs it (a portal session needs the sign-in flow: the route itself is checked for its walls).
 *   - brand wall: customer B (P3) gets nothing for customer A's design (the route's 404), whatever its state
 *   - only the newest RELEASED revision: a draft revision's numbers never appear (none before the release; a later draft changes
 *     nothing)
 *   - no cost, price, revision, route, worker or tolerance key in the answer
 * Every code is made up. Not run in the build (Owner rule: checks at the end).
 */

type Json = Record<string, any>

const NS = 'owb-pd4s-portal-sizes'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const jkt01 = idOf('product:style:JKT-01')
const user = newId()
const today = businessDate(new Date())

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  office: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['product.styles.view', 'product.bom.view', 'portal.catalogue.view'])] },
  // A partner context without a portal session (the portal's sign-in makes one): the route's portal reader refuses it.
  partner: { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1, grants: [grant(['portal.catalogue.view'])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let sizes: SizesDepthSeed

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** The owner, with every trigger off for one statement (set-up only: a release only time reaches). */
async function replica(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** The Sizes of a style for a customer, read as the route reads it (the tenant's scope, as the person). */
const read = (partyId: string, styleId: string, locale = 'en') =>
  database.withScope({ audience: 'office', tenantId: tenant, actorId: user }, (client) => portalSizesFor(client, { companyId: companyA, partyId, day: today, styleId, locale }))
/** Every key of an answer, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : []

beforeAll(async () => {
  db = await migratedDatabase('owb_pd4s_portal_sizes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedPricing({ db: database, namespace: NS })
  sizes = await seedSizesDepth({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the pure parts', () => {
  it('a value in millimetres: centimetres × 10, millimetres as they are', () => {
    expect(millimetres('58.50', 'CM')).toBe(585)
    expect(millimetres('58.35', 'CM')).toBe(583.5)
    expect(millimetres('12.00', 'MM')).toBe(12)
    expect(millimetres('x', 'CM')).toBeNull()
  })

  it("the protector zones: each placed pocket at its highest level, the kind's usual zones at NONE, in the pockets' order", () => {
    expect(protectorZones('JACKET', [{ pocket: 'ELBOW', level: '1' }, { pocket: 'SHOULDER', level: '1' }, { pocket: 'SHOULDER', level: '2' }])).toEqual([
      { zone: 'SHOULDER', level: 'LEVEL_2' },
      { zone: 'ELBOW', level: 'LEVEL_1' },
      { zone: 'BACK', level: 'NONE' },
    ])
    expect(protectorZones('GLOVES', [])).toEqual([])
    expect(protectorZones('TROUSERS', [{ pocket: 'KNEE', level: '1' }])).toEqual([{ zone: 'HIP', level: 'NONE' }, { zone: 'KNEE', level: 'LEVEL_1' }])
  })
})

describe('GET /portal/catalogue/:styleId/sizes (portalSizesFor)', () => {
  it('nothing for a style the catalogue does not offer: a DRAFT style, and customer B for customer A\'s design (brand wall)', async () => {
    expect(await read(P1, jkt01)).toBeNull()
    await admin(`UPDATE "Style" SET status = 'ACTIVE', version = version + 1 WHERE id = $1`, [jkt01])
    // SEED-JKT-01 is P1's own label: another customer gets the route's 404 (null), never a number of it.
    expect(await read(P3, jkt01)).toBeNull()
    expect(await read(P3, newId())).toBeNull()
  })

  it("the newest RELEASED revision only: a draft revision's numbers never appear", async () => {
    // Revision 1 is still a DRAFT: the range and the base size, no point, no protector.
    const before = await read(P1, jkt01)
    expect(before!.answer).toEqual({ mode: 'SIZES', sizes: ['50', '52', '54'], baseSize: '52', points: [], protectors: [] })

    // Released (as only time does it here): its live spec in millimetres, how to measure, its protectors.
    await replica(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [sizes.jacket.revisionId, user])
    const released = (await read(P1, jkt01))!.answer
    const values = await admin<{ code: string; uom: string; size: string; nominal: string }>(
      `SELECT p.code, p.uom::text AS uom, v.size, v.nominal::text AS nominal FROM "MeasurementSpecValue" v JOIN "PointOfMeasure" p ON p.id = v."pointOfMeasureId" WHERE v."specId" = $1`,
      [sizes.jacket.specId],
    )
    const expected: Record<string, Record<string, number | null>> = {}
    for (const row of values) expected[row.code] = { ...(expected[row.code] ?? {}), [row.size]: millimetres(row.nominal, row.uom) }
    expect(Object.fromEntries(released.points.map((point) => [point.code, Object.fromEntries(Object.entries(point.values).filter(([, value]) => value !== null))]))).toEqual(expected)
    expect(released.points.every((point) => Object.keys(point.values).every((size) => ['50', '52', '54'].includes(size)))).toBe(true)
    expect(released.protectors).toEqual([
      { zone: 'SHOULDER', level: 'LEVEL_2' },
      { zone: 'ELBOW', level: 'LEVEL_1' },
      { zone: 'BACK', level: 'LEVEL_1' },
    ])

    // A later DRAFT revision (planted beside it) changes nothing the customer reads.
    await replica(
      `INSERT INTO "StyleRevision" SELECT * FROM jsonb_populate_record(NULL::"StyleRevision", (SELECT to_jsonb(r) || $2::jsonb FROM "StyleRevision" r WHERE r.id = $1))`,
      [sizes.jacket.revisionId, JSON.stringify({ id: newId(), revision: 2, status: 'DRAFT', releasedAt: null, releasedById: null })],
    )
    expect((await read(P1, jkt01))!.answer).toEqual(released)
    // Customer B still reads nothing of it.
    expect(await read(P3, jkt01)).toBeNull()
  })

  it('no cost, price, revision, route, worker or tolerance in the answer; the point names in the person\'s language', async () => {
    const answer = (await read(P1, jkt01, 'it'))!.answer
    const keys = keysOf(answer).filter((key) => !['50', '52', '54'].includes(key))
    for (const word of ['cost', 'price', 'revision', 'route', 'worker', 'tolerance', 'margin', 'supplier']) expect(keys.some((key) => key.toLowerCase().includes(word)), word).toBe(false)
    expect(answer.points.length).toBeGreaterThan(0)
    expect(answer.points.every((point) => typeof point.name === 'string' && point.name.length > 0)).toBe(true)
  })

  it("is the customer portal's route: an office session or a partner context without a portal session is refused", async () => {
    const office = await app.inject({ method: 'GET', url: `/portal/catalogue/${jkt01}/sizes`, headers: { 'x-test-session': 'office' } })
    expect(office.statusCode, office.body).toBe(403)
    const partner = await app.inject({ method: 'GET', url: `/portal/catalogue/${jkt01}/sizes`, headers: { 'x-test-session': 'partner' } })
    expect(partner.statusCode, partner.body).toBe(401)
  })
})
