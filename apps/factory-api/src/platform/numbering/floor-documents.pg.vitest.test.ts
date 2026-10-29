import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { DocumentKind } from '@nexus/factory-domain/numbering/kinds'
import { seed as seedCore, type CoreSeed } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedFloorAuth } from '../../../../../packages/factory-db/seed/floor-auth'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { callerFor, command, type CommandTools } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { numberReceipt } from '../../modules/inventory/receipts/numbers'
import { systemContext } from '../outbox/system'
import { allocateNumber, assertNumberUniqueInTenant, type IssuedNumber } from './allocate'

/**
 * Floor-safe document numbers on the local stack (a throwaway PostgreSQL 17 database built from the migrations, the
 * runtime login through the scoped clients, as the API runs): a floor tablet's command numbers goods receipts, lots,
 * final inspections and releases of its own site's company from the office's own gapless series (allocateNumber), and
 * nothing else. The walls are proved twice: the API refuses in words, and the database holds them for the floor role
 * itself (the policies of ownership/numbering.json `onlyValues`; the …_numbering_floor_documents_guards triggers).
 *
 * Seeds: _core, auth, floor-auth and numbering of two tenants (A and B). Tenant A: company A with plant A1 and its
 * tablet, company B with plant B1 and its tablet; each company's series of the numbering seed (company A's INSPECTION
 * series issued INS-A-2026-0001). Every name and number is made up.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let tabletA1: string
let tabletB1: string
let workerA1: string
let siteA1: string
let siteB1: string
let companyA: string
let companyB: string

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const all: Grant = { permissions: ['numbering.view', 'numbering.manage'], companies: 'all', sites: 'all', parties: 'all' }
const floorWork: Grant = { permissions: ['floor.work'], companies: 'all', sites: 'all', parties: 'all' }

const office = (seed: CoreSeed = a): RequestContext => ({ audience: 'office', tenantId: seed.tenantId, actorId: seed.actorId, grants: [all], requestId: newId() })
const floor = (deviceId = tabletA1, siteId = siteA1, seed: CoreSeed = a): RequestContext =>
  ({ audience: 'floor', tenantId: seed.tenantId, actorId: workerA1, siteId, deviceId, grants: [floorWork], requestId: newId() }) as RequestContext

/** One command in the context, with a key (floor writes need one) and an audit row. */
async function run<T>(context: RequestContext, work: (tools: CommandTools) => Promise<T>): Promise<T> {
  const { result } = await command(callerFor(database, context), { name: 'test.numbering', idempotencyKey: newId(), input: { at: newId() } }, async (tools) => {
    const out = await work(tools)
    tools.audit({ recordType: 'Test', recordId: newId(), after: { ok: true } })
    return out
  })
  return result
}

/** A number of the company's series of a kind, in one command of the context. */
const take = (context: RequestContext, kind: DocumentKind, companyId = companyA, more: { date?: string; code?: string; hold?: () => Promise<void> } = {}): Promise<IssuedNumber> =>
  run(context, async (tools) => {
    await more.hold?.()
    return allocateNumber(tools, { companyId, kind, ...(more.code ? { code: more.code } : {}) }, { type: 'Test', id: newId(), ...(more.date ? { date: more.date } : {}) })
  })

/** SQL as the floor role itself (a tablet of plant A1, or another site), through the scoped client: the database's own walls. */
const asFloor = <T = Record<string, unknown>>(sql: string, values: unknown[] = [], siteId = siteA1, seed: CoreSeed = a) =>
  database.withScope({ audience: 'floor', tenantId: seed.tenantId, actorId: workerA1, siteId }, (client) => client.$queryRawUnsafe<T[]>(sql, ...values))
const execFloor = (sql: string, values: unknown[] = [], siteId = siteA1) =>
  database.withScope({ audience: 'floor', tenantId: a.tenantId, actorId: workerA1, siteId }, (client) => client.$executeRawUnsafe(sql, ...values))

const seriesOf = async (companyId: string, kind: string, scopeKey = '2026', code = 'MAIN') =>
  (await admin<{ id: string; nextValue: number; fiscal: boolean; createdById: string | null }>(
    'SELECT id::text AS id, "nextValue", fiscal, "createdById"::text AS "createdById" FROM "NumberSeries" WHERE "companyId" = $1 AND kind = $2::"NumberKind" AND code = $3 AND "scopeKey" = $4',
    [companyId, kind, code, scopeKey],
  ))[0]!
const ledger = (seriesId: string) =>
  admin<{ value: number; formatted: string; allocatedById: string }>('SELECT value, formatted, "allocatedById"::text AS "allocatedById" FROM "NumberAllocation" WHERE "seriesId" = $1 ORDER BY value', [seriesId])

/** Lets the first `count` callers through only together: they then queue on the series lock at the same moment. */
function together(count: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return () => {
    arrived++
    if (arrived === count) release()
    return arrived <= count ? gate : Promise.resolve()
  }
}

beforeAll(async () => {
  db = await migratedDatabase('floor_documents')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  a = await seedCore({ db: database, namespace: 'fdoc-a' })
  b = await seedCore({ db: database, namespace: 'fdoc-b' })
  for (const namespace of ['fdoc-a', 'fdoc-b']) await seedAuth({ db: database, namespace })
  const floorA = await seedFloorAuth({ db: database, namespace: 'fdoc-a' })
  await seedFloorAuth({ db: database, namespace: 'fdoc-b' })
  for (const namespace of ['fdoc-a', 'fdoc-b']) await seedNumbering({ db: database, namespace })
  ;[tabletA1, tabletB1] = floorA.deviceIds as [string, string]
  workerA1 = floorA.workerIds[0]!
  siteA1 = a.sites.find((site) => site.code === 'A1')!.id
  siteB1 = a.sites.find((site) => site.code === 'B1')!.id
  companyA = a.sites.find((site) => site.code === 'A1')!.companyId
  companyB = a.sites.find((site) => site.code === 'B1')!.companyId
}, 60_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

describe('a tablet numbers goods receipts, lots, inspections and releases', () => {
  it("takes them from its company's own series, between the office's numbers, with no gap; the ledger names the tablet, never the worker", async () => {
    const series = await seriesOf(companyA, 'GOODS_RECEIPT')
    const byOffice = await take(office(), 'GOODS_RECEIPT')
    const byTablet = await take(floor(), 'GOODS_RECEIPT')
    const byWorker = await take(systemContext(a.tenantId, newId()), 'GOODS_RECEIPT')
    expect([byOffice.value, byTablet.value, byWorker.value]).toEqual([series.nextValue, series.nextValue + 1, series.nextValue + 2])
    expect(byTablet.formatted).toMatch(/^GR-\d{4}-\d{4}$/)
    const rows = await ledger(series.id)
    expect(rows.map((row) => row.value)).toEqual([series.nextValue, series.nextValue + 1, series.nextValue + 2])
    expect(rows[1]!.allocatedById).toBe(tabletA1)
    expect(rows.map((row) => row.allocatedById)).not.toContain(workerA1)
    expect((await seriesOf(companyA, 'GOODS_RECEIPT')).nextValue).toBe(series.nextValue + 3)

    const lot = await take(floor(), 'LOT')
    expect(lot.formatted).toMatch(/^LA-\d{6}$/)
    const inspection = await take(floor(), 'INSPECTION')
    // The seed issued INS-A-2026-0001.
    expect(inspection.formatted).toBe('INS-A-2026-0002')
    const release = await take(floor(), 'RELEASE')
    expect(release.formatted).toBe('REL-A-2026-0001')
    // Plant B1's tablet numbers company B's.
    expect((await take(floor(tabletB1, siteB1), 'INSPECTION', companyB)).formatted).toBe('INS-B-2026-0001')
  })

  it('opens a new year: the first number of 2027 makes that year of the office series, from 1, made by the tablet', async () => {
    const number = await take(floor(), 'GOODS_RECEIPT', companyA, { date: '2027-01-04' })
    expect(number).toMatchObject({ scopeKey: '2027', value: 1, formatted: 'GR-2027-0001' })
    const year = await seriesOf(companyA, 'GOODS_RECEIPT', '2027')
    expect(year).toMatchObject({ nextValue: 2, fiscal: false, createdById: tabletA1 })
    // The office goes on in the same row.
    expect((await take(office(), 'GOODS_RECEIPT', companyA, { date: '2027-01-05' })).formatted).toBe('GR-2027-0002')
  })

  it('gives concurrent commands of the office and two tablets distinct numbers, one after the other', async () => {
    const before = (await seriesOf(companyA, 'RELEASE')).nextValue
    const hold = together(10)
    const contexts = Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? office() : floor()))
    const issued = await Promise.all(contexts.map((context) => take(context, 'RELEASE', companyA, { hold })))
    const values = issued.map((entry) => entry.value).sort((x, y) => x - y)
    expect(values).toEqual(Array.from({ length: 24 }, (_, index) => before + index))
    expect(new Set(issued.map((entry) => entry.formatted)).size).toBe(24)
    expect((await seriesOf(companyA, 'RELEASE')).nextValue).toBe(before + 24)
  })

  it('numbers a goods receipt and its lots in a floor command (the seam for floor receiving, B-W1-33), the office alike', async () => {
    const receiptSeries = await seriesOf(companyA, 'GOODS_RECEIPT')
    const lotsBefore = (await seriesOf(companyA, 'LOT', 'ALL')).nextValue
    const lotIds = [newId(), newId()]
    const onFloor = await run(floor(), (tools) => numberReceipt(tools, { companyId: companyA, receiptId: newId(), date: '2026-10-29', lotIds }))
    expect(onFloor.number).toBe(`GR-2026-${String(receiptSeries.nextValue).padStart(4, '0')}`)
    expect(onFloor.lots).toEqual(lotIds.map((lotId, index) => ({ lotId, code: `LA-${String(lotsBefore + index).padStart(6, '0')}` })))
    const inOffice = await run(office(), (tools) => numberReceipt(tools, { companyId: companyA, receiptId: newId(), date: '2026-10-29', lotIds: [newId()] }))
    expect(inOffice.lots[0]!.code).toBe(`LA-${String(lotsBefore + 2).padStart(6, '0')}`)
    // Another site's company: refused, nothing taken.
    await expect(run(floor(), (tools) => numberReceipt(tools, { companyId: companyB, receiptId: newId(), date: '2026-10-29', lotIds: [] }))).rejects.toThrow(ForbiddenError)
    expect((await seriesOf(companyA, 'LOT', 'ALL')).nextValue).toBe(lotsBefore + 3)
  })
})

describe('the walls', () => {
  it('a tablet never takes a fiscal number, nor any other office kind: refused in words, nothing taken', async () => {
    const invoices = await seriesOf(companyA, 'INVOICE')
    for (const kind of ['INVOICE', 'DDT', 'CREDIT_NOTE', 'DEPOSIT_INVOICE', 'WORK_ORDER', 'PURCHASE_ORDER'] as const) {
      await expect(take(floor(), kind)).rejects.toThrow(ForbiddenError)
    }
    await expect(take(floor(), 'INVOICE')).rejects.toThrow('A tablet takes no invoice numbers: they are issued in the office.')
    expect(await seriesOf(companyA, 'INVOICE')).toEqual(invoices)
  })

  it("the database hides every other kind's series and numbers from the floor role: it cannot read, lock, move or add one", async () => {
    const invoices = await seriesOf(companyA, 'INVOICE')
    const ddts = await seriesOf(companyA, 'DDT')
    // Reads: only the floor's kinds, of its tenant.
    const kinds = await asFloor<{ kind: string }>('SELECT DISTINCT kind::text AS kind FROM "NumberSeries" ORDER BY 1')
    expect(kinds.map((row) => row.kind)).toEqual(['GOODS_RECEIPT', 'INSPECTION', 'LOT', 'RELEASE'])
    expect(await asFloor('SELECT 1 FROM "NumberAllocation" WHERE kind = \'INVOICE\'')).toEqual([])
    expect(await asFloor('SELECT 1 FROM "NumberSeries" WHERE id = $1::uuid FOR UPDATE', [invoices.id])).toEqual([])
    // Writes: nothing moves, nothing is added.
    expect(await execFloor('UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1 WHERE id = ANY($1::uuid[])', [[invoices.id, ddts.id]])).toBe(0)
    await expect(
      execFloor(
        `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'INVOICE', $4, 'FT-T-1', '2026-10-29', 'Invoice', $5::uuid, now(), $6::uuid, 'test')`,
        [newId(), companyA, invoices.id, invoices.nextValue, newId(), tabletA1],
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      execFloor(
        `INSERT INTO "NumberSeries" (id, "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1::uuid, $2::uuid, 'INVOICE', 'FLOOR', '2027', 'YEARLY', 'FT-{YYYY}-{N:5}', true)`,
        [newId(), companyA],
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await seriesOf(companyA, 'INVOICE')).toEqual(invoices)
    // Another tenant's series: none seen.
    expect(await asFloor('SELECT 1 FROM "NumberSeries" WHERE "tenantId" = $1::uuid', [b.tenantId])).toEqual([])
  })

  it('and, behind the policies, refuses a fiscal series of a floor kind to a tablet (the guards, should a series ever be flagged so)', async () => {
    // An admin's fiscal goods-receipt series (made up: no such series in the app).
    const id = newId()
    await admin(
      `INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'GOODS_RECEIPT', 'FISCAL', '2026', 'YEARLY', 'GF-{YYYY}-{N:4}', true)`,
      [id, a.tenantId, companyA],
    )
    await expect(take(floor(), 'GOODS_RECEIPT', companyA, { code: 'FISCAL' })).rejects.toThrow(/series .* is not one a tablet numbers from/)
    expect((await seriesOf(companyA, 'GOODS_RECEIPT', '2026', 'FISCAL')).nextValue).toBe(1)
    expect(await ledger(id)).toEqual([])
    await expect(execFloor('UPDATE "NumberSeries" SET "updatedAt" = now() WHERE id = $1::uuid', [id])).rejects.toThrow(/never from a fiscal series; a fiscal GOODS_RECEIPT series is the office's/)
    // The office numbers from it.
    expect((await take(office(), 'GOODS_RECEIPT', companyA, { code: 'FISCAL' })).formatted).toBe('GF-2026-0001')
    await admin('UPDATE "NumberSeries" SET status = \'CLOSED\' WHERE id = $1', [id])
  })

  it("a tablet numbers its own site's company only, of its own tenant: refused in words, and by the database", async () => {
    const seriesB = await seriesOf(companyB, 'LOT', 'ALL')
    await expect(take(floor(), 'LOT', companyB)).rejects.toThrow("A tablet numbers the documents of its own site's company only.")
    await expect(take(floor(), 'LOT', b.companies[0]!.id)).rejects.toThrow(ForbiddenError)
    await expect(take(floor(tabletB1, siteB1), 'LOT', companyA)).rejects.toThrow(ForbiddenError)
    expect(await seriesOf(companyB, 'LOT', 'ALL')).toEqual(seriesB)
    // The database: a tablet of plant A1 neither moves nor adds to company B's series.
    await expect(
      execFloor(
        `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'LOT', $4, 'LB-T-1', '2026-10-29', 'Lot', $5::uuid, now(), $6::uuid, 'test')`,
        [newId(), companyB, seriesB.id, seriesB.nextValue, newId(), tabletA1],
      ),
    ).rejects.toThrow(/its own site's company only/)
    await expect(execFloor('UPDATE "NumberSeries" SET "updatedAt" = now() WHERE id = $1::uuid', [seriesB.id])).rejects.toThrow(/its own site's company only/)
    expect(await seriesOf(companyB, 'LOT', 'ALL')).toEqual(seriesB)
  })

  it('the database keeps a tablet to moving a counter one number at a time, past a number it recorded, and to a new year of a series', async () => {
    const series = await seriesOf(companyA, 'INSPECTION')
    await expect(execFloor('UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 2 WHERE id = $1::uuid', [series.id])).rejects.toThrow(/one number at a time/)
    await expect(execFloor('UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1 WHERE id = $1::uuid', [series.id])).rejects.toThrow(/only past a number it recorded/)
    await expect(execFloor('UPDATE "NumberSeries" SET "createdById" = $2::uuid WHERE id = $1::uuid', [series.id, tabletA1])).rejects.toThrow(/moves only its counter/)
    await expect(execFloor('UPDATE "NumberSeries" SET status = \'CLOSED\' WHERE id = $1::uuid', [series.id])).rejects.toThrow(/moves only its counter/)
    const insert = (pattern: string, reset: string, scopeKey: string, startValue = 1) =>
      execFloor(
        `INSERT INTO "NumberSeries" (id, "companyId", kind, code, "scopeKey", reset, pattern, fiscal, "startValue", "nextValue") VALUES ($1::uuid, $2::uuid, 'INSPECTION', 'MAIN', $3, $4::"NumberReset", $5, false, $6, $6)`,
        [newId(), companyA, scopeKey, reset, pattern, startValue],
      )
    await expect(insert('MINE-{YYYY}-{N:4}', 'YEARLY', '2030')).rejects.toThrow(/only to a series the office set up/)
    await expect(insert('INS-A-{N:4}', 'NEVER', 'ALL')).rejects.toThrow(/only a new year of a yearly series/)
    await expect(insert('INS-A-{YYYY}-{N:4}', 'YEARLY', '2031', 40)).rejects.toThrow(/only a new year of a yearly series/)
    // A number ahead of the counter.
    await expect(
      execFloor(
        `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'INSPECTION', $4, 'INS-A-T-AHEAD', '2026-10-29', 'Inspection', $5::uuid, now(), $6::uuid, 'test')`,
        [newId(), companyA, series.id, series.nextValue + 5, newId(), tabletA1],
      ),
    ).rejects.toThrow(/never one ahead of it/)
    expect(await seriesOf(companyA, 'INSPECTION')).toEqual(series)
  })

  it("a number printed by another company's series is refused in words before the record's unique key (two series with one prefix)", async () => {
    // Made-up series of one pattern for both companies, the office's mistake.
    for (const companyId of [companyA, companyB]) {
      await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INSPECTION', 'CLASH', 'ALL', 'NEVER', 'CL-{N:4}', false)`, [newId(), a.tenantId, companyId])
    }
    const first = await run(floor(tabletB1, siteB1), async (tools) => {
      const issued = await allocateNumber(tools, { companyId: companyB, kind: 'INSPECTION', code: 'CLASH' }, { type: 'Inspection', id: newId() })
      await assertNumberUniqueInTenant(tools, issued)
      return issued.formatted
    })
    expect(first).toBe('CL-0001')
    const clash = run(floor(), async (tools) => {
      const issued = await allocateNumber(tools, { companyId: companyA, kind: 'INSPECTION', code: 'CLASH' }, { type: 'Inspection', id: newId() })
      await assertNumberUniqueInTenant(tools, issued)
      return issued.formatted
    })
    await expect(clash).rejects.toThrow(InvalidStateError)
    await expect(clash).rejects.toThrow("The inspection number CL-0001 was issued by another series of this factory already: give each company's inspection series its own prefix (an admin, under numbering).")
    // The refused command took nothing.
    expect((await seriesOf(companyA, 'INSPECTION', 'ALL', 'CLASH')).nextValue).toBe(1)
  })
})
