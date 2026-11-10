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
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { placementsGuarded } from './store'

/**
 * Protector placement (B-W2b-233; PRD-074) on the local stack, through the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, W1's part rule and B-W2b-210's guards are real), the
 * core, sizes and compliance seeds (SEED-JKT-01's DRAFT revision 1 with its shoulder, elbow and back placements and its BOM
 * line of SEED-PRO-300; SEED-PRO-300's EN 1621-1 level 2 certificate; SEED-TRS-01's RELEASED revision 1 with a knee
 * placement), sessions from the test authenticator. Every code is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/protectors`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seed: SizesDepthSeed

const NS = 'w2b233-protectors'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')

const PEOPLE: Record<string, { tenantId: string; permissions: readonly Permission[]; companies: ScopeSet }> = {
  maker: { tenantId: tenant, permissions: ['product.styles.view', 'product.bom.view', 'product.bom.manage', 'audit.read'], companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.styles.view', 'product.bom.view'], companies: 'all' },
  // Sales reads the style, not its BOM: the section's API is not theirs.
  sales: { tenantId: tenant, permissions: ['product.styles.view', 'product.prepacks.manage'], companies: 'all' },
  otherTenant: { tenantId: newId(), permissions: ['product.styles.view', 'product.bom.view', 'product.bom.manage'], companies: 'all' },
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
const events = async () => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'style.protectors_changed' ORDER BY "occurredAt", id`, [tenant])).map((row) => row.payload)
const url = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}/protectors`
const jacket = () => url(seed.jacket.styleId, seed.jacket.revisionId)
const read = async (session = 'maker'): Promise<Json> => (await ok(session, 'GET', jacket())).protectors
const codes = (view: Json): string[] => view.findings.map((finding: Json) => `${finding.code}:${finding.params.item ?? finding.params.pocket ?? ''}:${finding.sizes.join(',')}`)
const placementOf = (view: Json, pocket: string): Json => view.placements.find((placement: Json) => placement.pocket === pocket)

beforeAll(async () => {
  db = await migratedDatabase('w2b233_protectors')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seed = await seedSizesDepth({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  // The shoulder protector's own properties, as B-W2b-206's styles seed types them (made up).
  await admin(`UPDATE "Item" SET properties = '{"standard": "EN 1621-1:2012", "type": "shoulder", "level": "2", "size": "A"}'::jsonb WHERE id = $1`, [seed.protectorIds.shoulder])
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

describe('the placement and what to look at (PRD-074)', () => {
  it('reads the draft jacket: three pockets, checked against the BOM and the certificates; the BOM-less role and another tenant cannot', async () => {
    const view = await read('viewer')
    expect(view.placements.map((placement: Json) => [placement.seq, placement.pocket, placement.protector.code, placement.standard, placement.level, placement.sizes])).toEqual([
      [1, 'SHOULDER', 'SEED-PRO-300', 'EN 1621-1:2012', '2', ['50', '52']],
      [2, 'ELBOW', 'SEED-PRO-330', 'EN 1621-1:2012', '1', []],
      [3, 'BACK', 'SEED-PRO-320', 'EN 1621-2:2014', '1', []],
    ])
    expect(codes(view)).toEqual([
      'NOT_IN_BOM:SEED-PRO-330:50,52,54',
      'NO_ITEM_CERTIFICATE:SEED-PRO-330:50,52,54',
      'NOT_IN_BOM:SEED-PRO-320:50,52,54',
      'NO_ITEM_CERTIFICATE:SEED-PRO-320:50,52,54',
      'BOM_NOT_PLACED:SEED-PRO-300:54',
    ])
    expect(view.choices.map((choice: Json) => [choice.code, choice.inBom])).toEqual(expect.arrayContaining([['SEED-PRO-300', true], ['SEED-PRO-330', false]]))
    expect(view.choices.find((choice: Json) => choice.code === 'SEED-PRO-300')).toMatchObject({ standard: 'EN 1621-1:2012', level: '2' })
    expect(view).toMatchObject({ editable: true, refusal: null, words: '3 placement(s) in 3 pocket(s) · 5 thing(s) to look at', style: { code: 'SEED-JKT-01', sizes: ['50', '52', '54'] } })
    await refused('sales', 'GET', jacket(), undefined, 403)
    await refused('otherTenant', 'GET', jacket(), undefined, 404)
  })

  it("reads the style certificate's levels per pocket", async () => {
    // A registered certificate takes its performance levels once (B-W2b-216): the type was certified with level 2 at the back.
    await admin(`UPDATE "Certificate" SET "performanceLevels" = '{"shoulder": "2", "back": "2"}'::jsonb WHERE number = 'SEED-CERT-0001' AND "tenantId" = $1`, [tenant])
    const view = await read()
    expect(codes(view)).toContain('STYLE_CERTIFICATE_LEVEL:SEED-PRO-320:50,52,54')
    expect(view.findings.find((finding: Json) => finding.code === 'STYLE_CERTIFICATE_LEVEL').message).toBe('Certificate SEED-CERT-0001 was granted with a level 2 back protector; placement 3 asks level 1.')
  })
})

describe('writing the placement of a draft revision', () => {
  it('adds the shoulder for 54 with the protector’s own standard and level; the BOM line is then placed in every size', async () => {
    const view = (await ok('maker', 'POST', jacket(), { pocket: 'SHOULDER', protectorItemId: seed.protectorIds.shoulder, sizes: ['54'], positionNote: 'Left and right, in the sleeve head' }, 201)).protectors
    expect(view.placements.at(-1)).toMatchObject({ seq: 4, pocket: 'SHOULDER', standard: 'EN 1621-1:2012', level: '2', sizes: ['54'], positionNote: 'Left and right, in the sleeve head', version: 1 })
    expect(codes(view)).not.toContain('BOM_NOT_PLACED:SEED-PRO-300:54')
    expect((await events()).at(-1)).toEqual({ styleId: seed.jacket.styleId, code: 'SEED-JKT-01', revisionId: seed.jacket.revisionId, revision: 1, change: 'ADDED', placementIds: [view.placements.at(-1).id] })
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'ProtectorPlacement' AND "recordId" = $1`, [view.placements.at(-1).id])
    expect(audit.map((row) => row.action)).toEqual(['product.protectors.add'])
  })

  it('refuses in words: a second protector in one pocket and size, a material that is not a protector, a size outside the range; a viewer may not', async () => {
    const twice = await refused('maker', 'POST', jacket(), { pocket: 'SHOULDER', protectorItemId: seed.protectorIds.limb, sizes: ['52'] }, 400)
    expect(twice.issues).toEqual([{ path: 'body/sizes', message: 'The shoulder pocket already takes placement 1 for size 52: one protector per pocket and size. Give the sizes to one placement or the other.' }])
    const leather = (await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND kind = 'LEATHER' LIMIT 1`, [tenant]))[0]!.id
    const notProtector = await refused('maker', 'POST', jacket(), { pocket: 'KNEE', protectorItemId: leather }, 400)
    expect(notProtector.issues[0]).toMatchObject({ path: 'body/protectorItemId' })
    expect(notProtector.issues[0].message).toMatch(/is not a protector: a pocket takes a PROTECTOR material\.$/)
    const outside = await refused('maker', 'POST', jacket(), { pocket: 'KNEE', protectorItemId: seed.protectorIds.limb, sizes: ['58'] }, 400)
    expect(outside.issues).toEqual([{ path: 'body/sizes/0', message: "Size 58 is not one of the style's sizes (50, 52, 54)." }])
    await refused('viewer', 'POST', jacket(), { pocket: 'KNEE', protectorItemId: seed.protectorIds.limb }, 403)
  })

  it('changes a cell at its version; a stale version or a change into an overlap is refused', async () => {
    const elbow = placementOf(await read(), 'ELBOW')
    const changed = (await ok('maker', 'PATCH', `${jacket()}/${elbow.id}`, { version: elbow.version, level: '2', positionNote: 'Elbow pocket, velcro opening' })).protectors
    expect(placementOf(changed, 'ELBOW')).toMatchObject({ level: '2', positionNote: 'Elbow pocket, velcro opening', version: elbow.version + 1 })
    expect((await refused('maker', 'PATCH', `${jacket()}/${elbow.id}`, { version: elbow.version, level: '1' }, 409)).message).toMatch(/version/)
    const back = placementOf(changed, 'BACK')
    const clash = await refused('maker', 'PATCH', `${jacket()}/${back.id}`, { version: back.version, pocket: 'ELBOW' }, 400)
    expect(clash.issues[0].message).toMatch(/^The elbow pocket already takes placement 2 for sizes 50, 52, 54:/)
    expect((await refused('maker', 'PATCH', `${jacket()}/${elbow.id}`, { version: elbow.version + 1 }, 400)).message).toBe('Nothing changes: name a field of the placement.')
  })

  it('puts them in order and removes the selection; the rest is numbered again', async () => {
    const before = await read()
    const ids = before.placements.map((placement: Json) => placement.id)
    const reordered = (await ok('maker', 'PUT', `${jacket()}/order`, { placementIds: [ids[2], ids[0], ids[1], ids[3]] })).protectors
    expect(reordered.placements.map((placement: Json) => [placement.seq, placement.pocket])).toEqual([
      [1, 'BACK'],
      [2, 'SHOULDER'],
      [3, 'ELBOW'],
      [4, 'SHOULDER'],
    ])
    await refused('maker', 'PUT', `${jacket()}/order`, { placementIds: [ids[0], ids[1]] }, 409)
    const extra = reordered.placements[3]
    const stale = await refused('maker', 'POST', `${jacket()}/remove`, { placements: [{ id: extra.id, version: extra.version + 5 }] }, 409)
    expect(stale.message).toMatch(/version/)
    const after = (await ok('maker', 'POST', `${jacket()}/remove`, { placements: [{ id: extra.id, version: extra.version }] })).protectors
    expect(after.placements.map((placement: Json) => [placement.seq, placement.pocket])).toEqual([
      [1, 'BACK'],
      [2, 'SHOULDER'],
      [3, 'ELBOW'],
    ])
    expect((await events()).slice(-2).map((event) => event.change)).toEqual(['ORDERED', 'REMOVED'])
  })
})

describe('frozen and held', () => {
  it('a released revision reads with why and refuses every write in words', async () => {
    const released = url(seed.trousers.styleId, seed.trousers.revisionId)
    const view = (await ok('viewer', 'GET', released)).protectors
    expect(view).toMatchObject({ editable: false, refusal: 'Revision 1 is released: its protector placement is frozen. Change it in a new draft revision.' })
    expect(view.placements.map((placement: Json) => placement.pocket)).toEqual(['KNEE'])
    const refusal = await refused('maker', 'POST', released, { pocket: 'HIP', protectorItemId: seed.protectorIds.limb }, 409)
    expect(refusal.message).toBe('Revision 1 is released: its protector placement is frozen. Change it in a new draft revision.')
    const knee = view.placements[0]
    await refused('maker', 'PATCH', `${released}/${knee.id}`, { version: knee.version, level: '2' }, 409)
  })

  it("the style's edit rule holds a draft write (B-W2b-221)", async () => {
    await admin(`INSERT INTO "ProductSettings" (id, "tenantId", "editRuleConcept", "editRuleDevelopment") VALUES ($1, $1, 'BLOCKED', 'BLOCKED')`, [tenant])
    try {
      const view = await read()
      expect(view.editable).toBe(false)
      expect(view.refusal).toMatch(/nothing of it changes in this state/)
      const refusal = await refused('maker', 'POST', jacket(), { pocket: 'HIP', protectorItemId: seed.protectorIds.limb }, 409)
      expect(refusal.issues).toEqual([{ path: 'refusal/EDIT_BLOCKED', message: expect.stringMatching(/nothing of it changes in this state/) }])
    } finally {
      await admin(`DELETE FROM "ProductSettings" WHERE id = $1`, [tenant])
    }
  })

  it('a database refusal reaches the caller as a 409 in words, never a 500', async () => {
    const refusal = Object.assign(new Error('raw'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: 'product: protector placement 0190 names each size once' } } } })
    await expect(placementsGuarded(() => Promise.reject(refusal))).rejects.toThrow(ConflictError)
    await expect(placementsGuarded(() => Promise.reject(refusal))).rejects.toThrow('Protector placement 0190 names each size once. Load the protector placement again.')
    const other = new Error('something else')
    await expect(placementsGuarded(() => Promise.reject(other))).rejects.toBe(other)
  })
})
