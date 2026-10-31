import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedHolds, type HoldsSeed } from '../seed/holds'
import { seed as seedPlant, type PlantSeed } from '../seed/plant'
import { seed as seedSourcing } from '../seed/sourcing'
import { seed as seedSubcontract } from '../seed/subcontract'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * W2a schema wave 6/7 (quality, plant and shipping) beyond the generated isolation tests, on a database built from the
 * migrations and seeded, through the real login and the scoped client (…_quality_plant_w2a_guards):
 *   - the walls: NCRs and disposition codes are the office's; the floor never reads a machine's cost or a freight figure;
 *   - a quality hold blocks what it holds, for every login: the issue and the cut of a held lot or hide, the scan of a held
 *     bundle, the release and packing of a held work order's garments or a held serial, a held shipment or parcel
 *     leaving; a hold placed while an issue waits is seen by it; the hold's own rules (what it holds, who places and
 *     releases it, the four eyes);
 *   - the defect library's two levels and the inspection defects picked from it, the disposition codes, the
 *     inspector's assignment;
 *   - an NCR from OPEN to CLOSED: containment, decisions by quantity (never "use as is" on a major one), approval by
 *     another person, the stock move, the closing;
 *   - an unsafe machine (Owner answer H1): locked at once, only a signed-safe request frees it, a job hands it back
 *     running only then;
 *   - DDTs for other reasons, the freight charge and rule, the intra-EU transport evidence, the PPE register's NCR source;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2a6-a'
const DENIED = /permission denied/
const TABLES = ['DefectCode', 'DispositionCode', 'QualityHold', 'Nonconformance', 'NcrContainmentAction', 'NcrDispositionLine', 'NcrLink', 'MachineClass', 'MachineSymptom', 'Machine', 'MaintenanceRequest', 'MaintenanceJob'] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let holds: HoldsSeed
let plant: PlantSeed
let claimId: string
let subcontractOrderId: string

const key = (name: string): string => seedUuid(NS, name)
const first = (name: string): string => `00000000${key(name).slice(8)}`
const A = {
  companyA: key('company:A'),
  siteA: key('site:A1'),
  siteB: key('site:B1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  operator: key('worker:A1:operator'),
  lead: key('worker:A1:lead'),
  leather: key('product:item:leather'),
  leatherBLK: key('product:item-colour:leather:BLK'),
  lining: key('product:item:lining'),
  liningGRY: key('product:item-colour:lining:GRY'),
  bin: key('inventory:location:A1-STORE-01'),
  quarantine: key('inventory:location:A1-QUA'),
  store: key('inventory:location:A1-STORE'),
  liningLot: key('inventory:lot:LIN-01'),
  leatherLot: key('inventory:lot:LEA-01'),
  hide1: key('inventory:hide:H1'),
  hide2: key('inventory:hide:H2'),
  wo1: key('production:work-order:WO-0001'),
  sh1: key('shipping:shipment:SH-0001'),
  sh2: first('shipping:shipment:SH-0002'),
  sh2Line: first('shipping:SH-0002:line:BLK-52-JKT-03'),
  sh2Parcel: first('shipping:SH-0002:parcel:1'),
}

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (worker: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: worker, siteId: A.siteA })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: A.P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n)
const tag = (): string => randomUUID().slice(0, 8)
const sha = 'a'.repeat(64)
const value = async (text: string, values: unknown[] = []): Promise<unknown> => Object.values((await admin(text, values))[0] ?? {})[0]
/** An insert of the row's columns only (the others take their defaults, the tenant the scope's). */
const insertSql = (table: string, row: Record<string, unknown>): string => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, insertSql(table, row), JSON.stringify(row))

class Rollback extends Error {}
/** Runs the statements in one transaction of the scope and rolls it back (so a test leaves nothing behind). */
type Exec = (text: string, ...values: unknown[]) => Promise<number>
async function rolledBack(scope: FactoryScope, work: (exec: Exec, ins: (table: string, row: Record<string, unknown>) => Promise<number>) => Promise<void>): Promise<void> {
  await expect(
    as(scope, (client) =>
      client.$transaction(async (tx) => {
        const exec: Exec = (text, ...values) => tx.$executeRawUnsafe(text, ...values)
        await work(exec, (table, row) => exec(insertSql(table, row), JSON.stringify(row)))
        throw new Rollback('rolled back')
      }),
    ),
  ).rejects.toThrow(Rollback)
}

/** A hold row of A1 placed by the office (an id, its subjects and the rest defaulted). */
const hold = (subjectType: string, subjectIds: readonly string[], extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  subjectType,
  subjectIds,
  reasonCode: 'QUALITY_CHECK',
  placedAt: new Date().toISOString(),
  placedById: a.actorId,
  // B-W2b-F1: a new hold comes numbered (a made-up number).
  number: `HLD-T-${randomUUID().slice(0, 8)}`,
  ...extra,
})
const release = (worker: string | null = null) =>
  worker
    ? `status = 'RELEASED', "releasedAt" = now(), "releasedByWorkerId" = '${worker}', "releaseSignatureSha256" = '${sha}'`
    : `status = 'RELEASED', "releasedAt" = now(), "releasedById" = '${randomUUID()}', "releaseSignatureSha256" = '${sha}'`
/** An ISSUE of 1 m of the lining lot to WO-0001, as the office posts it. */
const liningIssue = () => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  reason: 'ISSUE',
  itemId: A.lining,
  itemColourId: A.liningGRY,
  lotId: A.liningLot,
  fromLocationId: A.bin,
  quantity: '1.0000',
  uom: 'M',
  baseQuantity: '1.0000',
  workOrderId: A.wo1,
  idempotencyKey: `test-${tag()}`,
  occurredAt: new Date().toISOString(),
})

beforeAll(async () => {
  db = await migratedDatabase('qualityplantw2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  holds = await seedHolds({ db: factory, namespace: NS })
  plant = await seedPlant({ db: factory, namespace: NS })
  claimId = (await seedSourcing({ db: factory, namespace: NS })).claimId
  subcontractOrderId = (await seedSubcontract({ db: factory, namespace: NS })).orderId
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedHolds({ db: factory, namespace: NS })
    await seedPlant({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
    // The DDT for the repair took the series' next number, without a gap.
    expect(await value(`SELECT number FROM "Ddt" WHERE id = $1`, [holds.repairDdtId])).toBe('145/2026')
    expect(await value(`SELECT "recordId"::text FROM "NumberAllocation" WHERE "formatted" = '145/2026' AND "tenantId" = $1`, [a.tenantId])).toBe(holds.repairDdtId)
  })

  it('the floor reads no NCR, no disposition code, no machine cost and no freight figure; a partner no evidence checker', async () => {
    const floor = floorAs(A.operator)
    for (const table of ['Nonconformance', 'NcrContainmentAction', 'NcrDispositionLine', 'NcrLink', 'DispositionCode']) {
      await expect(sql(floor, `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    await expect(sql(floor, `SELECT "purchaseCost" FROM "Machine" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(sql(floor, `SELECT "freightCharge" FROM "Shipment" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(sql(floor, `SELECT "freightAmount" FROM "ShippingSettings" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(run(floor, `UPDATE "Shipment" SET "freightCharge" = 0 WHERE id = $1::uuid`, A.sh2)).rejects.toThrow(DENIED)
    expect((await sql(floor, `SELECT "assetNumber" FROM "Machine" ORDER BY "assetNumber"`)).map((row) => row.assetNumber)).toEqual(['SEED-CP-01', 'SEED-CT-01', 'SEED-SEW-L1-01'])
    expect((await sql(floor, `SELECT code FROM "DefectCode" WHERE code = 'GRAIN-CRACK'`)).length).toBe(1)
    await expect(sql(partner(), `SELECT "transportEvidenceById" FROM "Shipment" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(sql(partner(), `SELECT "transportEvidenceNote" FROM "Shipment" LIMIT 1`)).rejects.toThrow(DENIED)
    expect((await sql(partner(), `SELECT "freightCharge" FROM "Shipment"`)).length).toBeGreaterThan(0)
  })
})

// --- quality holds ------------------------------------------------------------------------------------------------

describe('a quality hold blocks what it holds', () => {
  it('a held hide is neither issued nor cut; a held lot neither; the issue goes through once nothing holds it', async () => {
    const h2Issue = { ...liningIssue(), itemId: A.leather, itemColourId: A.leatherBLK, lotId: A.leatherLot, hideId: A.hide2, quantity: '51.8000', uom: 'FT2', baseQuantity: '51.8000' }
    await expect(insert(office(), 'StockMove', h2Issue)).rejects.toThrow(/hide .* is on hold \(hold .*\); it is not issued/)
    await expect(
      insert(floorAs(A.operator), 'CutLog', { id: randomUUID(), siteId: A.siteA, workOrderId: A.wo1, lotId: A.leatherLot, hideId: A.hide2, uom: 'FT2', areaUsed: '1', baseAreaUsed: '1', clientEventId: tag() }),
    ).rejects.toThrow(/hide .* is on hold .*; it is not cut/)
    // A hold of the lining lot: its issue is refused, inside the same transaction too; released, it goes through.
    await rolledBack(office(), async (_exec, ins) => {
      const lotHold = hold('Lot', [A.liningLot])
      await ins('QualityHold', { ...lotHold, status: 'ACTIVE', quarantine: 'NOT_NEEDED', notMakerStatement: false, version: 1, createdAt: lotHold.placedAt, updatedAt: lotHold.placedAt })
      const issue = liningIssue()
      await expect(ins('StockMove', { ...issue, createdAt: issue.occurredAt })).rejects.toThrow(/lot .* is on hold/)
    })
    expect(await insert(office(), 'StockMove', liningIssue())).toBe(1)
  })

  it('a hold placed while an issue of its lot waits is seen by the issue (they take turns)', async () => {
    let releaseHold!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    let placed!: () => void
    const isPlaced = new Promise<void>((resolve) => {
      placed = resolve
    })
    const holder = as(office(), (client) =>
      client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "QualityHold" ("id", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "placedAt", "placedById", "number") VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lot', ARRAY[$4::uuid], 'QUALITY_CHECK', now(), $5::uuid, 'HLD-T-' || gen_random_uuid())`,
            randomUUID(),
            A.companyA,
            A.siteA,
            A.liningLot,
            a.actorId,
          )
          placed()
          await held
        },
        { timeout: 20_000 },
      ),
    )
    await isPlaced
    let settled = false
    const issue = insert(office(), 'StockMove', liningIssue()).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    releaseHold()
    await holder
    await expect(issue).rejects.toThrow(/lot .* is on hold/)
    await admin(`UPDATE "QualityHold" SET ${release()} WHERE "tenantId" = $1 AND "subjectIds" @> ARRAY[$2::uuid] AND status = 'ACTIVE'`, [a.tenantId, A.liningLot])
    expect(await insert(office(), 'StockMove', liningIssue())).toBe(1)
  })

  it('a held bundle is not scanned; a held work order takes no scan, no release; a held serial is neither released nor packed', async () => {
    const bundle = String(await value(`SELECT id::text FROM "Bundle" WHERE "tenantId" = $1 AND "workOrderId" = $2 AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`, [a.tenantId, A.wo1]))
    const operation = String(await value(`SELECT "workOrderOperationId"::text FROM "OperationScan" WHERE "tenantId" = $1 AND "bundleId" = $2 LIMIT 1`, [a.tenantId, bundle]))
    const scan = { id: randomUUID(), siteId: A.siteA, workOrderId: A.wo1, workOrderOperationId: operation, bundleId: bundle, kind: 'REPORT', goodQuantity: 1, workerId: A.operator, clientScanId: tag() }
    await rolledBack(office(), async (_exec, ins) => {
      await ins('QualityHold', full(hold('Bundle', [bundle])))
      await expect(ins('OperationScan', { ...scan, scrapQuantity: 0, reworkQuantity: 0, serverTime: new Date().toISOString() })).rejects.toThrow(/bundle .* is on hold/)
    })
    await rolledBack(office(), async (_exec, ins) => {
      await ins('QualityHold', full(hold('WorkOrder', [A.wo1])))
      await expect(ins('OperationScan', { ...scan, scrapQuantity: 0, reworkQuantity: 0, serverTime: new Date().toISOString() })).rejects.toThrow(/work order .* is on hold/)
    })
    const release = (await admin(`SELECT to_jsonb(r) AS row FROM "QualityRelease" r WHERE "tenantId" = $1 AND "workOrderId" = $2 LIMIT 1`, [a.tenantId, A.wo1]))[0]!.row as Record<string, unknown>
    await rolledBack(office(), async (_exec, ins) => {
      await ins('QualityHold', full(hold('WorkOrder', [A.wo1])))
      await expect(ins('QualityRelease', { ...release, id: randomUUID(), number: null })).rejects.toThrow(/work order .* is on hold .*; its garments are not released/)
    })
    const serial = (await admin(`SELECT id::text, "workOrderSizeId"::text AS cell FROM "GarmentSerial" WHERE "tenantId" = $1 AND status = 'RELEASED' AND "shipmentLineId" IS NULL LIMIT 1`, [a.tenantId]))[0]!
    await rolledBack(office(), async (exec, ins) => {
      await ins('QualityHold', full(hold('GarmentSerial', [String(serial.id)])))
      await expect(exec(`UPDATE "GarmentSerial" SET "shipmentLineId" = $1::uuid WHERE id = $2::uuid`, A.sh2Line, serial.id)).rejects.toThrow(/garment serial .* is on hold .*; it is neither released nor packed/)
    })
  })

  it('a held parcel, shipment or work order keeps its shipment from being packed or sent; a line of a held work order is not packed', async () => {
    const packer = floorAs(A.operator)
    for (const [subjectType, subject] of [
      ['Parcel', A.sh2Parcel],
      ['Shipment', A.sh2],
    ] as const) {
      await rolledBack(packer, async (exec) => {
        await exec(
          `INSERT INTO "QualityHold" ("id", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "placedAt", "placedByWorkerId", "number") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY[$5::uuid], 'QUALITY_CHECK', now(), $6::uuid, 'HLD-T-' || gen_random_uuid())`,
          randomUUID(),
          A.companyA,
          A.siteA,
          subjectType,
          subject,
          A.lead,
        )
        await expect(exec(`UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = $1::uuid`, A.sh2)).rejects.toThrow(/shipment .* holds goods on hold .*; it is neither packed nor sent/)
      })
    }
    const line = (await admin(`SELECT to_jsonb(l) AS row FROM "ShipmentLine" l WHERE id = $1`, [A.sh2Line]))[0]!.row as Record<string, unknown>
    await rolledBack(office(), async (_exec, ins) => {
      await ins('QualityHold', full(hold('WorkOrder', [String(line.workOrderId)])))
      await expect(ins('ShipmentLine', { ...line, id: randomUUID() })).rejects.toThrow(/shipment line .* packs goods on hold/)
    })
  })
})

/** A hold row with every column a raw jsonb insert needs. */
function full(row: ReturnType<typeof hold>): Record<string, unknown> {
  return { status: 'ACTIVE', quarantine: 'NOT_NEEDED', notMakerStatement: false, version: 1, createdAt: row.placedAt, updatedAt: row.placedAt, ...row }
}

describe('the rules of a hold', () => {
  it('holds records of its site that it can hold, one kind, each once; the floor places it as the signed-in worker', async () => {
    await expect(insert(office(), 'QualityHold', hold('Shipment', [A.sh1]))).rejects.toThrow(/in a state a hold holds .*what left is the PPE register/)
    await expect(insert(office(), 'QualityHold', hold('Hide', [A.hide2, A.hide2]))).rejects.toThrow(/each named once/)
    await expect(insert(office(), 'QualityHold', hold('Item', [A.lining]))).rejects.toThrow(/a hold holds lots, hides, work orders/)
    await expect(insert(office(), 'QualityHold', hold('Hide', [randomUUID()]))).rejects.toThrow(/in a state a hold holds/)
    await expect(insert(office(), 'QualityHold', hold('Hide', [A.hide2], { quarantine: 'ASKED', quarantineLocationId: A.bin }))).rejects.toThrow(/quarantine is a QUARANTINE location/)
    await expect(insert(floorAs(A.operator), 'QualityHold', hold('Hide', [A.hide2]))).rejects.toThrow(/the floor places the hold of the signed-in worker/)
    const ok = hold('Hide', [A.hide2], { placedById: null, placedByWorkerId: A.operator })
    expect(await insert(floorAs(A.operator), 'QualityHold', ok)).toBe(1)
    await expect(run(office(), `UPDATE "QualityHold" SET "subjectIds" = ARRAY[$1::uuid] WHERE id = $2::uuid`, A.hide1, ok.id)).rejects.toThrow(/what hold .* holds, why, who placed it .* never change/)
    // The floor confirms the move and releases with the PIN; nothing else.
    await expect(run(floorAs(A.operator), `UPDATE "QualityHold" SET "ownerId" = $1::uuid WHERE id = $2::uuid`, a.actorId, ok.id)).rejects.toThrow(/the floor confirms the quarantine move .* nothing else/)
    expect(await run(floorAs(A.operator), `UPDATE "QualityHold" SET quarantine = 'MOVED', "quarantineLocationId" = $1::uuid, "quarantineMovedAt" = now() WHERE id = $2::uuid`, A.quarantine, ok.id)).toBe(1)
    await expect(run(floorAs(A.lead), `UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now(), "releasedByWorkerId" = $1::uuid WHERE id = $2::uuid`, A.lead, ok.id)).rejects.toThrow(/wrong release/)
    expect(await run(floorAs(A.lead), `UPDATE "QualityHold" SET ${release(A.lead)} WHERE id = $1::uuid`, ok.id)).toBe(1)
    await expect(run(office(), `UPDATE "QualityHold" SET note = 'later' WHERE id = $1::uuid`, ok.id)).rejects.toThrow(/a released or closed hold never changes/)
    await expect(admin(`DELETE FROM "QualityHold" WHERE id = $1`, [ok.id])).rejects.toThrow(/released or closed, never deleted/)
  })

  it('held garments are released by someone who made none of them (four eyes); a hold closes only through its NCR', async () => {
    const woHold = hold('WorkOrder', [A.wo1])
    expect(await insert(office(), 'QualityHold', woHold)).toBe(1)
    // The operator cut and scanned WO-0001's garments; the team leader made none.
    await expect(run(floorAs(A.operator), `UPDATE "QualityHold" SET ${release(A.operator)} WHERE id = $1::uuid`, woHold.id)).rejects.toThrow(/made garments of work order .* release of hold/)
    await expect(run(office(), `UPDATE "QualityHold" SET status = 'CLOSED', "closedAt" = now(), "closeNote" = 'scrapped' WHERE id = $1::uuid`, woHold.id)).rejects.toThrow(/wrong closing: .* the NCR that decided it/)
    expect(await run(floorAs(A.lead), `UPDATE "QualityHold" SET ${release(A.lead)} WHERE id = $1::uuid`, woHold.id)).toBe(1)
  })
})

// --- the defect library, the disposition codes, the inspector -------------------------------------------------------

describe('the defect library and the disposition codes', () => {
  it('two levels: a category has no class, a defect has one under a category; a code never changes; the picture is the code’s', async () => {
    const row = (extra: Record<string, unknown>) => ({ id: randomUUID(), code: `T-${tag()}`, labelIt: 'Prova', labelEn: 'Test', ...extra })
    await expect(insert(office(), 'DefectCode', row({ parentId: holds.defectCodeIds['GRAIN-CRACK'], severity: 'MINOR' }))).rejects.toThrow(/which is a defect itself; the library has two levels/)
    await expect(insert(office(), 'DefectCode', row({ severity: 'MINOR' }))).rejects.toThrow(/a defect has its default class .*, a category none/)
    await expect(insert(office(), 'DefectCode', row({ parentId: holds.defectCodeIds['SEAM'] }))).rejects.toThrow(/a defect has its default class/)
    await expect(insert(office(), 'DefectCode', row({ code: 'TWO WORDS' }))).rejects.toThrow(/a code without spaces/)
    await expect(run(office(), `UPDATE "DefectCode" SET code = 'GRAIN-CRACKED' WHERE id = $1::uuid`, holds.defectCodeIds['GRAIN-CRACK'])).rejects.toThrow(/never change/)
    const other = String(await value(`SELECT id::text FROM "StoredFile" WHERE "tenantId" = $1 LIMIT 1`, [a.tenantId]))
    await expect(run(office(), `UPDATE "DefectCode" SET "pictureFileId" = $1::uuid WHERE id = $2::uuid`, other, holds.defectCodeIds['STAIN'])).rejects.toThrow(/a file of the code/)
    // A used code is retired, never deleted (its NCR names it).
    await expect(run(office(), `DELETE FROM "DefectCode" WHERE id = $1::uuid`, holds.defectCodeIds['GRAIN-CRACK'])).rejects.toThrow(/foreign key|violates/)
  })

  it('an inspection defect picked from the library is an active defect with its code; the office assigns the inspector, the floor does not', async () => {
    const inspection = String(await value(`SELECT id::text FROM "Inspection" WHERE "tenantId" = $1 AND status = 'OPEN' LIMIT 1`, [a.tenantId]))
    const workOrder = String(await value(`SELECT "workOrderId"::text FROM "Inspection" WHERE id = $1`, [inspection]))
    const defect = (code: string, defectCodeId: string) => ({ id: randomUUID(), siteId: A.siteA, workOrderId: workOrder, inspectionId: inspection, defectClass: 'MINOR', code, quantity: 1, defectCodeId, zone: 'SLEEVE' })
    const bench = floorAs(A.lead)
    await expect(insert(bench, 'InspectionDefect', defect('SEAM', holds.defectCodeIds['SEAM']!))).rejects.toThrow(/names the category .*; an inspection records a defect of the library/)
    await expect(insert(bench, 'InspectionDefect', defect('STAIN-X', holds.defectCodeIds['STAIN']!))).rejects.toThrow(/its code is STAIN/)
    await rolledBack(office(), async (exec) => {
      await exec(`UPDATE "DefectCode" SET active = false WHERE id = $1::uuid`, holds.defectCodeIds['STAIN'])
      await expect(exec(`INSERT INTO "InspectionDefect" ("id", "siteId", "workOrderId", "inspectionId", "defectClass", "code", "quantity", "defectCodeId") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MINOR', 'STAIN', 1, $5::uuid)`, randomUUID(), A.siteA, workOrder, inspection, holds.defectCodeIds['STAIN'])).rejects.toThrow(/is retired/)
    })
    await rolledBack(bench, async (exec) => {
      expect(await exec(`INSERT INTO "InspectionDefect" ("id", "siteId", "workOrderId", "inspectionId", "defectClass", "code", "quantity", "defectCodeId", "zone") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MINOR', 'STAIN', 1, $5::uuid, 'BACK')`, randomUUID(), A.siteA, workOrder, inspection, holds.defectCodeIds['STAIN'])).toBe(1)
    })
    await expect(run(bench, `UPDATE "Inspection" SET "assignedInspectorWorkerId" = $1::uuid WHERE id = $2::uuid`, A.lead, inspection)).rejects.toThrow(/the office assigns inspection .*; the floor does not/)
    await expect(run(office(), `UPDATE "Inspection" SET "assignedInspectorWorkerId" = $1::uuid, "assignedInspectorId" = $2::uuid WHERE id = $3::uuid`, A.lead, a.actorId, inspection)).rejects.toThrow(/assigned to one inspector/)
    await rolledBack(office(), async (exec) => {
      expect(await exec(`UPDATE "Inspection" SET "assignedInspectorWorkerId" = $1::uuid WHERE id = $2::uuid`, A.lead, inspection)).toBe(1)
    })
  })

  it('a disposition code: use as is moves and opens nothing, scrap posts a scrap move; its outcome never changes', async () => {
    const row = (extra: Record<string, unknown>) => ({ id: randomUUID(), code: `D-${tag()}`, labelIt: 'Prova', labelEn: 'Test', ...extra })
    await expect(insert(office(), 'DispositionCode', row({ outcome: 'USE_AS_IS', stockMoveReason: 'SCRAP' }))).rejects.toThrow(/USE AS IS moves and opens nothing/)
    await expect(insert(office(), 'DispositionCode', row({ outcome: 'SCRAP', stockMoveReason: 'TRANSFER' }))).rejects.toThrow(/SCRAP posts a SCRAP move/)
    await expect(insert(office(), 'DispositionCode', row({ outcome: 'QUARANTINE', stockMoveReason: 'RECEIPT' }))).rejects.toThrow(/moves held stock out by/)
    await expect(run(office(), `UPDATE "DispositionCode" SET outcome = 'REWORK' WHERE id = $1::uuid`, holds.dispositionCodeIds['SCRAP'])).rejects.toThrow(/never change/)
  })
})

// --- nonconformances ------------------------------------------------------------------------------------------------

describe('an NCR from OPEN to CLOSED', () => {
  it('starts OPEN; is contained once its actions are done; decides its whole quantity, never "use as is" when major, approved by another person', async () => {
    const ncr = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-NCR-${tag()}`, title: 'Test', source: 'AUDIT', foundAt: 'AUDIT', foundOn: new Date().toISOString(), quantityAffected: '10', uom: 'PCS', severity: 'MAJOR' }
    await expect(insert(office(), 'Nonconformance', { ...ncr, stage: 'CONTAINED', containedAt: new Date().toISOString() })).rejects.toThrow(/starts OPEN/)
    await expect(insert(office(), 'Nonconformance', { ...ncr, defectCodeId: holds.defectCodeIds['SEAM'] })).rejects.toThrow(/a category or retired/)
    expect(await insert(office(), 'Nonconformance', ncr)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET stage = 'CONTAINED', "containedAt" = now() WHERE id = $1::uuid`, ncr.id)).rejects.toThrow(/contained once its containment actions are done \(0 action/)
    const action = { id: randomUUID(), siteId: A.siteA, ncrId: ncr.id, seq: 1, kind: 'CHECK_WIP' }
    expect(await insert(office(), 'NcrContainmentAction', action)).toBe(1)
    await expect(run(office(), `UPDATE "NcrContainmentAction" SET status = 'DONE', "doneAt" = now() WHERE id = $1::uuid`, action.id)).rejects.toThrow(/done with its evidence/)
    await expect(insert(office(), 'NcrContainmentAction', { ...action, id: randomUUID(), seq: 2, kind: 'HOLD_STOCK', status: 'DONE', doneAt: new Date().toISOString(), evidenceNote: 'held', recordType: 'QualityHold', recordId: holds.holdId })).rejects.toThrow(/not a hold this NCR decides/)
    expect(await run(office(), `UPDATE "NcrContainmentAction" SET status = 'DONE', "doneAt" = now(), "evidenceNote" = 'Checked on the line.' WHERE id = $1::uuid`, action.id)).toBe(1)
    expect(await run(office(), `UPDATE "Nonconformance" SET stage = 'CONTAINED', "containedAt" = now() WHERE id = $1::uuid`, ncr.id)).toBe(1)

    const line = (code: string, quantity: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), siteId: A.siteA, ncrId: ncr.id, seq: Math.floor(Math.random() * 1e6) + 1, dispositionCodeId: holds.dispositionCodeIds[code], quantity, decidedAt: new Date().toISOString(), decidedById: a.actorId, ...extra })
    await expect(insert(office(), 'NcrDispositionLine', line('USE_AS_IS', '1'))).rejects.toThrow(/never used as they are \(QHS-002/)
    await expect(insert(office(), 'NcrDispositionLine', line('SCRAP', '11'))).rejects.toThrow(/has 10.* affected; its decisions would decide 11/)
    const scrap = line('SCRAP', '4', { approvalRequired: true })
    const rework = line('REWORK', '6')
    expect(await insert(office(), 'NcrDispositionLine', scrap)).toBe(1)
    expect(await insert(office(), 'NcrDispositionLine', rework)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET stage = 'DECIDED', "decidedAt" = now() WHERE id = $1::uuid`, ncr.id)).rejects.toThrow(/every decision that needs approval is approved \(1 waiting/)
    await expect(run(office(), `UPDATE "NcrDispositionLine" SET "approvedAt" = now(), "approvedById" = $1::uuid WHERE id = $2::uuid`, a.actorId, scrap.id)).rejects.toThrow(/never by who decided it/)
    expect(await run(office(), `UPDATE "NcrDispositionLine" SET "approvedAt" = now(), "approvedById" = $1::uuid WHERE id = $2::uuid`, randomUUID(), scrap.id)).toBe(1)
    await expect(run(office(), `UPDATE "NcrDispositionLine" SET quantity = 3 WHERE id = $1::uuid`, scrap.id)).rejects.toThrow(/no longer changes/)
    expect(await run(office(), `UPDATE "Nonconformance" SET stage = 'DECIDED', "decidedAt" = now() WHERE id = $1::uuid`, ncr.id)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET title = 'Changed' WHERE id = $1::uuid`, ncr.id)).rejects.toThrow(/DECIDED; its problem is read-only/)
    await expect(insert(office(), 'NcrDispositionLine', line('SCRAP', '1'))).rejects.toThrow(/decisions are added and removed while it is OPEN or CONTAINED/)

    // Carried out: the scrap with a SCRAP move (not another kind), the rework with its rework order.
    const transfer = { ...liningIssue(), reason: 'TRANSFER', toLocationId: A.store, workOrderId: null }
    const scrapMove = { ...liningIssue(), reason: 'SCRAP', workOrderId: null, note: 'Scrapped by the NCR.' }
    expect(await insert(office(), 'StockMove', transfer)).toBe(1)
    expect(await insert(office(), 'StockMove', scrapMove)).toBe(1)
    await expect(run(office(), `UPDATE "NcrDispositionLine" SET "doneAt" = now() WHERE id = $1::uuid`, scrap.id)).rejects.toThrow(/carried out with its SCRAP a stock move/)
    await expect(run(office(), `UPDATE "NcrDispositionLine" SET "doneAt" = now(), "stockMoveId" = $1::uuid WHERE id = $2::uuid`, transfer.id, scrap.id)).rejects.toThrow(/posts a SCRAP move, not TRANSFER/)
    expect(await run(office(), `UPDATE "NcrDispositionLine" SET "doneAt" = now(), "stockMoveId" = $1::uuid WHERE id = $2::uuid`, scrapMove.id, scrap.id)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET stage = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid, "closeSignatureSha256" = $2 WHERE id = $3::uuid`, a.actorId, sha, ncr.id)).rejects.toThrow(/closes once every decision is carried out \(1 waiting/)
    await expect(run(office(), `UPDATE "NcrDispositionLine" SET "doneAt" = now() WHERE id = $1::uuid`, rework.id)).rejects.toThrow(/with its follow-up record \(REWORK_ORDER\)/)
    expect(await run(office(), `UPDATE "NcrDispositionLine" SET "doneAt" = now(), "followUpType" = 'ReworkOrder', "followUpId" = $1::uuid WHERE id = $2::uuid`, randomUUID(), rework.id)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET stage = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid WHERE id = $2::uuid`, a.actorId, ncr.id)).rejects.toThrow(/wrong times/)
    expect(await run(office(), `UPDATE "Nonconformance" SET stage = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid, "closeSignatureSha256" = $2 WHERE id = $3::uuid`, a.actorId, sha, ncr.id)).toBe(1)
    await expect(run(office(), `UPDATE "Nonconformance" SET "closeNote" = 'later' WHERE id = $1::uuid`, ncr.id)).rejects.toThrow(/is CLOSED; it never changes/)
    await expect(insert(office(), 'NcrLink', { id: randomUUID(), siteId: A.siteA, ncrId: ncr.id, recordType: 'Lot', recordId: A.liningLot })).rejects.toThrow(/its links never change/)
    await expect(admin(`DELETE FROM "Nonconformance" WHERE id = $1`, [ncr.id])).rejects.toThrow(/cancelled, never deleted/)
  })

  it('an NCR is not closed while a hold it decides is ACTIVE; the hold closes through the NCR', async () => {
    // SEED-NCR-0002: its last 39.8 ft² go back to the supplier; then it is decided, its hold closed, and it closes.
    const back = { id: randomUUID(), siteId: A.siteA, ncrId: holds.ncrId, seq: 2, dispositionCodeId: holds.dispositionCodeIds['RETURN_TO_SUPPLIER'], quantity: '39.8', decidedAt: new Date().toISOString(), decidedById: a.actorId }
    await rolledBack(office(), async (exec, ins) => {
      await ins('NcrDispositionLine', { ...back, approvalRequired: false, version: 1, createdAt: back.decidedAt, updatedAt: back.decidedAt })
      await exec(`UPDATE "Nonconformance" SET stage = 'DECIDED', "decidedAt" = now() WHERE id = $1::uuid`, holds.ncrId)
      const move = { ...liningIssue(), reason: 'SCRAP', itemId: A.leather, itemColourId: A.leatherBLK, lotId: A.leatherLot, hideId: A.hide2, quantity: '12.0000', uom: 'FT2', baseQuantity: '12.0000', workOrderId: null, note: 'The cracked area.' }
      await ins('StockMove', { ...move, createdAt: move.occurredAt })
      await exec(`UPDATE "NcrDispositionLine" SET "doneAt" = now(), "stockMoveId" = $1::uuid WHERE id = $2::uuid`, move.id, holds.dispositionLineId)
      await exec(`UPDATE "NcrDispositionLine" SET "doneAt" = now(), "followUpType" = 'SupplierClaim', "followUpId" = $1::uuid WHERE id = $2::uuid`, claimId, back.id)
      await expect(exec(`UPDATE "Nonconformance" SET stage = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid, "closeSignatureSha256" = $2 WHERE id = $3::uuid`, a.actorId, sha, holds.ncrId)).rejects.toThrow(/still decides a hold that is ACTIVE/)
    })
    await rolledBack(office(), async (exec) => {
      expect(await exec(`UPDATE "QualityHold" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid, "closeNote" = 'Decided in the NCR: 12 ft² scrapped, the rest back to P2.' WHERE id = $2::uuid`, a.actorId, holds.holdId)).toBe(1)
    })
  })
})

// --- machines and maintenance -------------------------------------------------------------------------------------

describe('an unsafe machine (Owner answer H1)', () => {
  const [sewing, press] = [first('plant:machine:SEED-SEW-L1-01'), key('plant:machine:SEED-CP-01')]

  it('a station marks it unsafe at once: the request and the machine DO_NOT_USE in one transaction, else refused at commit', async () => {
    const request = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, machineId: sewing, unsafe: true, reportedAt: new Date().toISOString(), reportedByWorkerId: A.operator, stationId: key('site:A1:station:SEW-01') }
    await expect(insert(floorAs(A.operator), 'MaintenanceRequest', request)).rejects.toThrow(/the machine is DO_NOT_USE in the same transaction/)
    await expect(insert(floorAs(A.operator), 'MaintenanceRequest', { ...request, unsafe: false, reportedById: a.actorId })).rejects.toThrow(/never as an office user/)
    // Both in one transaction: committed, and the new machine stays DO_NOT_USE.
    const machine = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, assetNumber: `T-${tag()}`, classId: plant.classIds['POST_BED'], statusSince: new Date().toISOString() }
    expect(await insert(office(), 'Machine', machine)).toBe(1)
    await as(floorAs(A.operator), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(insertSql('MaintenanceRequest', { ...request, id: randomUUID(), machineId: machine.id }), JSON.stringify({ ...request, id: randomUUID(), machineId: machine.id }))
        await tx.$executeRawUnsafe(`UPDATE "Machine" SET status = 'DO_NOT_USE', "statusSince" = now(), "statusReason" = 'Guard missing' WHERE id = $1::uuid`, machine.id)
      }),
    )
    expect(await value(`SELECT status::text FROM "Machine" WHERE id = $1`, [machine.id])).toBe('DO_NOT_USE')
    await expect(run(floorAs(A.operator), `UPDATE "Machine" SET status = 'RETIRED', "statusSince" = now() WHERE id = $1::uuid`, sewing)).rejects.toThrow(/never retires it/)
    await expect(run(floorAs(A.operator), `UPDATE "Machine" SET note = 'x' WHERE id = $1::uuid`, sewing)).rejects.toThrow(/the floor changes only the status/)
  })

  it('only a sign-safe frees it: running again, closing its request or handing back its job running wait for it', async () => {
    const lock = plant.requestIds[1]
    await expect(run(floorAs(A.operator), `UPDATE "Machine" SET status = 'RUNNING', "statusSince" = now() WHERE id = $1::uuid`, press)).rejects.toThrow(/locked as unsafe by request .*until a technician signs it safe/)
    await expect(run(office(), `UPDATE "MaintenanceRequest" SET "signedSafeAt" = now(), "signedSafeById" = $1::uuid WHERE id = $2::uuid`, a.actorId, lock)).rejects.toThrow(/what was checked/)
    await expect(run(office(), `UPDATE "MaintenanceRequest" SET "signedSafeAt" = now(), "signedSafeNote" = 'ok' WHERE id = $1::uuid`, plant.requestIds[0])).rejects.toThrow(/signed safe only when it was unsafe/)
    // The job: started on the floor; handed back running is refused while the lock stands.
    const job = plant.jobId
    expect(await run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET status = 'IN_PROGRESS', "startedAt" = now() WHERE id = $1::uuid`, job)).toBe(1)
    const handBack = `status = 'HANDED_BACK', "handedBackAt" = now(), "handedBackByWorkerId" = '${A.lead}', "workDone" = 'Guard refitted, two-hand control tested.', "machineAfter" = 'RUNNING'`
    await expect(run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET ${handBack} WHERE id = $1::uuid`, job)).rejects.toThrow(/no technician signed it safe yet/)
    await expect(run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, job)).rejects.toThrow(/closing, cancelling and planning it are the office/)
    // The technician signs it safe with the PIN (as a worker), then hands it back running and the press runs again.
    await expect(run(floorAs(A.lead), `UPDATE "MaintenanceRequest" SET "signedSafeAt" = now(), "signedSafeById" = $1::uuid, "signedSafeNote" = 'ok' WHERE id = $2::uuid`, a.actorId, lock)).rejects.toThrow(/the floor signs request .* nothing else/)
    expect(await run(floorAs(A.lead), `UPDATE "MaintenanceRequest" SET "signedSafeAt" = now(), "signedSafeByWorkerId" = $1::uuid, "signedSafeNote" = 'Front guard refitted and locked; interlock tested.' WHERE id = $2::uuid`, A.lead, lock)).toBe(1)
    await expect(run(office(), `UPDATE "MaintenanceRequest" SET "signedSafeNote" = 'changed' WHERE id = $1::uuid`, lock)).rejects.toThrow(/written once/)
    expect(await run(floorAs(A.lead), `UPDATE "MaintenanceJob" SET ${handBack} WHERE id = $1::uuid`, job)).toBe(1)
    expect(await run(floorAs(A.lead), `UPDATE "Machine" SET status = 'RUNNING', "statusSince" = now(), "statusReason" = NULL WHERE id = $1::uuid`, press)).toBe(1)
    expect(await run(office(), `UPDATE "MaintenanceJob" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $1::uuid WHERE id = $2::uuid`, a.actorId, job)).toBe(1)
    await expect(run(office(), `UPDATE "MaintenanceJob" SET priority = 'P3' WHERE id = $1::uuid`, job)).rejects.toThrow(/is CLOSED; it never changes/)
  })

  it('a request is triaged once, never closed while it locks its machine; a job starts NEW or PLANNED', async () => {
    const request = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, machineId: sewing, reportedAt: new Date().toISOString(), stationId: key('site:A1:station:SEW-01') }
    expect(await insert(floorAs(A.operator), 'MaintenanceRequest', request)).toBe(1)
    await expect(run(office(), `UPDATE "MaintenanceRequest" SET status = 'ACKNOWLEDGED' WHERE id = $1::uuid`, request.id)).rejects.toThrow(/wrong triage/)
    expect(await run(office(), `UPDATE "MaintenanceRequest" SET status = 'CLOSED', "closedAt" = now(), "closeReason" = 'SOLVED_BY_OPERATOR' WHERE id = $1::uuid`, request.id)).toBe(1)
    await expect(run(office(), `UPDATE "MaintenanceRequest" SET status = 'NEW', "closedAt" = NULL, "closeReason" = NULL WHERE id = $1::uuid`, request.id)).rejects.toThrow(/cannot move from CLOSED to NEW/)
    await expect(insert(office(), 'MaintenanceJob', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-MJ-${tag()}`, machineId: sewing, type: 'CORRECTIVE', source: 'MANUAL', problem: 'x', status: 'IN_PROGRESS', startedAt: new Date().toISOString() })).rejects.toThrow(/starts NEW or PLANNED/)
  })
})

// --- shipping ---------------------------------------------------------------------------------------------------------

describe('DDTs for other reasons, the freight and the transport evidence', () => {
  /** A DDT of company A's 2026 series for a source record, everything else as printed. */
  const ddt = async (extra: Record<string, unknown>) => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    partyId: A.P1,
    numberSeriesId: String(await value(`SELECT "numberSeriesId"::text FROM "Ddt" WHERE id = $1`, [holds.repairDdtId])),
    number: `T-${tag()}`,
    documentDate: '2026-11-28',
    reason: 'REPAIR',
    transportBy: 'SENDER',
    startAt: new Date().toISOString(),
    appearance: 'Una scatola',
    packages: 1,
    grossWeightKg: '1.0000',
    sender: { name: 'Sender' },
    recipient: { name: 'Recipient' },
    lines: [{ seq: 1, description: 'Goods', quantity: '1', uom: 'PCS' }],
    issuedAt: new Date().toISOString(),
    ...extra,
  })

  it('a DDT names a shipment or a source, exactly one; each source gives its own reasons, of its company, site and party, in a state its goods leave in', async () => {
    const seededRepair = String(await value(`SELECT id::text FROM "RepairOrder" WHERE number = 'SEED-REP-0001' AND "tenantId" = $1`, [a.tenantId]))
    await expect(insert(office(), 'Ddt', await ddt({}))).rejects.toThrow(/carries the goods of a shipment or of another source record .*exactly one/)
    await expect(insert(office(), 'Ddt', await ddt({ shipmentId: A.sh1, sourceType: 'RepairOrder', sourceId: seededRepair }))).rejects.toThrow(/exactly one/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'Invoice', sourceId: seededRepair }))).rejects.toThrow(/a DDT without a shipment carries/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'RepairOrder', sourceId: seededRepair, reason: 'SALE' }))).rejects.toThrow(/gives the reason SALE/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'RepairOrder', sourceId: seededRepair, partyId: A.P2 }))).rejects.toThrow(/is of the company, site and party of its RepairOrder/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'RepairOrder', sourceId: randomUUID() }))).rejects.toThrow(/not a record of its tenant/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'SupplierClaim', sourceId: claimId, partyId: A.P2, reason: 'RETURN' }))).rejects.toThrow(/supplier claim .* is DRAFT; its goods go back once it is SENT or ACCEPTED/)
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'SubcontractOrder', sourceId: subcontractOrderId, partyId: A.P2, reason: 'WORK_ON_ACCOUNT' }))).rejects.toThrow(/subcontract order .* is DRAFT/)
    const waiting = String(await value(`SELECT id::text FROM "ReturnAuthorisation" WHERE number = 'SEED-RMA-0001' AND "tenantId" = $1`, [a.tenantId]))
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'ReturnAuthorisation', sourceId: waiting, reason: 'RETURN' }))).rejects.toThrow(/its goods are sent back once they arrived/)
    // The received jacket of SEED-REP-0001 goes back unrepaired (OTHER fits any source, in words); W1's rules still hold.
    await expect(insert(office(), 'Ddt', await ddt({ sourceType: 'RepairOrder', sourceId: seededRepair, reason: 'OTHER' }))).rejects.toThrow(/says its reason for the transport in words/)
    await rolledBack(office(), async (_exec, ins) => {
      const row = await ddt({ sourceType: 'RepairOrder', sourceId: seededRepair, reason: 'RETURN_FROM_WORK' })
      expect(await ins('Ddt', row)).toBe(1)
    })
    await expect(run(office(), `UPDATE "Ddt" SET remarks = 'x' WHERE id = $1::uuid`, holds.repairDdtId)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "Ddt" SET remarks = 'x' WHERE id = $1`, [holds.repairDdtId])).rejects.toThrow(/append-only/)
  })

  it('the freight charge from 0 changes after the goods left; the transport evidence only once they left, COMPLETE with when and who', async () => {
    await expect(run(office(), `UPDATE "Shipment" SET "freightCharge" = -1 WHERE id = $1::uuid`, A.sh2)).rejects.toThrow(/0 or more/)
    await expect(run(office(), `UPDATE "Shipment" SET "transportEvidence" = 'AWAITED' WHERE id = $1::uuid`, A.sh2)).rejects.toThrow(/evidence is kept once the goods left/)
    expect(await run(office(), `UPDATE "Shipment" SET "freightCharge" = 1200, "transportEvidence" = 'AWAITED' WHERE id = $1::uuid`, A.sh1)).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET "transportEvidence" = 'COMPLETE' WHERE id = $1::uuid`, A.sh1)).rejects.toThrow(/COMPLETE exactly with when and who checked it/)
    expect(await run(office(), `UPDATE "Shipment" SET "transportEvidence" = 'COMPLETE', "transportEvidenceAt" = now(), "transportEvidenceById" = $1::uuid, "transportEvidenceNote" = 'CMR and POD on file.' WHERE id = $2::uuid`, a.actorId, A.sh1)).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET "carrierName" = 'Other' WHERE id = $1::uuid`, A.sh1)).rejects.toThrow(/left; only its delivery or return and its internal note change \(and, W2a, the freight charged and its transport evidence\)/)
    await expect(run(office(), `UPDATE "ShippingSettings" SET "freightRule" = 'NONE' WHERE id = $1::uuid`, A.siteA)).rejects.toThrow(/NONE without amounts/)
    await expect(run(office(), `UPDATE "ShippingSettings" SET "freightRule" = 'PER_PARCEL', "freightAmount" = NULL WHERE id = $1::uuid`, A.siteA)).rejects.toThrow(/with its amount from 0/)
    expect(await run(office(), `UPDATE "ShippingSettings" SET "freightRule" = 'PER_PARCEL', "freightAmount" = 500 WHERE id = $1::uuid`, A.siteA)).toBe(1)
  })

  it('an NCR opens its PPE register entry (source Nonconformance)', async () => {
    const style = String(await value(`SELECT "styleId"::text FROM "Nonconformance" WHERE id = $1`, [holds.openNcrId]))
    const entry = { id: randomUUID(), companyId: A.companyA, reference: `T-REG-${tag()}`, kind: 'NON_CONFORMITY', styleId: style, reportedAt: new Date().toISOString(), description: 'A nonconformity that may present a risk.', sourceType: 'Nonconformance', sourceId: holds.openNcrId }
    expect(await insert(office(), 'PpeRegisterEntry', entry)).toBe(1)
    await expect(insert(office(), 'PpeRegisterEntry', { ...entry, id: randomUUID(), reference: `T-REG-${tag()}`, sourceType: 'Hold' })).rejects.toThrow(/names its source as a known record type/)
  })
})
