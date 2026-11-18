import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedSamples, type SamplesSeed } from '../seed/samples'
import { seed as seedTwoBrands } from '../seed/two-brands' // B-PR-39
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { readMigrations } from './policies'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { MIGRATIONS_DIR } from './tools'

/**
 * B-PR-01 (production plan, schema wave 1/5; the brand wall: "One brand must not be able to see anything related to any
 * other brand"): one customer per work order, on a database built from the migrations and seeded, through the real login
 * and the scoped client. The PW-00 fixture at the database: customer A (P1, the seeds' brand) and customer B (P3), each with
 * an order line of the same style; a work order of each; a mixed one made before the rule (A and B cells, planted with the
 * triggers off, as the copy step leaves one).
 *   - a work order is made with its customer (every kind but SAMPLE names one); a cell of B on A's work order is refused;
 *   - a work order's customer never changes, for any login;
 *   - a mixed draft's cells only LEAVE it (removed, or lowered by a split into a work order of one customer), never join or
 *     change; once the cells left are of one customer it takes that customer, once (R-33, the lead's pick);
 *   - a SAMPLE of a customer's round is that customer's; one of a round for no customer takes cells of none, or is the
 *     customer of its order lines;
 *   - the copy step (…_production_brand_wall_copy) fills the work orders made before the rule from their cells and keeps a
 *     mixed one without a customer.
 * The refusals are check_violation (SQLSTATE 23514); their words name no customer.
 */

const NS = 'pr01-wall'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let p: ProductionSeed
let s: SamplesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = key('party:P1')
const B = key('party:P3')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
/** The same copy with every trigger off (set-up only: a row made before the rule, or another customer's order). */
async function plant(table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(copyText(table), [JSON.stringify(changes), id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const partyOf = async (workOrderId: string) => (await admin(`SELECT "partyId"::text AS party FROM "WorkOrder" WHERE id = $1`, [workOrderId]))[0]!.party as string | null
const tag = (): string => `T-WO-${randomUUID().slice(0, 8)}`

/** The fixture: A's draft (the seeds' SEED-WO-0002) and its cell, B's order line, B's draft and cell. */
const F = { cellA: '', lineA: '', orderB: '', lineB: '', draftB: '', cellB: '' }

beforeAll(async () => {
  db = await migratedDatabase('prodbrandwall')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  p = await seedProduction({ db: factory, namespace: NS })
  s = await seedSamples({ db: factory, namespace: NS })
  const [cell] = await admin(`SELECT id::text AS id, "salesOrderLineId"::text AS line FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [p.draftWorkOrderId])
  F.cellA = cell!.id as string
  F.lineA = cell!.line as string
  // B's order: A's order and line copied to customer B (the sales rules are not under test).
  F.orderB = randomUUID()
  F.lineB = randomUUID()
  await plant('SalesOrder', p.salesOrderId, { id: F.orderB, number: `T-SO-${F.orderB.slice(0, 8)}`, partyId: B, customerSeq: null })
  await plant('SalesOrderLine', F.lineA, { id: F.lineB, orderId: F.orderB, partyId: B })
  // B's own draft, made as the office makes one: with its customer, then a cell of B's line.
  F.draftB = randomUUID()
  F.cellB = randomUUID()
  expect(await copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id: F.draftB, number: tag(), partyId: B })).toBe(1)
  expect(await copyRow(office(), 'WorkOrderSize', F.cellA, { id: F.cellB, workOrderId: F.draftB, salesOrderLineId: F.lineB, partyId: B })).toBe(1)
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
})

describe('one customer per work order (B-PR-01, PW-00 at the database)', () => {
  it('seeds every work order with its customer: none mixes customers', async () => {
    const rows = await admin(
      `SELECT w.number, w."partyId"::text AS party, count(DISTINCT c."partyId")::int AS customers FROM "WorkOrder" w LEFT JOIN "WorkOrderSize" c ON c."workOrderId" = w.id
        WHERE w."tenantId" = $1 AND w.number LIKE 'SEED-WO-%' GROUP BY w.id ORDER BY w.number`,
      [a.tenantId],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row, String(row.number)).toMatchObject({ party: A, customers: 1 })
  })

  it('makes a work order with its customer: every kind but SAMPLE names one', async () => {
    for (const kind of ['SIZE_GRID', 'MADE_TO_MEASURE', 'REPAIR']) {
      await expect(copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id: randomUUID(), number: tag(), kind, partyId: null })).rejects.toThrow(/is made for the one customer of its order lines \(one customer per work order\)/)
    }
    const made = randomUUID()
    expect(await copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id: made, number: tag(), partyId: A })).toBe(1)
    expect(await partyOf(made)).toBe(A)
  })

  it("refuses a cell of B on A's work order, and of A on B's (the words name no customer)", async () => {
    const words = /makes an order line of another customer than its work order's \(one customer per work order\)/
    const refusal = await copyRow(office(), 'WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: p.draftWorkOrderId, size: '54' }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refusal).toMatch(words)
    // Neutral words: no customer id, code or name.
    const [names] = await admin(`SELECT string_agg(code || '|' || "legalName" || '|' || coalesce("tradeName", ''), '|') AS words FROM "Party" WHERE id IN ($1, $2)`, [A, B])
    for (const word of [A, B, ...String(names!.words).split('|').filter((entry) => entry.length > 0)]) expect(refusal).not.toContain(word)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: F.draftB, size: '54' })).rejects.toThrow(words)
    // A cell moved onto B's line in place is refused too, and A's own line on A's work order still joins.
    await expect(update(office(), 'WorkOrderSize', F.cellA, `"salesOrderLineId" = $2::uuid, "partyId" = $3::uuid`, F.lineB, B)).rejects.toThrow(words)
    const own = randomUUID()
    expect(await copyRow(office(), 'WorkOrderSize', F.cellA, { id: own, size: '54' })).toBe(1)
    await run(office(), `DELETE FROM "WorkOrderSize" WHERE id = $1::uuid`, own)
  })

  it("never changes a work order's customer, for any login", async () => {
    await expect(update(office(), 'WorkOrder', p.draftWorkOrderId, `"partyId" = $2::uuid`, B)).rejects.toThrow(/the customer of work order .* never changes \(one customer per work order\)/)
    await expect(update(office(), 'WorkOrder', p.draftWorkOrderId, `"partyId" = NULL`)).rejects.toThrow(/never changes/)
    // A released one: frozen anyway (W1's guard speaks first), and the owner login is refused too.
    await expect(update(office(), 'WorkOrder', p.workOrderId, `"partyId" = $2::uuid`, B)).rejects.toThrow(/never change/)
    await expect(admin(`UPDATE "WorkOrder" SET "partyId" = $2 WHERE id = $1`, [p.draftWorkOrderId, B])).rejects.toThrow(/never changes/)
    expect(await partyOf(p.draftWorkOrderId)).toBe(A)
    expect(await partyOf(p.workOrderId)).toBe(A)
  })

  it('lets the cells of a mixed draft made before the rule only leave it, then it takes the one customer left, once (the split)', async () => {
    const mixed = randomUUID()
    const mixedA = randomUUID()
    const mixedB = randomUUID()
    await plant('WorkOrder', p.draftWorkOrderId, { id: mixed, number: tag(), partyId: null })
    await plant('WorkOrderSize', F.cellA, { id: mixedA, workOrderId: mixed, quantity: 2 })
    await plant('WorkOrderSize', F.cellB, { id: mixedB, workOrderId: mixed, size: '54', quantity: 3 })
    const joins = /mixes customers \(made before the one-customer rule\): its cells only leave it .* it takes no new or changed cell/
    // Nothing joins it or changes on it: a new cell (of either customer), more pieces, another size, another line.
    await expect(copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: mixed, size: '50' })).rejects.toThrow(joins)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: mixed, size: '50' })).rejects.toThrow(joins)
    await expect(update(office(), 'WorkOrderSize', mixedA, 'quantity = 3')).rejects.toThrow(joins)
    await expect(update(office(), 'WorkOrderSize', mixedB, `size = '50'`)).rejects.toThrow(joins)
    // It takes no customer while it still mixes them.
    const notYet = /mixes customers \(made before the one-customer rule\): it takes a customer only once every cell left on it is of that customer/
    await expect(update(office(), 'WorkOrder', mixed, `"partyId" = $2::uuid`, A)).rejects.toThrow(notYet)

    // The split of B's cell, as the split command writes it: B's new draft (split from it, of B) with the moved pieces,
    // the mixed one's cell lowered, then the rest moved and the cell removed.
    const child = randomUUID()
    expect(await copyRow(office(), 'WorkOrder', mixed, { id: child, number: tag(), splitFromId: mixed, partyId: B })).toBe(1)
    const childB = randomUUID()
    expect(await copyRow(office(), 'WorkOrderSize', mixedB, { id: childB, workOrderId: child, quantity: 2 })).toBe(1)
    expect(await update(office(), 'WorkOrderSize', mixedB, 'quantity = 1, version = version + 1')).toBe(1)
    expect(await update(office(), 'WorkOrderSize', childB, 'quantity = 3, version = version + 1')).toBe(1)
    expect(await run(office(), `DELETE FROM "WorkOrderSize" WHERE id = $1::uuid`, mixedB)).toBe(1)
    // A child of the mixed one is never of no customer, nor takes A's cells when it is B's.
    await expect(copyRow(office(), 'WorkOrder', mixed, { id: randomUUID(), number: tag(), splitFromId: mixed, partyId: null })).rejects.toThrow(/is made for the one customer of its order lines/)
    await expect(copyRow(office(), 'WorkOrderSize', mixedA, { id: randomUUID(), workOrderId: child, quantity: 1 })).rejects.toThrow(/of another customer than its work order's/)

    // Every cell left is A's: it takes A, once, and never another.
    await expect(update(office(), 'WorkOrder', mixed, `"partyId" = $2::uuid`, B)).rejects.toThrow(notYet)
    expect(await update(office(), 'WorkOrder', mixed, `"partyId" = $2::uuid`, A)).toBe(1)
    await expect(update(office(), 'WorkOrder', mixed, `"partyId" = $2::uuid`, B)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'WorkOrder', mixed, `"partyId" = NULL`)).rejects.toThrow(/never changes/)
    // Now an ordinary draft of A: A's cells join and change again, B's never.
    expect(await copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: mixed, size: '50' })).toBe(1)
    expect(await update(office(), 'WorkOrderSize', mixedA, 'quantity = 4')).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: mixed, size: '56' })).rejects.toThrow(/of another customer than its work order's/)
    expect(await partyOf(child)).toBe(B)

    // A draft with no cell left takes no customer either.
    const empty = randomUUID()
    await plant('WorkOrder', p.draftWorkOrderId, { id: empty, number: tag(), partyId: null })
    await expect(update(office(), 'WorkOrder', empty, `"partyId" = $2::uuid`, A)).rejects.toThrow(notYet)
  })

  it("keeps a SAMPLE with its round's customer, and one of a round for no customer with cells of none or of one customer", async () => {
    const sample = (round: string, partyId: string | null, id = randomUUID()) => copyRow(office(), 'WorkOrder', p.draftWorkOrderId, { id, number: tag(), kind: 'SAMPLE', sampleRoundId: round, partyId })
    // The PP round is A's: its samples are A's.
    const roundWords = /sample work order .* is of its sample round's customer/
    await expect(sample(s.roundIds.pp, B)).rejects.toThrow(roundWords)
    await expect(sample(s.roundIds.pp, null)).rejects.toThrow(roundWords)
    const ofA = randomUUID()
    expect(await sample(s.roundIds.pp, A, ofA)).toBe(1)
    expect(await copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: ofA, salesOrderLineId: null, partyId: null })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: ofA, size: '54' })).rejects.toThrow(/of another customer than its work order's/)
    // The CERT round is for no customer: made on no order line, its cells name none ...
    const ofNone = randomUUID()
    expect(await sample(s.roundIds.cert, null, ofNone)).toBe(1)
    expect(await copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: ofNone, salesOrderLineId: null, partyId: null })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: ofNone, size: '54' })).rejects.toThrow(/sample work order .* is of no customer: its cells name no order line/)
    // ... or, made on a customer's order lines, it is that customer's.
    const onB = randomUUID()
    expect(await sample(s.roundIds.cert, B, onB)).toBe(1)
    expect(await copyRow(office(), 'WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: onB })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: onB, size: '54' })).rejects.toThrow(/of another customer than its work order's/)
  })

  it('fills the work orders made before the rule from their cells and keeps a mixed one with none (the copy step)', async () => {
    // Made before the rule: a released one of A, a draft of B, a mixed draft, a SAMPLE of A's round without a cell, one of
    // a round for no customer without a cell.
    const released = randomUUID()
    const ofB = randomUUID()
    const mixed = randomUUID()
    const sampleA = randomUUID()
    const sampleNone = randomUUID()
    await plant('WorkOrder', p.workOrderId, { id: released, number: tag(), batchNumber: `T-BT-${released.slice(0, 8)}`, partyId: null })
    await plant('WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: released })
    await plant('WorkOrder', F.draftB, { id: ofB, number: tag(), partyId: null })
    await plant('WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: ofB })
    await plant('WorkOrder', p.draftWorkOrderId, { id: mixed, number: tag(), partyId: null })
    await plant('WorkOrderSize', F.cellA, { id: randomUUID(), workOrderId: mixed })
    await plant('WorkOrderSize', F.cellB, { id: randomUUID(), workOrderId: mixed, size: '54' })
    await plant('WorkOrder', p.draftWorkOrderId, { id: sampleA, number: tag(), kind: 'SAMPLE', sampleRoundId: s.roundIds.pp, partyId: null })
    await plant('WorkOrder', p.draftWorkOrderId, { id: sampleNone, number: tag(), kind: 'SAMPLE', sampleRoundId: s.roundIds.cert, partyId: null })

    const copy = readMigrations(MIGRATIONS_DIR).filter((migration) => migration.folder.endsWith('_production_brand_wall_copy'))
    expect(copy).toHaveLength(1)
    const notices: string[] = []
    const listen = (notice: { message?: string }) => notices.push(notice.message ?? '')
    db.admin.on('notice', listen)
    // The copy step runs before the guards folder makes its triggers: so it does here (a SAMPLE without a cell takes its
    // round's customer, which the set-once rule, about a mixed one's cells, would refuse).
    await db.admin.query('ALTER TABLE "WorkOrder" DISABLE TRIGGER "WorkOrder_party_fixed"')
    try {
      await db.admin.query(copy[0]!.sql)
      // Run again: it changes nothing (it only fills a null).
      await db.admin.query(copy[0]!.sql)
    } finally {
      await db.admin.query('ALTER TABLE "WorkOrder" ENABLE TRIGGER "WorkOrder_party_fixed"')
      db.admin.off('notice', listen)
    }
    expect(await partyOf(released)).toBe(A)
    expect(await partyOf(ofB)).toBe(B)
    expect(await partyOf(mixed)).toBeNull()
    expect(await partyOf(sampleA)).toBe(A)
    expect(await partyOf(sampleNone)).toBeNull()
    // The NOTICE counts the database's mixed ones (only the one above: the split test's took A) and names no customer.
    expect(notices.at(-1)).toMatch(/^production \(B-PR-01\): 1 work order\(s\) made before the one-customer rule mix customers and keep none/)
    // The guard is back on: the released one stays frozen.
    await expect(update(office(), 'WorkOrder', released, `"partyId" = $2::uuid`, B)).rejects.toThrow(/never change/)
  })
})

// ── B-PR-39 (production plan slice 1): the brand wall walk's seed — PW-00 mirrored in the seed ────────────────────────────────
describe('the brand wall walk seed (B-PR-39)', () => {
  it('a second customer with work orders of its own in production, an office person limited to it, its portal people; twice changes nothing', async () => {
    const made = await seedTwoBrands({ db: factory, namespace: NS })
    const second = made.second.partyId
    expect(second).not.toBe(A)
    const orders = await admin(
      `SELECT w.number, w.status::text AS status, w."partyId"::text AS party, array_agg(DISTINCT c."partyId"::text) AS cells, sum(c.quantity)::int AS pieces
         FROM "WorkOrder" w JOIN "WorkOrderSize" c ON c."workOrderId" = w.id WHERE w.id = ANY($1::uuid[]) GROUP BY w.id ORDER BY w.number`,
      [[made.workOrderIds.inProduction, made.workOrderIds.draft]],
    )
    expect(orders).toEqual([
      { number: 'SEED-WO-B001', status: 'IN_PROGRESS', party: second, cells: [second], pieces: 5 },
      { number: 'SEED-WO-B002', status: 'DRAFT', party: second, cells: [second], pieces: 1 },
    ])
    // Its style is its own label; its line is on the threads' order of the second brand.
    expect((await admin(`SELECT "brandPartyId"::text AS brand FROM "Style" WHERE id = $1`, [made.styleId]))[0]).toEqual({ brand: second })
    expect((await admin(`SELECT "orderId"::text AS "order", "partyId"::text AS party FROM "SalesOrderLine" WHERE id = $1`, [made.salesOrderLineId]))[0]).toEqual({ order: made.second.salesOrderId, party: second })
    const people = await admin(
      `SELECT u.id::text AS id, u.audience::text AS audience, u."partyId"::text AS party, r.key, a."partyIds"::text[] AS "partyIds"
         FROM "User" u JOIN "RoleAssignment" a ON a."userId" = u.id AND a."endedAt" IS NULL JOIN "Role" r ON r.id = a."roleId" WHERE u.id = ANY($1::uuid[]) ORDER BY r.key`,
      [[made.officeUserId, made.portalUserIds.buyer, made.portalUserIds.viewer, made.portalUserIds.designer, made.portalUserIds.production]],
    )
    expect(people).toEqual([
      { id: made.portalUserIds.buyer, audience: 'PARTNER', party: second, key: 'customer-buyer', partyIds: [second] },
      { id: made.portalUserIds.designer, audience: 'PARTNER', party: second, key: 'customer-designer', partyIds: [second] },
      // B-PR-15: the customer's Production person (the seeds B-PR-14 left).
      { id: made.portalUserIds.production, audience: 'PARTNER', party: second, key: 'customer-production', partyIds: [second] },
      { id: made.portalUserIds.viewer, audience: 'PARTNER', party: second, key: 'customer-viewer', partyIds: [second] },
      { id: made.officeUserId, audience: 'OFFICE', party: null, key: 'production_manager', partyIds: [second] },
    ])
    // B-PR-15: the Production role allowed too, and its share level PROGRESS (B-PR-40: the level alone); the portal still OFF.
    expect((await admin(`SELECT "portalOn", "allowedRoleKeys", "productionLevel"::text AS level FROM "PortalSettings" WHERE "partyId" = $1`, [second]))[0]).toEqual({
      portalOn: false,
      allowedRoleKeys: ['customer-buyer', 'customer-viewer', 'customer-designer', 'customer-production'],
      level: 'PROGRESS',
    })
    // Idempotent: a second run adds nothing.
    const count = async () => (await admin(`SELECT (SELECT count(*) FROM "WorkOrder") + (SELECT count(*) FROM "WorkOrderSize") + (SELECT count(*) FROM "User") + (SELECT count(*) FROM "RoleAssignment") + (SELECT count(*) FROM "SalesOrderLine") AS n`))[0]!.n
    const before = await count()
    await seedTwoBrands({ db: factory, namespace: NS })
    expect(await count()).toBe(before)
  })
})
// ── end B-PR-39 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
