import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_leather_stock_w2b_guards
 * triggers are real), tenant A from EVERY seed (the lining lot SEED-LOT-LIN-01 with 120 m at A1-STORE-01 and its two rolls,
 * SEED-RL-0001 60 m there and SEED-RL-0002 44.5 m said to lie at A1-CUT where the ledger holds none; the shoulder protector's
 * lot SEED-LOT-PRO-01 with no certificate, recorded for batch WO-0001 and for WO-0003's first garment; the thread SEED-THR-400
 * by the cone of 5,000 m) and tenant B bare. Made-up figures only. In order:
 *   - the lot's rolls against its ledger; tagging what no roll claims, never more;
 *   - a roll described: width, shrinkage, its shade group; refusals;
 *   - a length issued off a roll from the tablet, a whole roll issued and its end back, moved, measured again, scrapped:
 *     each with the lot's move in the same command, and the roll's history;
 *   - protector lots: a batch's protectors, a garment recorded on the tablet with the warnings, refusals, a withdrawal, the
 *     recall of the lot;
 *   - consumables: packs beside metres, the site's minimum and maximum through planning, the reorder in whole packs, the pack.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/rolls`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'rolls-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `rolls-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const lastId = (key: string) => `ffffffff${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  siteA1: id('site:A1'),
  liningLot: id('inventory:lot:LIN-01'),
  lining: id('product:item:lining'),
  protector: id('product:item:protector'),
  protectorLot: id('leather:lot:PRO-01'),
  thread: id('leather:item:THR-400'),
  bin: id('inventory:location:A1-STORE-01'),
  cut: id('inventory:location:A1-CUT'),
  rollFull: firstId('leather:roll:1'),
  rollPartial: id('leather:roll:2'),
  shadeLining: id('leather:shade:LIN-200:1'),
  shadeLeather: id('leather:shade:LEA-100:BLK:1'),
  wo1: id('production:work-order:WO-0001'),
  wo2: firstId('production:work-order:WO-0002'),
  wo3: lastId('quality:work-order:WO-0003'),
  serial1: firstId('quality:serial:WO-0003:1'),
  device: id('device:A1:cutting'),
  operator: id('worker:A1:operator'),
}
const tenantB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const KEEP: Permission[] = [
  'inventory.stock.view',
  'inventory.receive',
  'inventory.issue',
  'inventory.issue.over',
  'inventory.transfer',
  'inventory.scrap',
  'inventory.adjust',
  'inventory.rolls.manage',
  'inventory.protectors.record',
  'workorders.view',
  'quality.lots.view',
  'product.materials.view',
  'product.materials.manage',
  'planning.view',
  'planning.items.manage',
]
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, [grant(KEEP)]),
  viewer: office(A.tenant, [grant(['inventory.stock.view', 'workorders.view', 'quality.lots.view', 'product.materials.view'])]),
  keeperB: office(tenantB, [grant(KEEP)]),
  // B-W2b-219: prints a roll's tag (the receiving bench's tablet; the office).
  printer: office(A.tenant, [grant(['inventory.stock.view', 'print.view', 'print.labels'])]),
  floorPrint: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: A.device, grants: [grant(['floor.work', 'inventory.receive', 'print.view', 'print.labels'], { companies: [A.companyA], sites: [A.siteA1] })] },
  floor: {
    audience: 'floor',
    tenantId: A.tenant,
    actorId: A.operator,
    siteId: A.siteA1,
    deviceId: A.device,
    grants: [grant(['floor.work', 'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.locations.view', 'inventory.protectors.record'], { companies: [A.companyA], sites: [A.siteA1] })],
  },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = idem()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
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
/** What the ledger holds of the lining lot at a place. */
const atPlace = async (locationId: string) =>
  (
    await admin<{ n: string }>(
      `SELECT (coalesce(sum(CASE WHEN "toLocationId" = $2 THEN "baseQuantity" END), 0) - coalesce(sum(CASE WHEN "fromLocationId" = $2 THEN "baseQuantity" END), 0))::numeric(18,4)::text AS n FROM "StockMove" WHERE "lotId" = $1`,
      [A.liningLot, locationId],
    )
  )[0]!.n
const rollRow = async (rollId: string) => (await admin<Json>(`SELECT code, state, "lengthLeft"::text AS left, "locationId", version FROM "FabricRoll" WHERE id = $1`, [rollId]))[0]!

beforeAll(async () => {
  db = await migratedDatabase('inventory_rolls')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'rolls-b', 'Gruppo Nuovo')`, [tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

const made: { a?: Json; b?: Json } = {}

describe('fabric rolls (SCM-260)', () => {
  it("says the lot's rolls against its ledger, and tags only what no roll claims", async () => {
    const list = await ok('viewer', 'GET', `/inventory/rolls?lotId=${A.liningLot}`)
    expect(list.summary).toMatchObject({ rolls: 2, length: '104.5000', uom: 'M', words: { en: '2 rolls · 104.5 m', it: '2 rotoli · 104,5 m' } })
    expect(list.lot).toMatchObject({ onHand: '120.0000', tagged: '104.5000', untagged: '60.0000', beyond: '44.5000', rolls: 2 })
    expect(list.lot.words.en).toBe('120 m in stock: 2 rolls · 104.5 m; 60 m on no roll; the rolls say 44.5 m more than the ledger holds where they lie')
    expect(list.rows.map((row: Json) => [row.code, row.state, row.lengthLeft])).toEqual([
      ['SEED-RL-0002', 'PARTIAL', '44.5000'],
      ['SEED-RL-0001', 'FULL', '60.0000'],
    ])
    // Cut-order filters: width and shrinkage group.
    expect((await ok('viewer', 'GET', '/inventory/rolls?shrinkageGroup=S1&minWidthCm=144')).rows.map((row: Json) => row.code)).toEqual(['SEED-RL-0002'])

    const tooMuch = await refused('keeper', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { rolls: [{ length: '35' }, { length: '25.5' }] }, 409)
    expect(paths(tooMuch)).toEqual(['refusal/TAGGED_BEYOND_STOCK'])
    expect(tooMuch.message).toBe('The 2 rolls say 60.5 m, but lot SEED-LOT-LIN-01 has 60 m at A1-STORE-01 that no roll claims yet.')
    expect(paths(await refused('keeper', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { rolls: [{ length: '10', shadeGroupId: A.shadeLeather }] }, 400))).toEqual(['body/rolls/0/shadeGroupId'])
    expect(paths(await refused('keeper', 'POST', `/inventory/lots/${A.protectorLot}/rolls`, { rolls: [{ length: '1' }] }, 409))).toEqual(['refusal/NOT_A_FABRIC_LOT'])
    await refused('viewer', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { rolls: [{ length: '1' }] }, 403)
    await refused('keeperB', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { rolls: [{ length: '1' }] }, 404)

    // The receiving tablet tags a roll in centimetres (the one place holding untagged stock is taken), the office the rest in metres.
    const tagged = await ok('floor', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { uom: 'CM', rolls: [{ length: '2500', shadeGroupId: A.shadeLining, supplierRollRef: 'M-9001' }] }, 201)
    expect(tagged.rolls.map((roll: Json) => [roll.state, roll.length, roll.uom, roll.location.code, roll.shade, roll.words.en])).toEqual([['FULL', '2500.0000', 'CM', 'A1-STORE-01', '1', '2,500 cm of 2,500 cm']])
    expect(tagged.rolls.every((roll: Json) => /^RL-/.test(roll.code))).toBe(true)
    expect(tagged.lot).toMatchObject({ untagged: '35.0000' })
    const more = await ok('keeper', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { locationId: A.bin, rolls: [{ length: '35', widthCm: '146', supplierRollRef: 'M-9002' }] }, 201)
    made.a = more.rolls[0]
    made.b = tagged.rolls[0]
    expect(more.lot).toMatchObject({ onHand: '120.0000', untagged: '0.0000', tagged: '164.5000', beyond: '44.5000', rolls: 4 })
    expect(paths(await refused('keeper', 'POST', `/inventory/lots/${A.liningLot}/rolls`, { locationId: A.bin, rolls: [{ length: '1' }] }, 409))).toEqual(['refusal/NOTHING_TO_TAG'])
    expect(await atPlace(A.bin)).toBe('120.0000')
    const tags = await events('fabric_roll.tagged')
    expect(tags.map((payload) => [payload.codes.length, payload.postedBy])).toEqual([
      [1, 'FLOOR'],
      [1, 'OFFICE'],
    ])
  })

  it('describes a roll: width, shrinkage, its shade group, refusals', async () => {
    const roll = made.a!
    const described = await ok('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version, widthCm: '145.5', shrinkageLengthPercent: '1.2', shrinkageWidthPercent: '0.6', shrinkageGroup: 'S2', shadeGroupId: A.shadeLining, defects: 'Two slubs at 12 m.' })
    expect(described.roll).toMatchObject({ widthCm: '145.50', shrinkageLengthPercent: '1.20', shrinkageWidthPercent: '0.60', shrinkageGroup: 'S2', shade: '1', shadeGroup: { label: '1' }, defects: 'Two slubs at 12 m.', version: roll.version + 1 })
    expect((await refused('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version, widthCm: '140' }, 409)).message).toBeTruthy()
    expect(paths(await refused('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, shade: 'Dark' }, 400))).toEqual(['body/shade'])
    expect(paths(await refused('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, shadeGroupId: A.shadeLeather }, 400))).toEqual(['body/shadeGroupId'])
    expect(paths(await refused('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, end: true }, 409))).toEqual(['refusal/NOT_A_PART_ROLL'])
    await refused('viewer', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, widthCm: '140' }, 403)
    await refused('floor', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, widthCm: '140' }, 403)
    // Nothing changes: no new version.
    expect((await ok('keeper', 'PATCH', `/inventory/rolls/${roll.id}`, { version: roll.version + 1, widthCm: '145.50' })).roll.version).toBe(roll.version + 1)
    made.a = described.roll
  })

  it("takes length off a roll with the lot's issue, a whole roll and its end back, a move, a measure, a scrap", async () => {
    const roll = made.a!
    // The tablet takes 10 m for WO-0001 (it plans 13.23 m of the lining).
    const issued = await ok('floor', 'POST', `/inventory/rolls/${roll.id}/issue`, { workOrderId: A.wo1, length: '10' }, 200, 'rolls-issue-resend-0001')
    // The tablet's queue sends it again: the stored answer, nothing taken twice.
    expect(await ok('floor', 'POST', `/inventory/rolls/${roll.id}/issue`, { workOrderId: A.wo1, length: '10' }, 200, 'rolls-issue-resend-0001')).toEqual(issued)
    expect(issued.roll).toMatchObject({ state: 'PARTIAL', lengthLeft: '25.0000', location: { code: 'A1-STORE-01' } })
    expect(issued.workOrderId).toBe(A.wo1)
    expect(await atPlace(A.bin)).toBe('110.0000')
    const beyond = await refused('floor', 'POST', `/inventory/rolls/${roll.id}/issue`, { workOrderId: A.wo1, length: '30' }, 409)
    expect([paths(beyond), beyond.message]).toEqual([['refusal/LENGTH_BEYOND_LEFT'], `Roll ${roll.code} has 25 m left: take at most that.`])
    // W1's rule: more than the work order still needs is the office's over-issue, with its reason.
    const over = await refused('floor', 'POST', `/inventory/rolls/${made.b!.id}/issue`, { workOrderId: A.wo1 }, 409)
    expect(paths(over)[0]).toMatch(/^refusal\//)

    // The office sends the 25 m roll whole to the cutting table, then its end comes back.
    const whole = await ok('keeper', 'POST', `/inventory/rolls/${made.b!.id}/issue`, { workOrderId: A.wo1, overIssueReason: 'The whole roll goes on the lay.' })
    expect(whole.roll).toMatchObject({ state: 'CONSUMED', lengthLeft: '0.0000', location: null, inStock: false })
    expect(await atPlace(A.bin)).toBe('85.0000')
    const elsewhere = await refused('floor', 'POST', `/inventory/rolls/${made.b!.id}/return`, { workOrderId: A.wo3, length: '620', uom: 'CM', toLocationId: A.cut }, 409)
    expect(elsewhere.message).toBe(`Work order SEED-WO-0003 holds none of lot SEED-LOT-LIN-01: roll ${made.b!.code} did not go to it.`)
    const back = await ok('floor', 'POST', `/inventory/rolls/${made.b!.id}/return`, { workOrderId: A.wo1, length: '6.2', uom: 'M', toLocationId: A.cut, note: 'End of the lay.' })
    expect(back.roll).toMatchObject({ state: 'END', lengthLeft: '620.0000', uom: 'CM', location: { code: 'A1-CUT' } })
    expect(await atPlace(A.cut)).toBe('6.2000')
    expect(paths(await refused('floor', 'POST', `/inventory/rolls/${roll.id}/return`, { workOrderId: A.wo1, length: '1', toLocationId: A.cut }, 409))).toEqual(['refusal/ROLL_NOT_CONSUMED'])

    // The end goes back to the store's bin; the same place again is refused.
    const moved = await ok('floor', 'POST', `/inventory/rolls/${made.b!.id}/move`, { toLocationId: A.bin })
    expect(moved.roll.location.code).toBe('A1-STORE-01')
    expect([await atPlace(A.cut), await atPlace(A.bin)]).toEqual(['0.0000', '91.2000'])
    expect(paths(await refused('floor', 'POST', `/inventory/rolls/${made.b!.id}/move`, { toLocationId: A.bin }, 409))).toEqual(['refusal/SAME_PLACE'])

    // Measured again: 25 said, 24.4 found; the lot's adjustment of 0.6 m in the same command.
    await refused('keeper', 'POST', `/inventory/rolls/${roll.id}/correct`, { lengthLeft: '24.4', note: 'x' }, 400)
    const corrected = await ok('keeper', 'POST', `/inventory/rolls/${roll.id}/correct`, { lengthLeft: '24.4', note: 'Measured on the table.', reasonCode: 'COUNT_ERROR' })
    expect(corrected.roll).toMatchObject({ state: 'PARTIAL', lengthLeft: '24.4000' })
    expect(await atPlace(A.bin)).toBe('90.6000')
    expect(paths(await refused('keeper', 'POST', `/inventory/rolls/${roll.id}/correct`, { lengthLeft: '40', note: 'Longer than it came.' }, 409))).toEqual(['refusal/LENGTH_BEYOND_ROLL'])
    await refused('floor', 'POST', `/inventory/rolls/${roll.id}/correct`, { lengthLeft: '20', note: 'Shorter.' }, 403)

    // SEED-RL-0001 is scrapped: a WRITE_OFF reason, the whole of it leaves the stock.
    expect(paths(await refused('keeper', 'POST', `/inventory/rolls/${A.rollFull}/scrap`, { reasonCode: 'OTHER' }, 400))).toEqual(['body/note'])
    const scrapped = await ok('keeper', 'POST', `/inventory/rolls/${A.rollFull}/scrap`, { reasonCode: 'DAMAGED', note: 'Wet in the store.' })
    expect(scrapped.roll).toMatchObject({ state: 'SCRAPPED', lengthLeft: '60.0000', location: null })
    expect(await atPlace(A.bin)).toBe('30.6000')
    expect(paths(await refused('keeper', 'PATCH', `/inventory/rolls/${A.rollFull}`, { version: scrapped.roll.version, widthCm: '1' }, 409))).toEqual(['refusal/ROLL_GONE'])
    // SEED-RL-0002 says it lies where the ledger holds none: the ledger refuses the move (never below zero).
    await refused('keeper', 'POST', `/inventory/rolls/${A.rollPartial}/move`, { toLocationId: A.bin }, 409)

    const moves = await admin<{ reason: string; n: string }>(
      `SELECT reason::text, "baseQuantity"::numeric(18,4)::text AS n FROM "StockMove" WHERE "lotId" = $1 AND "idempotencyKey" LIKE 'inventory.%Roll:%' ORDER BY id`,
      [A.liningLot],
    )
    expect(moves.map((move) => [move.reason, move.n])).toEqual([
      ['ISSUE', '10.0000'],
      ['ISSUE', '25.0000'],
      ['RETURN', '6.2000'],
      ['TRANSFER', '6.2000'],
      ['ADJUSTMENT', '0.6000'],
      ['SCRAP', '60.0000'],
    ])
    const changes = (await events('fabric_roll.changed')).map((payload) => [payload.change, payload.state, payload.moveIds.length, payload.postedBy])
    expect(changes).toEqual([
      ['DESCRIBED', 'FULL', 0, 'OFFICE'],
      ['ISSUED', 'PARTIAL', 1, 'FLOOR'],
      ['ISSUED', 'CONSUMED', 1, 'OFFICE'],
      ['RETURNED', 'END', 1, 'FLOOR'],
      ['MOVED', 'END', 1, 'FLOOR'],
      ['CORRECTED', 'PARTIAL', 1, 'OFFICE'],
      ['SCRAPPED', 'SCRAPPED', 1, 'OFFICE'],
    ])
    // The roll and its lot's ledger agree after every write.
    const list = await ok('viewer', 'GET', `/inventory/rolls?lotId=${A.liningLot}`)
    expect(list.lot).toMatchObject({ onHand: '30.6000', untagged: '0.0000', beyond: '44.5000' })
    expect(await rollRow(roll.id)).toMatchObject({ state: 'PARTIAL', left: '24.4000' })
  })

  it('looks a scanned tag up and tells a roll its history', async () => {
    const roll = made.b!
    expect((await ok('floor', 'GET', `/inventory/rolls/lookup?code=${roll.code.toLowerCase()}`)).roll).toMatchObject({ id: roll.id, state: 'END' })
    await refused('floor', 'GET', '/inventory/rolls/lookup?code=RL-ZZ-ZZZZ-Z', undefined, 404)
    await refused('keeperB', 'GET', `/inventory/rolls/${roll.id}`, undefined, 404)
    const record = await ok('viewer', 'GET', `/inventory/rolls/${roll.id}`)
    expect(record.history.map((entry: Json) => [entry.action, entry.to, entry.audience, entry.workOrderNumber])).toEqual([
      ['MOVED', 'END', 'FLOOR', null],
      ['RETURNED', 'END', 'FLOOR', 'SEED-WO-0001'],
      ['ISSUED', 'CONSUMED', 'OFFICE', 'SEED-WO-0001'],
      ['TAGGED', 'FULL', 'FLOOR', null],
    ])
    expect(record.history.every((entry: Json) => entry.audience !== 'FLOOR' || entry.by === null)).toBe(true)
  })

  it('B-W2b-219: prints the ROLL tag from the record (its RL code, length left, width, shade, lot) on a label printer of the site', async () => {
    const roll = made.a!
    const printerId = newId()
    await admin(
      `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-RL', 'Made-up label printer', 'LABEL_ZPL', 'FAKE', 'made-up:9100', 203, 100, 50)`,
      [printerId, A.tenant, A.companyA, A.siteA1],
    )
    const job = (await ok('floorPrint', 'POST', `/print/jobs/roll-tag/${roll.id}`, { printerId, language: 'it' }, 201)).job
    expect(job).toMatchObject({ labelKind: 'ROLL', scanId: roll.code, recordType: 'FabricRoll', recordId: roll.id, status: 'QUEUED' })
    const [stored] = await admin<{ zpl: string }>(`SELECT zpl FROM "PrintJob" WHERE id = $1`, [job.id])
    expect(stored!.zpl).toContain('Rotolo')
    expect(stored!.zpl).toContain('Lunghezza')
    expect((await ok('printer', 'POST', `/print/jobs/roll-tag/${roll.id}`, { printerId, copies: 2, language: 'en' }, 201)).job).toMatchObject({ labelKind: 'ROLL', copies: 2 })
    // Another tenant's office is not shown the roll; the viewer may not print.
    await refused('keeperB', 'POST', `/print/jobs/roll-tag/${roll.id}`, { printerId }, 403)
    await refused('viewer', 'POST', `/print/jobs/roll-tag/${roll.id}`, { printerId }, 403)
  })
})

describe('protector lots (SCM-261)', () => {
  it("shows a batch's protectors against its records, and the lots it holds", async () => {
    const batch = await ok('viewer', 'GET', `/inventory/work-orders/${A.wo1}/protector-lots`)
    expect(batch.protectors).toEqual([expect.objectContaining({ item: expect.objectContaining({ code: 'SEED-PRO-300' }), planned: true, batchLotIds: [A.protectorLot], garments: 0, missing: false })])
    expect(batch.records.map((record: Json) => [record.placement, record.withdrawn === null, record.certificate.state])).toEqual([
      ['shoulder', true, 'MISSING'],
      ['elbow', false, 'MISSING'],
    ])
    expect(batch.words.en).toBe('Every protector the batch plans has its lot on record.')
    // The tablet reads it through its own route; the office route is not the floor's.
    expect((await ok('floor', 'GET', `/inventory/protector-lots/work-orders/${A.wo1}`)).protectors[0].registerCertificate).toBeNull()
    await refused('floor', 'GET', `/inventory/work-orders/${A.wo1}/protector-lots`, undefined, 403)
  })

  it('records a garment on the tablet with its warnings, refuses in words, and the office withdraws a wrong one', async () => {
    const recorded = await ok('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo3, serial: 'seed-sn-0002', lotCode: 'SEED-LOT-PRO-01', placement: 'back' }, 201)
    expect(recorded.record).toMatchObject({ garmentSerial: { serial: 'SEED-SN-0002' }, lot: { code: 'SEED-LOT-PRO-01' }, placement: 'back', withdrawn: null })
    expect(recorded.warnings.map((warning: Json) => warning.code)).toEqual(['CERTIFICATE_MISSING', 'NOT_ISSUED_TO_ORDER'])
    expect(paths(await refused('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo3, serial: 'SEED-SN-0002', lotId: A.protectorLot, placement: 'back' }, 409))).toEqual(['refusal/ALREADY_RECORDED'])
    expect(paths(await refused('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo2, lotId: A.protectorLot }, 409))).toEqual(['refusal/NOTHING_BUILT'])
    expect(paths(await refused('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo1, lotId: A.liningLot }, 409))).toEqual(['refusal/NOT_A_PROTECTOR'])
    expect(paths(await refused('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo1, garmentSerialId: A.serial1, lotId: A.protectorLot }, 409))).toEqual(['refusal/SERIAL_NOT_OF_ORDER'])
    expect(paths(await refused('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo1, lotId: A.protectorLot, lotCode: 'X' }, 400))).toEqual(['body/lotId'])
    await refused('viewer', 'POST', '/inventory/protector-lots', { workOrderId: A.wo1, lotId: A.protectorLot }, 403)
    await refused('keeperB', 'POST', '/inventory/protector-lots', { workOrderId: A.wo1, lotId: A.protectorLot }, 404)

    await refused('floor', 'POST', `/inventory/protector-lots/${recorded.record.id}/withdraw`, { version: 1, reason: 'Wrong garment.' }, 403)
    const withdrawn = await ok('keeper', 'POST', `/inventory/protector-lots/${recorded.record.id}/withdraw`, { version: recorded.record.version, reason: 'Scanned on the wrong garment.' })
    expect(withdrawn.record.withdrawn).toMatchObject({ reason: 'Scanned on the wrong garment.' })
    expect(paths(await refused('keeper', 'POST', `/inventory/protector-lots/${recorded.record.id}/withdraw`, { version: withdrawn.record.version, reason: 'Again.' }, 409))).toEqual(['refusal/WITHDRAWN_ALREADY'])
    // The garment that really holds it.
    await ok('floor', 'POST', '/inventory/protector-lots', { workOrderId: A.wo3, serial: 'SEED-SN-0003', lotId: A.protectorLot, placement: 'back' }, 201)
    expect((await events('protector_lot.recorded')).length).toBe(2)
    expect((await events('protector_lot.withdrawn')).map((payload) => payload.rowId)).toEqual([recorded.record.id])
  })

  it('recalls a protector lot: batches, garments, issued without a record, and the PPE register concern', async () => {
    const recall = await ok('viewer', 'GET', `/inventory/lots/${A.protectorLot}/protector-recall`)
    expect(recall.batches.map((batch: Json) => [batch.workOrder.number, batch.placements])).toEqual([['SEED-WO-0001', ['shoulder']]])
    expect(recall.garments.map((garment: Json) => [garment.serial.serial, garment.workOrder.number, garment.placement])).toEqual([
      ['SEED-SN-0001', 'SEED-WO-0003', 'shoulder'],
      ['SEED-SN-0003', 'SEED-WO-0003', 'back'],
    ])
    expect(recall.certificate.state).toBe('MISSING')
    expect(recall.words.en).toBe('Lot SEED-LOT-PRO-01 is in 1 batch and 2 garments on record: SEED-WO-0001 (whole batch), SEED-SN-0001, SEED-SN-0003.')
    expect(recall.registerConcern).toEqual({ lotIds: [A.protectorLot], workOrderIds: [A.wo1, A.wo3], serials: ['SEED-SN-0001', 'SEED-SN-0003'] })
    await refused('keeper', 'GET', `/inventory/lots/${newId()}/protector-recall`, undefined, 404)
  })
})

describe('consumables by pack (SCM-263)', () => {
  it("counts in packs, orders up to the site's maximum in whole packs, and keeps the pack", async () => {
    const first = await ok('viewer', 'GET', `/inventory/consumables?siteId=${A.siteA1}`)
    const thread = () => first.rows.find((row: Json) => row.item.code === 'SEED-THR-400')
    expect(thread()).toMatchObject({ pack: { packSize: '5000.0000', packUom: 'CONE' }, onHand: '0.0000', state: 'NO_LEVELS', reorder: null, canEditPack: false, canEditLevels: false })

    await ok('keeper', 'POST', '/planning/item-parameters', { siteId: A.siteA1, itemId: A.thread, method: 'MIN_MAX', minStock: '20000', maxStock: '50000' }, 201)
    const levelled = (await ok('keeper', 'GET', `/inventory/consumables?siteId=${A.siteA1}&state=BELOW_MIN`)).rows
    expect(levelled.map((row: Json) => row.item.code)).toContain('SEED-THR-400')
    const row = levelled.find((entry: Json) => entry.item.code === 'SEED-THR-400')
    expect(row).toMatchObject({ state: 'BELOW_MIN', levels: { method: 'MIN_MAX', minStock: '20000.0000', maxStock: '50000.0000' }, reorder: { quantity: '50000.0000', packs: '10', words: { en: '10 cones · 50,000 m' } }, canEditPack: true, canEditLevels: true })

    const changed = await ok('keeper', 'PUT', `/inventory/consumables/${A.thread}/pack`, { version: row.item.version, packSize: '4000', packUom: 'CONE' })
    expect(changed.pack).toMatchObject({ packSize: '4000.0000', packUom: 'CONE', words: { en: '1 cone = 4,000 m' } })
    expect((await ok('keeper', 'GET', `/inventory/consumables?siteId=${A.siteA1}&q=THR-400`)).rows[0].reorder).toMatchObject({ quantity: '52000.0000', packs: '13' })
    await refused('keeper', 'PUT', `/inventory/consumables/${A.thread}/pack`, { version: row.item.version, packSize: '3000', packUom: 'CONE' }, 409)
    expect((await ok('keeper', 'PUT', `/inventory/consumables/${A.thread}/pack`, { version: changed.item.version, packSize: '3000', packUom: 'BOX' })).pack).toMatchObject({ packSize: '3000.0000', packUom: 'BOX' })
    expect(paths(await refused('keeper', 'PUT', `/inventory/consumables/${A.thread}/pack`, { version: changed.item.version + 1, packSize: '3000', packUom: null }, 400))).toEqual(['body/packUom'])
    await refused('viewer', 'PUT', `/inventory/consumables/${A.thread}/pack`, { version: changed.item.version, packSize: null, packUom: null }, 403)
    expect((await events('consumable.pack_changed')).map((payload) => [payload.packSize, payload.packUom])).toEqual([
      ['4000.0000', 'CONE'],
      ['3000.0000', 'BOX'],
    ])
  })
})
